import { z } from "zod";
import {
	decisionRequestV3Schema,
	planRequestV3Schema,
} from "./context-schema.js";
import {
	decisionRequestV4Schema,
	planRequestV4Schema,
} from "./context-v4-schema.js";
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
// Select the shape before parsing. A malformed v3 request never reaches a legacy parser.
export const decisionRequestSchema = z.unknown().transform((value, context) => {
	const result = (
		contextVersion(value) === "action-facts-v4"
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
		layoutVersion: z.literal(2).optional(),
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
export const decisionSchema = z
	.object({
		provider: z.enum(["typesafe", "openrouter"]).optional(),
		model: z.string().min(1),
		choice: z.enum(directions),
		probabilities: z.record(z.enum(directions), z.number().min(0).max(1)),
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
export const planDecisionSchema = decisionSchema
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
export const controlSchema = z.discriminatedUnion("type", [
	z.object({ ...base, type: z.literal("start") }).strict(),
	z
		.object({
			...base,
			type: z.literal("stop"),
			reason: z.string().min(1).default("controller_stop"),
		})
		.strict(),
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
