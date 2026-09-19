import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	decisionBodyV3 as decisionBody,
	planBodyV3 as planBody,
	sendJevRequest,
} from "../server/jev/client.js";
import { jevConfig } from "../server/jev/config.js";
import {
	decisionRequestSchema,
	planRequestSchema,
} from "../shared/snake/schema.js";
import type {
	DecisionRequest,
	LegacyDecisionRequest,
	LegacyPlanRequest,
	ModelDecision,
	PlanRequest,
} from "../shared/snake/types.js";
import { planDirections, publicState } from "../shared/snake/types.js";
import { contextFixtures } from "../tests/context-fixture.js";

type FixtureName = keyof typeof contextFixtures;
type Mode = "single" | "plan";
type Cost = {
	samples: number;
	p50: number;
	p95: number;
	min: number;
	max: number;
};
type Case = {
	fixture: FixtureName;
	mode: Mode;
	v2: {
		request: LegacyDecisionRequest | LegacyPlanRequest;
		requestBytes: number;
		contextBuildMs: null;
		fixtureLoadMs: Cost;
	};
	v3: {
		request: DecisionRequest | PlanRequest;
		requestBytes: number;
		contextBuildMs: Cost;
	};
	byteDelta: number;
};
export type LiveResult = {
	fixture: FixtureName;
	mode: Mode;
	version: "v2" | "v3";
	startedAt: string;
	finishedAt: string;
	provider: string;
	model: string;
	request: DecisionRequest | PlanRequest;
	requestBytes: number;
	status: "ok" | "error";
	responseText: string | null;
	httpStatus: number | null;
	decision?: ModelDecision;
	error?: string;
	selectedEvidence?: {
		firstCollision: string | null;
		firstForcedCollision: boolean;
		secondCollision: string | null;
		secondForcedCollision: boolean;
		corridorAvoidedProvenDeath: boolean | null;
	};
};
export type EvaluationOptions = {
	live?: boolean;
	samples?: number;
	env?: Record<string, string | undefined>;
	fetch?: typeof fetch;
	onLiveResult?: (result: LiveResult) => void | Promise<void>;
};
function stats(values: number[]): Cost {
	const sorted = [...values].sort((a, b) => a - b);
	return {
		samples: values.length,
		p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
		p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
		min: sorted[0],
		max: sorted.at(-1) as number,
	};
}
function measure<T>(
	build: () => T,
	samples: number,
): { request: T; contextBuildMs: Cost } {
	const values: number[] = [];
	let request = build();
	for (let i = 0; i < samples; i++) {
		const started = performance.now();
		request = build();
		values.push(performance.now() - started);
	}
	return { request, contextBuildMs: stats(values) };
}
const bytes = (request: unknown) =>
	Buffer.byteLength(JSON.stringify(request), "utf8");
