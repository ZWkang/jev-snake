import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
	type Decision,
	type DecisionContext,
	type DecisionProgress,
	type DecisionRequest,
	type DecisionRequestV3,
	directions,
	type JevProvider,
	type PublicState,
} from "../../shared/snake/types.js";
import type {
	DecisionRequestV4,
	WitnessArchive,
} from "../../shared/snake/witness-context.js";
import { createDeathAnalyzer } from "./branch-death.js";
import { JEV_PROVIDERS } from "./config.js";
import { analyzeActions } from "./context-v3.js";
import { trapInstructions } from "./trap-evidence.js";
import { opportunityFacts, witnessContinuity } from "./witness-context.js";

const answerSchema = z.object({
	model: z.string().min(1),
	answers: z.object({
		direction: z.object({
			type: z.literal("choice"),
			choice: z.enum(directions),
			probabilities: z.record(z.enum(directions), z.number().min(0).max(1)),
			confidence: z.number().min(0).max(1),
		}),
	}),
	usage: z
		.object({ input_tokens: z.number().nonnegative().optional() })
		.optional(),
});
export const JEV_MODEL = JEV_PROVIDERS.typesafe.model;
export const JEV_ENDPOINT = JEV_PROVIDERS.typesafe.endpoint;
export type DecisionTiming = Pick<
	DecisionContext,
	"elapsedGameTimeMs" | "deadlineInMs"
>;
export const decisionObjective =
	"Play to complete the board by growing the snake, collecting rewards along the way. Decide your strategy from the observed position, candidate consequences and recorded history.";
const factsSemantics =
	"danger=immediate_collision marks an immediately blocked move; danger=proven_fatal marks a forced collision, a proven trapped region, a fork whose every legal exit has a death certificate, or unavoidable post-apple death even with no further growth; danger=null means neither is proven, not guaranteed safety. branch stops at a choice, cycle repeats the full body and direction, unknown_after_apple stops at unknown new food when a next move exists. Frozen space blocks body including tail; tailConnection only opens the tail endpoint. Routes are one static shortest candidate, then dynamically verified, not an exhaustive strategy; no_static_path does not prove that a route with a moving body is impossible. Distances and forcedPath.steps include the analyzed move (and a fatal attempt); postEat describes only that candidate's growth. Star arrival is conditional on schedule; response timing is unknown.";
export function progressInstructions(progress?: DecisionProgress): string {
	if (!progress) return "";
	return " state.progress records committed movement, not a forecast. It counts visits to this full body, heading and food configuration since the last apple. actions counts actual departures and how often each was followed by returning here without an apple; rejected or merely proposed actions do not count. A historical return describes what happened, not which direction to choose or whether an alternative is safe.";
}
export function contextState(
	state: PublicState,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): DecisionRequestV3["state"] {
	if (progress && progress.throughTick !== state.tick)
		throw new Error("Progress must describe the actual observed tick");
	if (state.config.stepMode !== "response" && timing?.deadlineInMs === null)
		throw new Error("A fixed decision requires a numeric deadline");
	return {
		contextVersion: "action-facts-v3",
		...(progress ? { progress } : {}),
		rules: {
			objective:
				state.config.stepMode === "response"
					? "Eat apples and stars while staying alive. The snake waits for your response, then moves exactly one cell. No direct reversal. Coordinates: x increases right, y increases down."
					: "Eat apples and stars while staying alive. The snake keeps moving. No direct reversal. Coordinates: x increases right, y increases down.",
			applePoints: 10,
			starPoints: 30,
			factsSemantics,
		},
		board: {
			width: state.config.width,
			height: state.config.height,
			obstacleCount: state.obstacles.length,
		},
		player: {
			head: state.snake[0],
			direction: state.direction,
			length: state.snake.length,
			score: state.score,
		},
		food: { apple: state.apple, star: state.star },
		timing: {
			stateIsProjected: false,
			observedTick: state.tick,
			targetTick: state.tick + 1,
			gameTimeMs: timing?.elapsedGameTimeMs ?? state.gameTimeMs,
			...(state.config.stepMode === "response"
				? {
						stepMode: "response" as const,
						tickIntervalMs: null,
						deadlineInMs: null,
					}
				: {
						stepMode: "fixed" as const,
						tickIntervalMs: state.config.tickIntervalMs,
						...(typeof timing?.deadlineInMs === "number"
							? { deadlineInMs: timing.deadlineInMs }
							: {}),
					}),
		},
	};
}
export function decisionBodyV3(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): DecisionRequestV3 {
	const analyzer = createDeathAnalyzer();
	const facts = analyzeActions(state, timing, 0, analyzer);
	return {
		model,
		state: contextState(state, timing, progress),
		questions: {
			direction: {
				type: "choice",
				instructions:
					"Choose one absolute direction for the immediately upcoming move. " +
					decisionObjective +
					trapInstructions(state, false, analyzer) +
					progressInstructions(progress) +
					" Return your own choice from the four options.",
				criteria: {
					up: { meaning: "Move one cell toward y-1.", ...facts.up },
					right: { meaning: "Move one cell toward x+1.", ...facts.right },
					down: { meaning: "Move one cell toward y+1.", ...facts.down },
					left: { meaning: "Move one cell toward x-1.", ...facts.left },
				},
			},
		},
	};
}
export const positiveSemantics =
	"opportunity is an existence witness, not a recommendation or survival probability. Its moves include the candidate. Apple witnesses stop at the known apple; the respawn is unknown. A cycle restores the ordered body and heading without growth and does not prove that the apple is unreachable. Release passages were replayed against the moving body. witnessContinuity describes matching actual geometry, not a model commitment or an instruction to follow it.";
