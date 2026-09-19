import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	buildDecisionContext,
	sendJevRequest,
	type DecisionTiming,
} from "../server/jev/client.js";
import { jevConfig } from "../server/jev/config.js";
import type { SurvivalOutcome } from "../shared/snake/action-outcomes.js";
import type { DecisionRequestV5 } from "../shared/snake/outcome-context.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import {
	type Decision,
	type DecisionProgress,
	type Direction,
	type PublicState,
	directions,
} from "../shared/snake/types.js";
import type { DecisionRequestV4 } from "../shared/snake/witness-context.js";
import fixtureData from "../tests/fixtures/outcome-input-regressions.json" with { type: "json" };

type RegressionFixture = {
	id: string;
	source: {
		kind: "historical_request" | "reconstructed_v4" | "synthetic_control";
		description: string;
		requestSha256: string;
		matchId?: string;
		observedSeq?: number;
		requestSeq?: number;
		tick?: number;
	};
	observation: Omit<PublicState, "lastDecision" | "lastAppliedAction">;
	timing: DecisionTiming;
	progress: DecisionProgress | null;
	recordedRequest: DecisionRequestV4;
	historicalDecision: {
		choice: Direction;
		probabilities: Record<Direction, number>;
		model: string;
		inputTokens: number;
	} | null;
};
export type OutcomeLiveResult = {
	fixture: string;
	repeat: number;
	version: "v4" | "v5";
	startedAt: string;
	finishedAt: string;
	provider: string;
	requestedModel: string;
	resolvedModel: string | null;
	request: DecisionRequestV4 | DecisionRequestV5;
	requestBytes: number;
	contextBuildMs: number | null;
	requestMs: number;
	status: "ok" | "error";
	httpStatus: number | null;
	responseText: string | null;
	response: unknown;
	responseParseError: string | null;
	providerUsage: unknown;
	inputTokens: number | null;
	rawChoice: unknown;
	probabilities: unknown;
	choiceProbability: number | null;
	// Compared against current v5 geometric facts, identically for both inputs.
	selectedSurvivalStatus: SurvivalOutcome["status"] | null;
	knownBadChoice:
		| "illegal_reverse"
		| "immediate_collision"
		| "proven_fatal"
		| null;
	decision?: Decision;
	error?: string;
};
export type OutcomeEvaluationOptions = {
	live?: boolean;
	repeats?: number;
	env?: Record<string, string | undefined>;
	fetch?: typeof fetch;
	onLiveResult?: (result: OutcomeLiveResult) => void | Promise<void>;
};
const bytes = (value: unknown) =>
	Buffer.byteLength(JSON.stringify(value), "utf8");
const object = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

function captureResponseFacts(
	result: OutcomeLiveResult,
	current: DecisionRequestV5,
) {
	const response = object(result.response);
	const answer = object(object(response?.answers)?.direction);
	const usage = object(response?.usage);
	result.resolvedModel =
		typeof response?.model === "string" ? response.model : null;
	result.providerUsage = response?.usage ?? null;
	result.inputTokens =
		typeof usage?.input_tokens === "number" ? usage.input_tokens : null;
	result.rawChoice = answer?.choice ?? null;
	result.probabilities = answer?.probabilities ?? null;
	const probabilities = object(result.probabilities);
	if (
		typeof result.rawChoice === "string" &&
		directions.includes(result.rawChoice as Direction)
	) {
		const direction = result.rawChoice as Direction;
		result.choiceProbability =
			typeof probabilities?.[direction] === "number"
				? probabilities[direction]
				: null;
		const status =
			current.questions.direction.criteria[direction].survival.status;
		result.selectedSurvivalStatus = status;
		result.knownBadChoice =
			status === "illegal_reverse" ||
			status === "immediate_collision" ||
			status === "proven_fatal"
				? status
				: null;
	}
}

