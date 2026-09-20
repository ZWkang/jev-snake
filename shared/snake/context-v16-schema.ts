import { z } from "zod";
import { decisionRequestV15Schema } from "./context-v15-schema.js";
import { dynamicStaticSemantics } from "./dynamic-space-analysis.js";
import {
	describeGrowthSpaceMove,
	growthSpaceSemantics,
} from "./growth-space-analysis.js";
import type { DecisionRequestV15 } from "./growth-space.js";
import { directions } from "./types.js";

// The discarded rule text exists only in this validation view. It is never
// added to a parsed compact request or rewritten into a historical payload.
const validationRules: DecisionRequestV15["state"]["rules"] = {
	objective:
		"Grow the snake to fill every traversable cell while collecting rewards. Decide your own route and strategy from the complete observed board and actual history.",
	applePoints: 10,
	starPoints: 30,
	coordinates:
		"Coordinates are zero-based: x increases right, y increases down. The board spans x=0..width-1 and y=0..height-1. bodyHeadToTail lists every occupied snake cell in order, with the head first and the tail last.",
	mechanics:
		"The snake waits for your response, then moves exactly one cell in the chosen absolute direction. Direct reversal is illegal. Hitting the boundary, an obstacle or the body ends the game. The tail vacates its current cell on a move that does not eat an apple, so that vacating tail cell may be entered. Eating an apple grows the body by one cell and gives 10 points; the tail does not vacate. A new apple then appears in an unoccupied cell; its position is unknown until the next observation. A star gives 30 points without growth and expires at food.star.expiresAt in the same game-time milliseconds as timing.gameTimeMs. Filling every non-obstacle cell wins. Past repetition records actual movement and does not prescribe your next move. Apple spawning excludes the current star cell; if the star occupies the only free cell, it is removed to make room for the apple.",
};

export const decisionRequestV16Schema = z
	.object({
		model: z.string().min(1),
		state: z
			.object(decisionRequestV15Schema.shape.state.shape)
			.omit({ rules: true, factsSemantics: true, dynamicSemantics: true })
			.extend({
				contextVersion: z.literal("compact-growth-v16"),
				board: decisionRequestV15Schema.shape.state.shape.board
					.extend({
						ascii:
							decisionRequestV15Schema.shape.state.shape.board.shape.ascii.unwrap(),
					})
					.strict(),
			})
			.strict(),
		questions: z
			.object({
				direction: z
					.object({
						type: z.literal("choice"),
						instructions: z.string(),
						criteria: z.partialRecord(z.enum(directions), z.enum(directions)),
					})
					.strict(),
			})
			.strict(),
	})
	.strict()
	.superRefine((value, context) => {
		if (context.issues.length) return;
		// Reuse all V15 factual checks, including growth/near-win/budget semantics,
		// without invoking the dynamic analyzer or returning this expanded view.
		const canonicalCriteria = Object.fromEntries(
			directions.flatMap((direction) => {
				const immediate = value.state.moveFacts[direction];
				const dynamic = value.state.dynamicFacts[direction];
				// Invalid postcheck shapes must reach V15's structured validation errors,
				// rather than throw while formatting a view that will be rejected.
				if (
					dynamic &&
					(dynamic.apple.status === "route_with_optimistic_continuation" ||
						dynamic.apple.status === "route_postcheck_unknown") &&
					!dynamic.apple.postApple
				)
					return [];
				return immediate && dynamic
					? [
							[
								direction,
								describeGrowthSpaceMove(direction, immediate, dynamic),
							],
						]
					: [];
			}),
		);
		const result = decisionRequestV15Schema.safeParse({
			...value,
			state: {
				...value.state,
				contextVersion: "growth-space-v15",
				rules: validationRules,
				factsSemantics: dynamicStaticSemantics,
				dynamicSemantics: growthSpaceSemantics,
			},
			questions: {
				direction: {
					...value.questions.direction,
					criteria: canonicalCriteria,
				},
			},
		});
		if (!result.success) {
			for (const issue of result.error.issues) context.addIssue({ ...issue });
			return;
		}
		for (const direction of directions) {
			const expected = value.state.moveFacts[direction] ? direction : undefined;
			if (value.questions.direction.criteria[direction] !== expected)
				context.addIssue({
					code: "custom",
					path: ["questions", "direction", "criteria", direction],
					message:
						"Compact choices must name exactly the supplied legal directions",
				});
		}
		const { map, legend } = value.state.board.ascii;
		if (
			!value.questions.direction.instructions.includes(map) ||
			!value.questions.direction.instructions.includes(legend)
		)
			context.addIssue({
				code: "custom",
				path: ["questions", "direction", "instructions"],
				message:
					"Compact instructions must include the observed character map and its legend",
			});
	});
