import { z } from "zod";
import {
	decisionRequestV3Schema,
	planRequestV3Schema,
} from "./context-schema.js";
import {
	decisionRequestV4Schema,
	planRequestV4Schema,
} from "./context-v4-schema.js";
import { decisionRequestV5Schema } from "./context-v5-schema.js";
import { decisionRequestV6Schema } from "./context-v6-schema.js";
import { decisionRequestV7Schema } from "./context-v7-schema.js";
import { decisionRequestV8Schema } from "./context-v8-schema.js";
import { decisionRequestV9Schema } from "./context-v9-schema.js";
import { decisionRequestV10Schema } from "./context-v10-schema.js";
import { decisionRequestV11Schema } from "./context-v11-schema.js";
import { decisionRequestV12Schema } from "./context-v12-schema.js";
import { decisionRequestV13Schema } from "./context-v13-schema.js";
import { decisionRequestV14Schema } from "./context-v14-schema.js";
import { decisionRequestV15Schema } from "./context-v15-schema.js";
import {
	isStagnationStopReason,
	stagnationStopReasons,
	type StagnationEvidence,
} from "./stagnation.js";
import { decisionModes, directions, planChoices, stepModes } from "./types.js";
import { witnessArchiveSchema } from "./witness-schema.js";

const integer = z.number().int().nonnegative();
const point = z.object({ x: integer, y: integer }).strict();
const actionFact = z
	.object({
		target: z.object({ x: z.number().int(), y: z.number().int() }).strict(),
		immediateCollision: z
			.enum(["reverse", "wall", "obstacle", "body"])
			.nullable(),
		appleDistance: integer.nullable(),
		eatsApple: z.boolean(),
		forcedPath: z
			.object({
				outcome: z.enum([
					"forced_collision",
					"branch",
					"cycle",
					"unknown_after_apple",
					"board_complete",
				]),
				steps: z.number().int().positive(),
			})
			.strict()
			.nullable()
			.optional(),
	})
	.strict();
const legacyTimingBase = {
	stateIsProjected: z.literal(false),
	observedTick: integer,
	targetTick: integer,
	gameTimeMs: z.number().nonnegative(),
};
const legacyStateFields = {
	actionFacts: z.record(z.enum(directions), actionFact).optional(),
	rules: z
		.object({
			objective: z.string(),
			applePoints: integer,
			starPoints: integer,
		})
		.strict(),
	board: z
		.object({ width: integer, height: integer, obstacles: z.array(point) })
		.strict(),
	player: z
		.object({
			head: point,
			bodyHeadToTail: z.array(point),
			direction: z.enum(directions),
			score: integer,
		})
		.strict(),
	food: z
		.object({
			apple: point.nullable(),
			star: z
				.object({ point, expiresAt: z.number().nonnegative() })
				.strict()
				.nullable(),
		})
		.strict(),
};
const legacyDecisionRequestSchema = z
	.object({
		model: z.string().min(1),
		state: z
			.object({
				contextVersion: z
					.enum(["action-facts-v1", "action-facts-v2"])
					.optional(),
				...legacyStateFields,
				timing: z.discriminatedUnion("stateIsProjected", [
					z
						.object({
							...legacyTimingBase,
							stepMode: z.enum(stepModes).optional(),
							deadlineInMs: z.number().nullable().optional(),
							tickIntervalMs: integer.nullable(),
						})
						.strict(),
					z
						.object({
							stateIsProjected: z.literal(true),
							projectedBeforeTick: integer,
							gameTimeMs: z.number().nonnegative(),
							tickIntervalMs: integer,
						})
						.strict(),
				]),
			})
			.strict(),
		questions: z
			.object({
				direction: z
					.object({
						type: z.literal("choice"),
						instructions: z.string(),
						criteria: z.record(
							z.enum(directions),
							z.union([
								z.string(),
								actionFact.extend({ meaning: z.string() }).strict(),
							]),
						),
					})
					.strict(),
			})
			.strict(),
	})
	.strict();
const legacyPlanRequestSchema = z
	.object({
		model: z.string().min(1),
		state: z
			.object({
				contextVersion: z.enum(["two-step-plan-v1", "two-step-plan-v2"]),
				...legacyStateFields,
				planningHorizon: z.literal(2),
				targetTicks: z.tuple([integer, integer]),
				timing: z
					.object({
						...legacyTimingBase,
						stepMode: z.literal("fixed").optional(),
						deadlineInMs: z.number().optional(),
						tickIntervalMs: integer,
					})
					.strict(),
			})
			.strict(),
		questions: z
			.object({
				plan: z
					.object({
						type: z.literal("choice"),
						instructions: z.string(),
						criteria: z.record(z.enum(planChoices), z.string()),
					})
					.strict(),
			})
			.strict(),
	})
	.strict();

