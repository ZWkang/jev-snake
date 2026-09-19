import { z } from "zod";
import {
	actionSummarySchema,
	decisionRequestV3Schema,
	planRequestV3Schema,
} from "./context-schema.js";
import { directions, planChoices } from "./types.js";
import {
	opportunitySchema,
	witnessContinuitySchema,
} from "./witness-schema.js";

const action = actionSummarySchema
	.safeExtend({ opportunity: opportunitySchema })
	.superRefine((a, c) => {
		if (
			(a.immediateCollision !== null) !==
			(a.opportunity.status === "initial_collision")
		)
			c.addIssue({
				code: "custom",
				path: ["opportunity"],
				message: "Opportunity collision must match the action",
			});
	});
function checkState(
	s: {
		timing: { observedTick: number };
		progress?: { throughTick: number };
		witnessContinuity: z.infer<typeof witnessContinuitySchema>;
	},
	c: z.RefinementCtx,
) {
	if (s.progress && s.progress.throughTick !== s.timing.observedTick)
		c.addIssue({
			code: "custom",
			path: ["progress"],
			message: "Progress must match the observed tick",
		});
	for (const w of s.witnessContinuity)
		if (
			w.originTick +
				("stateCompatibleAfterMoves" in w
					? w.stateCompatibleAfterMoves
					: w.matchedMoves) !==
			s.timing.observedTick
		)
			c.addIssue({
				code: "custom",
				path: ["witnessContinuity"],
				message: "Witness geometry must align with the actual observed tick",
			});
}
const state = z
	.object({
		...decisionRequestV3Schema.shape.state.shape,
		contextVersion: z.literal("action-facts-v4"),
		witnessContinuity: witnessContinuitySchema,
	})
	.strict()
	.superRefine(checkState);
export const decisionRequestV4Schema = z
	.object({
		model: z.string().min(1),
		state,
		questions: z
			.object({
				direction: z
					.object({
						type: z.literal("choice"),
						instructions: z.string(),
						criteria: z.record(
							z.enum(directions),
							action.safeExtend({ meaning: z.string() }),
						),
					})
					.strict(),
			})
			.strict(),
	})
	.strict();
const pairBase = { first: z.enum(directions), second: z.enum(directions) };
const pair = z.discriminatedUnion("secondStatus", [
	z
		.object({
			...pairBase,
			secondStatus: z.literal("known"),
			secondFacts: action,
		})
		.strict(),
	z
		.object({
			...pairBase,
			secondStatus: z.enum([
				"not_executed_first_blocked",
				"not_executed_board_complete",
			]),
			secondFacts: z.null(),
		})
		.strict(),
	z
		.object({
			...pairBase,
			secondStatus: z.literal("unknown_after_growth"),
			secondFacts: z
				.object({
					immediateCollision: z
						.enum(["reverse", "wall", "obstacle", "body"])
						.nullable(),
					reason: z.literal("new_apple_position_unknown"),
				})
				.strict(),
		})
		.strict(),
]);
export const planRequestV4Schema = z
	.object({
		model: z.string().min(1),
		state: z
			.object({
				...planRequestV3Schema.shape.state.shape,
				contextVersion: z.literal("two-step-plan-v4"),
				witnessContinuity: witnessContinuitySchema,
				firstActions: z.record(z.enum(directions), action),
			})
			.strict()
			.superRefine(checkState),
		questions: z
			.object({
				plan: z
					.object({
						type: z.literal("choice"),
						instructions: z.string(),
						criteria: z.record(z.enum(planChoices), pair),
					})
					.strict(),
			})
			.strict(),
	})
	.strict()
	.superRefine((r, c) => {
		for (const key of planChoices) {
			const p = r.questions.plan.criteria[key];
			if (`${p.first}_${p.second}` !== key)
				c.addIssue({
					code: "custom",
					path: ["questions", "plan", "criteria", key],
					message: "Pair directions must match the choice key",
				});
			const first = r.state.firstActions[p.first];
			const expected =
				first.immediateCollision !== null
					? "not_executed_first_blocked"
					: first.terminal === "board_complete"
						? "not_executed_board_complete"
						: first.eatsApple
							? "unknown_after_growth"
							: "known";
			if (p.secondStatus !== expected)
				c.addIssue({
					code: "custom",
					path: ["questions", "plan", "criteria", key],
					message: `First move requires ${expected}`,
				});
		}
	});