/** Offline by default. No environment-file loading, networking or game submission. */
export async function evaluateOutcomeContext(
	options: OutcomeEvaluationOptions = {},
) {
	const repeats = options.repeats ?? 3;
	if (!Number.isInteger(repeats) || repeats < 1)
		throw new Error("repeats must be a positive integer");
	const config = jevConfig(options.env);
	if (options.live && !config.apiKey)
		throw new Error(`Set ${config.keyEnv} before --live evaluation`);
	const fixtures = fixtureData.cases as unknown as RegressionFixture[];
	const cases = fixtures.map((fixture) => {
		const recordedRequest = structuredClone(fixture.recordedRequest);
		const digest = createHash("sha256")
			.update(JSON.stringify(recordedRequest))
			.digest("hex");
		if (digest !== fixture.source.requestSha256)
			throw new Error(`Frozen request hash mismatch: ${fixture.id}`);
		decisionRequestSchema.parse(recordedRequest); // Validate without rewriting the stored request.
		const state: PublicState = {
			...structuredClone(fixture.observation),
			lastDecision: null,
		};
		const started = performance.now();
		const built = buildDecisionContext(
			state,
			config.model,
			fixture.timing,
			fixture.progress ?? undefined,
		);
		const contextBuildMs = performance.now() - started;
		decisionRequestSchema.parse(built.request);
		const baseline = { ...recordedRequest, model: config.model };
		return {
			fixture: fixture.id,
			source: fixture.source,
			observation: fixture.observation,
			timing: fixture.timing,
			progress: fixture.progress,
			historicalDecision: fixture.historicalDecision,
			v4: {
				recordedRequest,
				request: baseline,
				requestBytes: bytes(baseline),
				contextBuildMs: null,
			},
			v5: {
				request: built.request,
				requestBytes: bytes(built.request),
				contextBuildMs,
			},
		};
	});
	const live: OutcomeLiveResult[] = [];
	if (options.live) {
		const redact = (text: string) =>
			text.replaceAll(config.apiKey, "[redacted]");
		for (const entry of cases) {
			for (let repeat = 1; repeat <= repeats; repeat++) {
				const order =
					repeat % 2 === 1 ? (["v4", "v5"] as const) : (["v5", "v4"] as const);
				for (const version of order) {
					const input = entry[version];
					const result: OutcomeLiveResult = {
						fixture: entry.fixture,
						repeat,
						version,
						startedAt: new Date().toISOString(),
						finishedAt: "",
						provider: config.provider,
						requestedModel: config.model,
						resolvedModel: null,
						request: input.request,
						requestBytes: input.requestBytes,
						contextBuildMs: input.contextBuildMs,
						requestMs: 0,
						status: "error",
						httpStatus: null,
						responseText: null,
						response: null,
						responseParseError: null,
						providerUsage: null,
						inputTokens: null,
						rawChoice: null,
						probabilities: null,
						choiceProbability: null,
						selectedSurvivalStatus: null,
						knownBadChoice: null,
					};
					const transport: typeof fetch = async (url, init) => {
						const response = await (options.fetch ?? fetch)(url, init);
						result.httpStatus = response.status;
						result.responseText = redact(await response.clone().text());
						try {
							result.response = JSON.parse(result.responseText);
							captureResponseFacts(result, entry.v5.request);
						} catch (error) {
							result.responseParseError = redact(
								error instanceof Error ? error.message : String(error),
							);
						}
						return response;
					};
					const started = performance.now();
					try {
						const output = await sendJevRequest(config.apiKey, input.request, {
							provider: config.provider,
							fetch: transport,
							...(input.contextBuildMs === null
								? {}
								: { contextBuildMs: input.contextBuildMs }),
						});
						result.decision = JSON.parse(
							redact(JSON.stringify(output.decision)),
						) as Decision;
						result.status = "ok";
					} catch (error) {
						result.error = redact(
							error instanceof Error ? error.message : String(error),
						);
					}
					result.requestMs = performance.now() - started;
					result.finishedAt = new Date().toISOString();
					live.push(result);
					await options.onLiveResult?.(result);
				}
			}
		}
	}
	return {
		reportVersion: "outcome-context-v1",
		createdAt: new Date().toISOString(),
		mode: options.live ? "live_fixture_comparison" : "offline",
		provider: config.provider,
		model: config.model,
		repeats,
		measurement:
			"v4 inputs are frozen fixtures, including original recorded witnessContinuity where available. Only model is replaced to control the model variable; recordedRequest is retained unchanged. v4 contextBuildMs is unknown (null), not a measured reconstruction time. v5 contextBuildMs is one real production build from that observation, timing and committed progress. Bytes are UTF-8 JSON. Missing provider usage is unknown, not zero.",
		interpretation:
			"Each pair alternates request order across repetitions; all responses and errors are retained, without retries or game submissions. Both versions' choices are compared with the same current v5 survival facts. illegal_reverse is rejection, not death. not_proven_fatal means unresolved, not safe. Fixed observations do not measure complete-game win rate.",
		cases,
		live: {
			enabled: !!options.live,
			plannedRequests: options.live ? cases.length * 2 * repeats : 0,
			completedRequests: live.length,
			failedRequests: live.filter((result) => result.status === "error").length,
			knownBadChoices: {
				illegal_reverse: live.filter(
					(result) => result.knownBadChoice === "illegal_reverse",
				).length,
				immediate_collision: live.filter(
					(result) => result.knownBadChoice === "immediate_collision",
				).length,
				proven_fatal: live.filter(
					(result) => result.knownBadChoice === "proven_fatal",
				).length,
			},
			results: live,
		},
	};
}

async function main() {
	const { values } = parseArgs({
		options: {
			live: { type: "boolean", default: false },
			repeats: { type: "string" },
			out: { type: "string" },
		},
	});
	if (values.live) await import("dotenv/config");
	const out = resolve(
		values.out ??
			`.data/qa/context-v5/${values.live ? "live" : "offline"}.json`,
	);
	await mkdir(dirname(out), { recursive: true });
	const journal = `${out}.jsonl`;
	if (values.live) await writeFile(journal, "");
	const report = await evaluateOutcomeContext({
		live: values.live,
		repeats: values.repeats === undefined ? undefined : Number(values.repeats),
		onLiveResult: async (result) => {
			await appendFile(journal, `${JSON.stringify(result)}\n`);
		},
	});
	await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
	console.log(
		JSON.stringify({
			report: out,
			mode: report.mode,
			cases: report.cases.length,
			liveRequests: report.live.completedRequests,
			errors: report.live.failedRequests,
		}),
	);
	if (report.live.failedRequests) process.exitCode = 1;
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	await main();