function contextVersion(value: unknown): unknown {
	if (typeof value !== "object" || value === null || !("state" in value))
		return undefined;
	const state = value.state;
	return typeof state === "object" &&
		state !== null &&
		"contextVersion" in state
		? state.contextVersion
		: undefined;
}
// Select the shape before parsing. A malformed versioned request never reaches a legacy parser.
export const decisionRequestSchema = z.unknown().transform((value, context) => {
	const result = (
		contextVersion(value) === "growth-space-v15"
			? decisionRequestV15Schema
			: contextVersion(value) === "dynamic-space-v14"
				? decisionRequestV14Schema
				: contextVersion(value) === "legal-space-v13"
					? decisionRequestV13Schema
					: contextVersion(value) === "non-reverse-v12"
						? decisionRequestV12Schema
						: contextVersion(value) === "model-planning-v11"
							? decisionRequestV11Schema
							: contextVersion(value) === "post-apple-v10"
								? decisionRequestV10Schema
								: contextVersion(value) === "bounded-search-v9"
									? decisionRequestV9Schema
									: contextVersion(value) === "global-view-v8"
										? decisionRequestV8Schema
										: contextVersion(value) === "local-moves-v7"
											? decisionRequestV7Schema
											: contextVersion(value) === "board-state-v6"
												? decisionRequestV6Schema
												: contextVersion(value) === "action-outcomes-v5"
													? decisionRequestV5Schema
													: contextVersion(value) === "action-facts-v4"
														? decisionRequestV4Schema
														: contextVersion(value) === "action-facts-v3"
															? decisionRequestV3Schema
															: legacyDecisionRequestSchema
	).safeParse(value);
	if (result.success) return result.data;
	for (const issue of result.error.issues) context.addIssue({ ...issue });
	return z.NEVER;
});
export const planRequestSchema = z.unknown().transform((value, context) => {
	const result = (
		contextVersion(value) === "two-step-plan-v4"
			? planRequestV4Schema
			: contextVersion(value) === "two-step-plan-v3"
				? planRequestV3Schema
				: legacyPlanRequestSchema
	).safeParse(value);
	if (result.success) return result.data;
	for (const issue of result.error.issues) context.addIssue({ ...issue });
	return z.NEVER;
});
const fixedConfigSchema = z
	.object({
		layoutVersion: z.union([z.literal(2), z.literal(3)]).optional(),
		stepMode: z.literal("fixed").optional(),
		decisionMode: z.enum(decisionModes).optional(),
		width: z.number().int().min(7).default(24),
		height: z.number().int().positive().default(18),
		obstacleCount: integer.default(12),
		tickIntervalMs: z.number().int().positive().default(300),
		seed: z.string().min(1),
	})
	.strict();
const responseConfigSchema = fixedConfigSchema
	.extend({
		stepMode: z.literal("response"),
		decisionMode: z.literal("single_step").optional(),
		tickIntervalMs: z.null().default(null),
	})
	.strict();
export const configSchema = z.union([fixedConfigSchema, responseConfigSchema]);
export const legacyCreateSchema = z
	.object({
		requestId: z.string().min(1),
		controlToken: z.string().min(32),
		agentName: z.string().trim().min(1),
		model: z.string().min(1).nullable().default(null),
		config: configSchema,
	})
	.strict();
// Creation is response-only; historical configuration parsing stays unchanged.
export const newConfigSchema = responseConfigSchema.extend({
	layoutVersion: z.union([z.literal(2), z.literal(3)]).default(3),
	stepMode: z.literal("response").default("response"),
	decisionMode: z.literal("single_step").default("single_step"),
});
export const createSchema = legacyCreateSchema.extend({
	config: newConfigSchema,
});
export const forkSchema = createSchema
	.omit({ config: true })
	.extend({ sourceSeq: integer })
	.strict();
const decisionEnvelopeSchema = z
	.object({
		provider: z.enum(["typesafe", "openrouter"]).optional(),
		model: z.string().min(1),
		choice: z.enum(directions),
		probabilities: z.partialRecord(
			z.enum(directions),
			z.number().min(0).max(1),
		),
		confidence: z.number().min(0).max(1),
		requestMs: z.number().nonnegative(),
		inferenceMs: z.number().nonnegative().optional(),
		contextBuildMs: z.number().nonnegative().optional(),
		requestBytes: integer.optional(),
		inputTokens: integer.optional(),
		evidence: witnessArchiveSchema.optional(),
		request: decisionRequestSchema.optional(),
	})
	.strict();
