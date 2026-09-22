import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
	type Decision,
	type DecisionProgress,
	type DecisionRequest,
	directions,
	type PublicState,
} from "../../shared/snake/types.js";
import type { WitnessArchive } from "../../shared/snake/witness-context.js";
import {
	buildDecisionContext,
	buildDecisionContextV13,
	type DecisionTiming,
} from "./board-context.js";
import { JEV_PROVIDERS, type ActiveJevProvider } from "./config.js";
import type { GrowthRouteMemory } from "./growth-route-memory.js";
import {
	ProviderError,
	providerHttpError,
	networkError,
} from "./transport-error.js";
export {
	buildDecisionContext,
	decisionBody,
	buildBoardContextV6,
	decisionBodyV6,
	decisionBodyV11,
	buildDecisionContextV12,
	decisionBodyV12,
	buildDecisionContextV13,
	decisionBodyV13,
	buildDecisionContextV14,
	decisionBodyV14,
	buildDecisionContextV15,
	decisionBodyV15,
} from "./board-context.js";
export type { DecisionTiming } from "./board-context.js";

const answerSchema = z.object({
	model: z.string().min(1),
	answers: z.object({
		direction: z.object({
			type: z.literal("choice"),
			choice: z.enum(directions),
			probabilities: z.partialRecord(
				z.enum(directions),
				z.number().min(0).max(1),
			),
			confidence: z.number().min(0).max(1),
		}),
	}),
	usage: z
		.object({ input_tokens: z.number().nonnegative().optional() })
		.optional(),
});
export const JEV_MODEL = JEV_PROVIDERS.typesafe.model;
export const JEV_ENDPOINT = JEV_PROVIDERS.typesafe.endpoint;

type JevOptions = {
	fetch?: typeof fetch;
	signal?: AbortSignal;
	provider?: ActiveJevProvider;
	model?: string;
	timing?: DecisionTiming;
	progress?: DecisionProgress;
	dynamicAnalysis?: boolean;
	routeMemory?: GrowthRouteMemory;
	onRequestStarted?: () => void;
};
export function askJev(
	apiKey: string,
	state: PublicState,
	options: JevOptions = {},
): Promise<Decision> {
	const started = performance.now();
	const model =
		options.model ?? JEV_PROVIDERS[options.provider ?? "typesafe"].model;
	const { request } =
		options.dynamicAnalysis === false
			? buildDecisionContextV13(state, model, options.timing, options.progress)
			: buildDecisionContext(
					state,
					model,
					options.timing,
					options.progress,
					options.routeMemory,
				);
	const contextBuildMs = performance.now() - started;
	return sendJevRequest(apiKey, request, { ...options, contextBuildMs }).then(
		(result) => result.decision,
	);
}
// Evaluation shares the single-step transport; plan bodies are offline-only.
export async function sendJevRequest(
	apiKey: string,
	request: DecisionRequest,
	options: Pick<
		JevOptions,
		"fetch" | "signal" | "provider" | "onRequestStarted"
	> & {
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
	options.signal?.throwIfAborted();
	const started = performance.now();
	options.onRequestStarted?.();
	let response: Response;
	try {
		response = await (options.fetch ?? fetch)(config.endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body,
			signal: options.signal,
		});
	} catch (error) {
		if (options.signal?.aborted && error === options.signal.reason) throw error;
		throw networkError(provider, error);
	}
	let rawResponse: unknown;
	try {
		rawResponse = await response.json();
	} catch (error) {
		if (options.signal?.aborted && error === options.signal.reason) throw error;
		if (!response.ok) throw providerHttpError(provider, response, null);
		throw new ProviderError(provider, "invalid_response", response.status);
	}
	if (!response.ok) throw providerHttpError(provider, response, rawResponse);
	const parsed = schema.safeParse(rawResponse);
	if (!parsed.success)
		throw new ProviderError(provider, "invalid_response", response.status);
	if (parsed.data.model.includes(apiKey))
		throw new ProviderError(provider, "invalid_response", response.status);
	const answer = parsed.data.answers.direction;
	const offered = Object.keys(
		request.questions.direction.criteria,
	) as (typeof directions)[number][];
	if (!offered.includes(answer.choice))
		throw new ProviderError(provider, "unoffered_choice", response.status);
	if (
		Object.keys(answer.probabilities).length !== offered.length ||
		offered.some((direction) => answer.probabilities[direction] === undefined)
	)
		throw new ProviderError(provider, "invalid_probabilities", response.status);
	const sum = offered.reduce(
		(total, direction) => total + answer.probabilities[direction]!,
		0,
	);
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
