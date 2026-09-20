import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	buildDecisionContextV4 as buildDecisionContext,
	decisionBodyV3,
} from "../server/jev/analysis-context.js";
import { sendJevRequest } from "../server/jev/client.js";
import { jevConfig } from "../server/jev/config.js";
import type { PositiveEvidence } from "../shared/snake/positive-evidence.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import {
	type Decision,
	type DecisionProgress,
	type DecisionRequest,
	type Direction,
	type MatchState,
	directions,
	publicState,
} from "../shared/snake/types.js";
import { baseState, contextFixtures } from "../tests/context-fixture.js";
import releaseReplay from "../tests/fixtures/positive-release-replay.json" with { type: "json" };

export type PositiveFixtureName =
	| keyof typeof contextFixtures
	| "release_trap_529dd";
type Measurements = {
	samples: number;
	p50: number;
	p95: number;
	min: number;
	max: number;
	last: number;
};
export type PositiveLiveResult = {
	fixture: PositiveFixtureName;
	version: "v3" | "v4";
	startedAt: string;
	finishedAt: string;
	provider: string;
	model: string;
	request: DecisionRequest;
	requestBytes: number;
	status: "ok" | "error";
	httpStatus: number | null;
	responseText: string | null;
	providerUsage: unknown;
	decision?: Decision;
	error?: string;
};
export type PositiveEvaluationOptions = {
	live?: boolean;
	samples?: number;
	env?: Record<string, string | undefined>;
	fetch?: typeof fetch;
	// Must describe actual committed history for this exact fixture/tick.
	progressByFixture?: Partial<Record<PositiveFixtureName, DecisionProgress>>;
	onLiveResult?: (result: PositiveLiveResult) => void | Promise<void>;
};

const bytes = (value: unknown) =>
	Buffer.byteLength(JSON.stringify(value), "utf8");
function measure<T>(build: () => T, samples: number) {
	const times: number[] = [];
	let value = build(); // One explicit untimed warmup, never a model request.
	for (let index = 0; index < samples; index++) {
		const started = performance.now();
		value = build();
		times.push(performance.now() - started);
	}
	const sorted = [...times].sort((a, b) => a - b);
	const contextBuildMs: Measurements = {
		samples,
		p50: sorted[Math.ceil(samples * 0.5) - 1],
		p95: sorted[Math.ceil(samples * 0.95) - 1],
		min: sorted[0],
		max: sorted[samples - 1],
		last: times[samples - 1],
	};
	return { value, contextBuildMs };
}

function witnessMetrics(
	evidence: Extract<PositiveEvidence, { witness: unknown }>,
) {
	const witness = evidence.witness;
	return {
		status: evidence.status,
		moves:
			"directions" in witness
				? witness.directions.length
				: witness.prefixDirections.length + witness.cycleDirections.length,
		cycle:
			"cycleDirections" in witness
				? {
						prefixMoves: witness.prefixDirections.length,
						period: witness.cycleDirections.length,
					}
				: null,
		releasePassages: witness.releasePassages,
	};
}