const positiveObjective =
	"Choose the next direction to work toward completing the board. Decide your strategy using the current action consequences, verified opportunities, their assumptions and the recorded movement history. The evidence describes what is known and what remains unresolved. Choose one of the four directions.";

export function buildDecisionContext(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): { request: DecisionRequestV4; evidence: WitnessArchive } {
	const base = decisionBodyV3(state, model, timing, progress);
	const evidence: WitnessArchive = {
		version: "positive-v1",
		observedTick: state.tick,
		records: {},
	};
	const opportunities = opportunityFacts(state, evidence);
	const criteria = Object.fromEntries(
		directions.map((d) => [
			d,
			{
				...base.questions.direction.criteria[d],
				opportunity: opportunities[d],
			},
		]),
	) as DecisionRequestV4["questions"]["direction"]["criteria"];
	return {
		evidence,
		request: {
			model,
			state: {
				...base.state,
				contextVersion: "action-facts-v4",
				rules: {
					...base.state.rules,
					factsSemantics:
						base.state.rules.factsSemantics + " " + positiveSemantics,
				},
				witnessContinuity: witnessContinuity(state),
			},
			questions: {
				direction: {
					type: "choice",
					instructions: positiveObjective + progressInstructions(progress),
					criteria,
				},
			},
		},
	};
}
export function decisionBody(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): DecisionRequestV4 {
	return buildDecisionContext(state, model, timing, progress).request;
}
type JevOptions = {
	fetch?: typeof fetch;
	signal?: AbortSignal;
	provider?: JevProvider;
	model?: string;
	timing?: DecisionTiming;
	progress?: DecisionProgress;
};
export function askJev(
	apiKey: string,
	state: PublicState,
	options: JevOptions = {},
): Promise<Decision> {
	const started = performance.now();
	const { request, evidence } = buildDecisionContext(
		state,
		options.model ?? JEV_PROVIDERS[options.provider ?? "typesafe"].model,
		options.timing,
		options.progress,
	);
	const contextBuildMs = performance.now() - started;
	return sendJevRequest(apiKey, request, {
		...options,
		evidence,
		contextBuildMs,
	}).then((result) => result.decision);
}
// Evaluation shares the single-step transport; plan bodies are offline-only.
export async function sendJevRequest(
	apiKey: string,
	request: DecisionRequest,
	options: Pick<JevOptions, "fetch" | "signal" | "provider"> & {
		contextBuildMs?: number;
		evidence?: WitnessArchive;
	} = {},
): Promise<{
	decision: Decision;
	response: unknown;
}> {
	const schema = answerSchema;
	const provider = options.provider ?? "typesafe";
	const config = JEV_PROVIDERS[provider];
	if (!apiKey)
		throw new Error(
			`${config.keyEnv} is required; no simulated model is available`,
		);
	const archivedEvidence = options.evidence
		? structuredClone(options.evidence)
		: undefined;
	const body = JSON.stringify(request);
	// Save the exact JSON representation used by HTTP, with no later enrichment.
	request = JSON.parse(body);
	const requestBytes = Buffer.byteLength(body, "utf8");
	const started = performance.now();
	const response = await (options.fetch ?? fetch)(config.endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body,
		signal: options.signal,
	});
	if (!response.ok)
		throw new Error(
			provider +
				" API returned HTTP " +
				response.status +
				": " +
				(await response.text()).replaceAll(apiKey, "[redacted]"),
		);
	const rawResponse: unknown = await response.json();
	const parsed = schema.safeParse(rawResponse);
	if (!parsed.success)
		throw new Error(`Invalid JEV decision response: ${parsed.error.message}`);
	const answer = parsed.data.answers.direction;
	const sum = Object.values(answer.probabilities).reduce((a, b) => a + b, 0);
	if (Math.abs(sum - 1) > 0.001)
		console.warn(
			JSON.stringify({
				type: "model_response_warning",
				code: "probabilities_not_normalized",
				provider,
				model: parsed.data.model,
				total: sum,
				probabilities: answer.probabilities,
				choice: answer.choice,
			}),
		);
	return {
		response: rawResponse,
		decision: {
			provider,
			model: parsed.data.model,
			choice: answer.choice,
			probabilities: answer.probabilities,
			confidence: answer.confidence,
			requestMs: performance.now() - started,
			...(options.contextBuildMs === undefined
				? {}
				: { contextBuildMs: options.contextBuildMs }),
			requestBytes,
			...(archivedEvidence ? { evidence: archivedEvidence } : {}),
			inputTokens: parsed.data.usage?.input_tokens,
			request,
		},
	};
}