export const decisionSchema = decisionEnvelopeSchema.superRefine(
	(value, context) => {
		const request = value.request;
		const candidates =
			request?.state.contextVersion === "non-reverse-v12" ||
			request?.state.contextVersion === "legal-space-v13" ||
			request?.state.contextVersion === "dynamic-space-v14" ||
			request?.state.contextVersion === "growth-space-v15"
				? Object.keys(request.questions.direction.criteria)
				: [...directions];
		const keys = Object.keys(value.probabilities);
		if (
			keys.length !== candidates.length ||
			candidates.some(
				(direction) => !Object.hasOwn(value.probabilities, direction),
			)
		)
			context.addIssue({
				code: "custom",
				path: ["probabilities"],
				message:
					"Probabilities must contain exactly the choices from this request",
			});
		if (!candidates.includes(value.choice))
			context.addIssue({
				code: "custom",
				path: ["choice"],
				message: "The selected direction must be one of this request's choices",
			});
	},
);
export const planDecisionSchema = decisionEnvelopeSchema
	.extend({
		kind: z.literal("plan"),
		choice: z.enum(planChoices),
		probabilities: z.record(z.enum(planChoices), z.number().min(0).max(1)),
		request: planRequestSchema,
	})
	.strict();
const base = {
	protocolVersion: z.union([z.literal(1), z.literal(2)]),
	requestId: z.string().min(1),
};
export const stagnationEvidenceSchema: z.ZodType<StagnationEvidence> = z
	.object({
		reason: z.enum(stagnationStopReasons),
		observedTick: integer,
		movesSinceApple: integer,
		positionVisits: integer.min(1),
		maxPositionVisits: integer.min(2),
		maxMovesWithoutApple: integer.min(1),
	})
	.strict()
	.superRefine((value, context) => {
		if (
			value.reason === "stagnation_loop" &&
			value.positionVisits < value.maxPositionVisits
		)
			context.addIssue({
				code: "custom",
				path: ["positionVisits"],
				message: "Repeated position visits must reach the recorded limit",
			});
		if (
			value.reason === "stagnation_no_apple" &&
			value.movesSinceApple < value.maxMovesWithoutApple
		)
			context.addIssue({
				code: "custom",
				path: ["movesSinceApple"],
				message: "Moves without an apple must reach the recorded limit",
			});
	});
export const controlSchema = z.discriminatedUnion("type", [
	z.object({ ...base, type: z.literal("start") }).strict(),
	z
		.object({
			...base,
			type: z.literal("stop"),
			reason: z.string().min(1).default("controller_stop"),
			guard: stagnationEvidenceSchema.optional(),
		})
		.strict()
		.superRefine((value, context) => {
			if (isStagnationStopReason(value.reason)) {
				if (!value.guard || value.guard.reason !== value.reason)
					context.addIssue({
						code: "custom",
						path: ["guard"],
						message: "A stagnation stop requires evidence for the same reason",
					});
			} else if (value.guard) {
				context.addIssue({
					code: "custom",
					path: ["guard"],
					message: "Stagnation evidence belongs only to a stagnation stop",
				});
			}
		}),
	z
		.object({
			...base,
			type: z.literal("action"),
			protocolVersion: z.literal(1),
			observedSeq: integer,
			targetTick: z.number().int().positive(),
			expectedStateHash: z.string().regex(/^[a-f0-9]{64}$/),
			direction: z.enum(directions),
			decision: decisionSchema.optional(),
		})
		.strict(),
]);
export const planControlSchema = z
	.object({
		...base,
		protocolVersion: z.literal(2),
		type: z.literal("plan"),
		observedSeq: integer,
		targetTick: z.number().int().positive(),
		expectedStateHash: z.string().regex(/^[a-f0-9]{64}$/),
		directions: z.tuple([z.enum(directions), z.enum(directions)]),
		decision: planDecisionSchema,
	})
	.strict();
export const allControlSchema = z.union([controlSchema, planControlSchema]);
export const watchSchema = z
	.object({
		type: z.literal("subscribe"),
		afterSeq: z.number().int().min(-1).default(-1),
	})
	.strict();
export type CreateInput = z.infer<typeof createSchema>;
export type ControlInput = z.infer<typeof allControlSchema>;