function selectedEvidence(
	request: DecisionRequest | PlanRequest,
	decision: ModelDecision,
	fixture: FixtureName,
): LiveResult["selectedEvidence"] {
	if (
		request.state.contextVersion !== "action-facts-v3" &&
		request.state.contextVersion !== "two-step-plan-v3"
	)
		return undefined;
	if (
		"direction" in request.questions &&
		request.state.contextVersion === "action-facts-v3" &&
		decision.kind !== "plan"
	) {
		const facts = request.questions.direction.criteria[decision.choice];
		if (typeof facts === "string" || !("appleRoute" in facts))
			throw new Error("Expected v3 action facts");
		const danger =
			facts.immediateCollision !== null ||
			facts.forcedPath?.outcome === "forced_collision";
		return {
			firstCollision: facts.immediateCollision,
			firstForcedCollision: facts.forcedPath?.outcome === "forced_collision",
			secondCollision: null,
			secondForcedCollision: false,
			corridorAvoidedProvenDeath: fixture === "corridor" ? !danger : null,
		};
	}
	if (
		request.state.contextVersion === "two-step-plan-v3" &&
		"plan" in request.questions &&
		decision.kind === "plan"
	) {
		const [first] = planDirections(decision.choice);
		const firstFacts = request.state.firstActions[first];
		const pair = request.questions.plan.criteria[decision.choice];
		if (typeof pair === "string") throw new Error("Expected v3 pair facts");
		const second = pair.secondFacts;
		const secondForced =
			pair.secondStatus === "known" &&
			pair.secondFacts.forcedPath?.outcome === "forced_collision";
		const danger =
			firstFacts.immediateCollision !== null ||
			firstFacts.forcedPath?.outcome === "forced_collision" ||
			!!second?.immediateCollision ||
			secondForced;
		return {
			firstCollision: firstFacts.immediateCollision,
			firstForcedCollision:
				firstFacts.forcedPath?.outcome === "forced_collision",
			secondCollision: second?.immediateCollision ?? null,
			secondForcedCollision: secondForced,
			corridorAvoidedProvenDeath: fixture === "corridor" ? !danger : null,
		};
	}
	throw new Error("Decision mode differs from evaluation request");
}
export async function evaluateContext(options: EvaluationOptions = {}) {
	const samples = options.samples ?? 30;
	if (!Number.isInteger(samples) || samples < 1)
		throw new Error("samples must be a positive integer");
	const config = jevConfig(options.env);
	if (options.live && !config.apiKey)
		throw new Error(`Set ${config.keyEnv} before --live evaluation`);
	const raw = JSON.parse(
		await readFile(
			new URL("../tests/fixtures/context-v2.json", import.meta.url),
			"utf8",
		),
	) as Record<FixtureName, { single: unknown; plan: unknown }>;
	const cases: Case[] = [];
	const responseCosts: {
		fixture: FixtureName;
		requestBytes: number;
		contextBuildMs: Cost;
		request: DecisionRequest;
	}[] = [];
	for (const fixture of Object.keys(contextFixtures) as FixtureName[]) {
		const state = publicState(contextFixtures[fixture]());
		for (const mode of ["single", "plan"] as const) {
			const source =
				mode === "single"
					? decisionRequestSchema.parse(raw[fixture][mode])
					: planRequestSchema.parse(raw[fixture][mode]);
			const baseline = JSON.stringify({ ...source, model: config.model });
			const loaded = measure(
				() => JSON.parse(baseline) as LegacyDecisionRequest | LegacyPlanRequest,
				samples,
			);
			const built = measure(
				() =>
					mode === "single"
						? decisionBody(state, config.model)
						: planBody(state, config.model),
				samples,
			);
			(mode === "single" ? decisionRequestSchema : planRequestSchema).parse(
				built.request,
			);
			const v2Bytes = bytes(loaded.request),
				v3Bytes = bytes(built.request);
			cases.push({
				fixture,
				mode,
				v2: {
					request: loaded.request,
					requestBytes: v2Bytes,
					contextBuildMs: null,
					fixtureLoadMs: loaded.contextBuildMs,
				},
				v3: { ...built, requestBytes: v3Bytes },
				byteDelta: v3Bytes - v2Bytes,
			});
		}
		const response = structuredClone(state);
		response.config = {
			...response.config,
			stepMode: "response",
			decisionMode: "single_step",
			tickIntervalMs: null,
		};
		const built = measure(
			() =>
				decisionBody(response, config.model, {
					elapsedGameTimeMs: response.gameTimeMs,
					deadlineInMs: null,
				}),
			samples,
		);
		decisionRequestSchema.parse(built.request);
		responseCosts.push({
			fixture,
			...built,
			requestBytes: bytes(built.request),
		});
	}
	const live: LiveResult[] = [];
	if (options.live) {
		// Deliberately serial: same fixtures, no game submission, retries, or substitution.
		for (const entry of cases)
			for (const version of ["v2", "v3"] as const) {
				const request = entry[version].request;
				const result: LiveResult = {
					fixture: entry.fixture,
					mode: entry.mode,
					version,
					startedAt: new Date().toISOString(),
					finishedAt: "",
					provider: config.provider,
					model: config.model,
					request,
					requestBytes: bytes(request),
					status: "error",
					responseText: null,
					httpStatus: null,
				};
				const transport: typeof fetch = async (input, init) => {
					const response = await (options.fetch ?? fetch)(input, init);
					result.httpStatus = response.status;
					result.responseText = (await response.clone().text()).replaceAll(
						config.apiKey,
						"[redacted]",
					);
					return response;
				};
				try {
					const output =
						entry.mode === "single"
							? await sendJevRequest(
									config.apiKey,
									request as DecisionRequest,
									"direction",
									{ provider: config.provider, fetch: transport },
								)
							: await sendJevRequest(
									config.apiKey,
									request as PlanRequest,
									"plan",
									{ provider: config.provider, fetch: transport },
								);
					result.decision = output.decision;
					// Compare both context versions against the same deterministic v3 evidence.
					result.selectedEvidence = selectedEvidence(
						entry.v3.request,
						output.decision,
						entry.fixture,
					);
					result.status = "ok";
				} catch (error) {
					result.error = (
						error instanceof Error ? error.message : String(error)
					).replaceAll(config.apiKey, "[redacted]");
				}
				result.finishedAt = new Date().toISOString();
				live.push(result);
				await options.onLiveResult?.(result);
			}
	}
	return {
		reportVersion: 1,
		createdAt: new Date().toISOString(),
		mode: options.live ? "live_fixture_comparison" : "offline",
		provider: config.provider,
		model: config.model,
		sampleCount: samples,
		measurement:
			"v3 contextBuildMs measures geometry plus request construction; one untimed warmup per case. v2 contextBuildMs was not instrumented: null, not zero; fixtureLoadMs only measures JSON loading. Percentiles use nearest rank. Body sizes are UTF-8 JSON bytes.",
		baseline:
			"tests/fixtures/context-v2.json; only model is replaced by the configured model for a matched provider comparison. No recorded body is submitted to a game.",
		cases,
		responseCosts,
		deadlineComparison: {
			fixedDeadlineMs: 500,
			worstV3BuildP95Ms: Math.max(...cases.map((c) => c.v3.contextBuildMs.p95)),
			note: "Context building consumes part of the deadline; provider latency and network costs are separate and can still make a request late.",
		},
		live: {
			enabled: !!options.live,
			plannedRequests: options.live ? 12 : 0,
			completedRequests: live.length,
			failedRequests: live.filter((r) => r.status === "error").length,
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
	const out = resolve(
		values.out ??
			`.data/qa/context-v3/${values.live ? "live" : "offline"}.json`,
	);
	const report = await evaluateContext({
		live: values.live,
		samples: values.samples === undefined ? undefined : Number(values.samples),
	});
	await mkdir(dirname(out), { recursive: true });
	await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
	console.log(
		JSON.stringify({
			report: out,
			mode: report.mode,
			samples: report.sampleCount,
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