/** Default is geometry/request evaluation only. --live is an explicit opt-in. */
export async function evaluatePositiveContext(
	options: PositiveEvaluationOptions = {},
) {
	const samples = options.samples ?? 10;
	if (!Number.isInteger(samples) || samples < 1)
		throw new Error("samples must be a positive integer");
	const config = jevConfig(options.env);
	if (options.live && !config.apiKey)
		throw new Error(`Set ${config.keyEnv} before --live evaluation`);
	const releaseState = Object.assign(
		baseState(),
		structuredClone(releaseReplay.geometry),
		{
			id: releaseReplay.source.matchId,
			tick: releaseReplay.source.tick,
			seq: releaseReplay.source.seq,
		},
	) as MatchState;
	const fixtures: {
		name: PositiveFixtureName;
		state: MatchState;
		source: string;
	}[] = [
		...Object.entries(contextFixtures).map(([name, factory]) => ({
			name: name as keyof typeof contextFixtures,
			state: factory(),
			source:
				"tests/context-fixture.ts; test metadata, not a historical model request",
		})),
		{
			name: "release_trap_529dd",
			state: releaseState,
			source: `Recorded geometry only: match ${releaseReplay.source.matchId}, seq ${releaseReplay.source.seq}, tick ${releaseReplay.source.tick}. Other metadata is from baseState; this is not a reproduction of the original provider input.`,
		},
	];
	const cases = fixtures.map(({ name, state: fullState, source }) => {
		const state = publicState(fullState);
		state.config = {
			...state.config,
			stepMode: "response",
			decisionMode: "single_step",
			tickIntervalMs: null,
		};
		const progress = options.progressByFixture?.[name];
		const v3 = measure(
			() => decisionBodyV3(state, config.model, undefined, progress),
			samples,
		);
		const v4 = measure(
			() => buildDecisionContext(state, config.model, undefined, progress),
			samples,
		);
		decisionRequestSchema.parse(v3.value);
		decisionRequestSchema.parse(v4.value.request);
		const requestBytesV3 = bytes(v3.value);
		const requestBytesV4 = bytes(v4.value.request);
		const comparisons = Object.fromEntries(
			directions.map((direction) => {
				const oldFacts = v3.value.questions.direction.criteria[direction];
				const facts = v4.value.request.questions.direction.criteria[direction];
				const id = facts.opportunity.witnessId;
				const record = id === null ? null : v4.value.evidence.records[id];
				if (id !== null && !record) throw new Error(`Missing witness ${id}`);
				return [
					direction,
					{
						v3: {
							danger: oldFacts.danger,
							appleRouteStatus: oldFacts.appleRoute.status,
							opportunity: null,
						},
						v4: {
							danger: facts.danger,
							appleRouteStatus: facts.appleRoute.status,
							opportunity: facts.opportunity,
						},
						witness: record ? witnessMetrics(record.evidence) : null,
					},
				];
			}),
		) as Record<
			Direction,
			{
				v3: {
					danger: typeof v3.value.questions.direction.criteria.up.danger;
					appleRouteStatus: string;
					opportunity: null;
				};
				v4: {
					danger: typeof v4.value.request.questions.direction.criteria.up.danger;
					appleRouteStatus: string;
					opportunity: typeof v4.value.request.questions.direction.criteria.up.opportunity;
				};
				witness: ReturnType<typeof witnessMetrics> | null;
			}
		>;
		return {
			fixture: name,
			source,
			observation: state,
			progress: progress
				? { status: "provided" as const, value: progress }
				: { status: "not_provided" as const, value: null },
			v3: {
				request: v3.value,
				requestBytes: requestBytesV3,
				contextBuildMs: v3.contextBuildMs,
			},
			v4: {
				request: v4.value.request,
				requestBytes: requestBytesV4,
				contextBuildMs: v4.contextBuildMs,
				evidence: v4.value.evidence,
				evidenceBytes: bytes(v4.value.evidence),
			},
			byteDelta: requestBytesV4 - requestBytesV3,
			comparisons,
		};
	});
	const live: PositiveLiveResult[] = [];
	if (options.live) {
		// One call per version per fixture, serially. No retries or game submission.
		for (const entry of cases)
			for (const version of ["v3", "v4"] as const) {
				const input = entry[version];
				const result: PositiveLiveResult = {
					fixture: entry.fixture,
					version,
					startedAt: new Date().toISOString(),
					finishedAt: "",
					provider: config.provider,
					model: config.model,
					request: input.request,
					requestBytes: input.requestBytes,
					status: "error",
					httpStatus: null,
					responseText: null,
					providerUsage: null,
				};
				const redact = (text: string) =>
					text.replaceAll(config.apiKey, "[redacted]");
				const transport: typeof fetch = async (url, init) => {
					const response = await (options.fetch ?? fetch)(url, init);
					result.httpStatus = response.status;
					result.responseText = redact(await response.clone().text());
					return response;
				};
				try {
					const output = await sendJevRequest(config.apiKey, input.request, {
						provider: config.provider,
						fetch: transport,
						contextBuildMs: input.contextBuildMs.last,
					});
					result.decision = output.decision;
					if (
						output.response !== null &&
						typeof output.response === "object" &&
						"usage" in output.response
					)
						result.providerUsage = JSON.parse(
							redact(JSON.stringify(output.response.usage)),
						);
					result.status = "ok";
				} catch (error) {
					result.error = redact(
						error instanceof Error ? error.message : String(error),
					);
				}
				result.finishedAt = new Date().toISOString();
				live.push(result);
				await options.onLiveResult?.(result);
			}
	}
	return {
		reportVersion: "positive-context-v1",
		createdAt: new Date().toISOString(),
		mode: options.live ? "live_fixture_comparison" : "offline",
		provider: config.provider,
		model: config.model,
		sampleCount: samples,
		measurement:
			"Both versions are built from the same fixture and supplied history. One untimed warmup, then measured construction samples; nearest-rank percentiles. Request bytes are exact UTF-8 JSON, excluding local witness archives. Offline samples do not call the provider. Provider usage/cost is preserved only when actually returned; missing values are unknown, not zero.",
		interpretation:
			"Geometry witnesses show executable possibilities, not model decisions or a win-rate estimate. A cycle is not proof that the apple is unreachable. Live fixture comparisons ask each version once and do not measure complete-game survival. Missing progress is explicitly not_provided; no historical movement is invented.",
		cases,
		live: {
			enabled: !!options.live,
			plannedRequests: options.live ? cases.length * 2 : 0,
			completedRequests: live.length,
			failedRequests: live.filter((result) => result.status === "error").length,
			results: live,
		},
	};
}

async function main() {
	const { values } = parseArgs({
		options: {
			live: { type: "boolean", default: false },
			samples: { type: "string" },
			out: { type: "string" },
		},
	});
	// Merely importing the evaluator or running offline does not read .env.
	if (values.live) await import("dotenv/config");
	const report = await evaluatePositiveContext({
		live: values.live,
		samples: values.samples === undefined ? undefined : Number(values.samples),
	});
	const out = resolve(
		values.out ??
			`.data/qa/context-v4/${values.live ? "live" : "offline"}.json`,
	);
	await mkdir(dirname(out), { recursive: true });
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
