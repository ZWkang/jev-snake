import { z } from "zod";
import { decisionRequestV11Schema } from "./context-v11-schema.js";
import {
	analyzeLegalSpace,
	describeLegalSpaceMove,
	legalSpaceSemantics,
} from "./legal-space-analysis.js";
import { directions } from "./types.js";

const integer = z.number().int().nonnegative();
const moveFactsSchema = z
	.object({
		target: z.object({ x: integer, y: integer }).strict(),
		turn: z.enum(["straight", "left turn", "right turn"]),
		eatsApple: z.boolean(),
		eatsStar: z.boolean(),
		appleDistance: integer.nullable(),
		lengthAfter: integer.positive(),
		freeCellsAfter: integer,
		reachableFreeCells: integer,
		canReachTail: z.boolean().nullable(),
		nextLegalMoveCount: integer.max(3).nullable(),
		deadEndRisk: z.boolean(),
		terminal: z.literal("board_complete").nullable(),
	})
	.strict();

export const decisionRequestV13Schema = z
	.object({
		model: z.string().min(1),
		state: z
			.object(decisionRequestV11Schema.shape.state.shape)
			.omit({ strategyGuide: true })
			.extend({
				contextVersion: z.literal("legal-space-v13"),
				factsSemantics: z.literal(legalSpaceSemantics),
				moveFacts: z.partialRecord(z.enum(directions), moveFactsSchema),
				excludedMoves: z.partialRecord(
					z.enum(directions),
					z.enum(["reverse", "wall", "obstacle", "body"]),
				),
			})
			.strict()
			.superRefine((value, context) => {
				if (context.issues.length) return;
				const {
					factsSemantics: _factsSemantics,
					moveFacts,
					excludedMoves,
					...observed
				} = value;
				const result = decisionRequestV11Schema.shape.state.safeParse({
					...observed,
					contextVersion: "model-planning-v11",
				});
				if (!result.success) {
					for (const issue of result.error.issues)
						context.addIssue({ ...issue });
					return;
				}
				const expected = analyzeLegalSpace({
					...value.board,
					bodyHeadToTail: value.player.bodyHeadToTail,
					direction: value.player.direction,
					apple: value.food.apple,
					star: value.food.star?.point ?? null,
				});
				if (!Object.keys(expected.moveFacts).length)
					context.addIssue({
						code: "custom",
						path: ["moveFacts"],
						message: "A decision request must have at least one legal move",
					});
				for (const direction of directions) {
					const actual = moveFacts[direction];
					const expectedFacts = expected.moveFacts[direction];
					if (!!actual !== !!expectedFacts) {
						context.addIssue({
							code: "custom",
							path: ["moveFacts", direction],
							message: "Facts must contain exactly the legal moves",
						});
					} else if (actual && expectedFacts) {
						for (const key of Object.keys(moveFactsSchema.shape) as Array<
							keyof typeof actual
						>) {
							const matches =
								key === "target"
									? actual.target.x === expectedFacts.target.x &&
										actual.target.y === expectedFacts.target.y
									: actual[key] === expectedFacts[key];
							if (!matches)
								context.addIssue({
									code: "custom",
									path: ["moveFacts", direction, key],
									message: "Move facts must match the observed board and rules",
								});
						}
					}
					if (excludedMoves[direction] !== expected.excludedMoves[direction])
						context.addIssue({
							code: "custom",
							path: ["excludedMoves", direction],
							message:
								"Excluded moves must match the observed collision reasons",
						});
				}
			}),
		questions: z
			.object({
				direction: z
					.object({
						type: z.literal("choice"),
						instructions: z.string(),
						criteria: z.partialRecord(z.enum(directions), z.string()),
					})
					.strict(),
			})
			.strict(),
	})
	.strict()
	.superRefine((value, context) => {
		if (context.issues.length) return;
		for (const direction of directions) {
			const facts = value.state.moveFacts[direction];
			const actual = value.questions.direction.criteria[direction];
			const expected = facts
				? describeLegalSpaceMove(direction, facts)
				: undefined;
			if (actual !== expected)
				context.addIssue({
					code: "custom",
					path: ["questions", "direction", "criteria", direction],
					message:
						"Criteria must describe exactly the supplied legal move facts",
				});
		}
	});
