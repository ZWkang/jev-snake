import { z } from "zod";
import { validateObservedBoardState } from "./context-v6-schema.js";
import {
	decisionRequestV7Schema,
	immediateMoveFactsSchema,
	validateImmediateMoves,
} from "./context-v7-schema.js";
import { scanObservedSpace, type ObservedRegion } from "./observed-space.js";
import { directions } from "./types.js";

const region = z
	.object({ cells: z.number().int().positive(), containsApple: z.boolean() })
	.strict();
const observedSpace = z
	.object({
		basis: z.literal("current_occupancy"),
		regions: z.array(region),
		moves: z.record(
			z.enum(directions),
			z
				.object({
					entry: z.enum(["open_cell", "vacating_tail", "blocked"]),
					region: region.nullable(),
					openAdjacentDirections: z.array(z.enum(directions)),
					openAdjacentCells: z.number().int().nonnegative(),
				})
				.strict(),
		),
	})
	.strict();

const equalRegion = (a: ObservedRegion | null, b: ObservedRegion | null) =>
	a === null || b === null
		? a === b
		: a.cells === b.cells && a.containsApple === b.containsApple;

export const decisionRequestV8Schema = z
	.object({
		model: z.string().min(1),
		state: z
			.object({
				...decisionRequestV7Schema.shape.state.shape,
				contextVersion: z.literal("global-view-v8"),
				immediateMoves: z.record(
					z.enum(directions),
					immediateMoveFactsSchema.omit({ appleProgress: true }).strict(),
				),
				observedSpace,
			})
			.strict()
			.superRefine((value, context) => {
				// Only derive observations after the input geometry and moves validate.
				if (context.issues.length) return;
				validateObservedBoardState(value, context);
				validateImmediateMoves(value, context);
				if (context.issues.length) return;
				const expected = scanObservedSpace(
					{
						width: value.board.width,
						height: value.board.height,
						body: value.player.bodyHeadToTail,
						obstacles: value.board.obstacles,
						apple: value.food.apple,
					},
					value.immediateMoves,
				);
				const require = (valid: boolean, path: string[]) => {
					if (!valid)
						context.addIssue({
							code: "custom",
							path: ["observedSpace", ...path],
							message:
								"Space observations must match the current occupied board",
						});
				};
				const recorded = value.observedSpace;
				require(recorded.regions.length === expected.regions.length &&
					recorded.regions.every((item, index) =>
						equalRegion(item, expected.regions[index]),
					), ["regions"]);
				for (const direction of directions) {
					const actual = recorded.moves[direction];
					const target = expected.moves[direction];
					require(actual.entry === target.entry, ["moves", direction, "entry"]);
					require(equalRegion(actual.region, target.region), [
						"moves",
						direction,
						"region",
					]);
					require(actual.openAdjacentCells === target.openAdjacentCells, [
						"moves",
						direction,
						"openAdjacentCells",
					]);
					require(actual.openAdjacentDirections.length ===
						target.openAdjacentDirections.length &&
						actual.openAdjacentDirections.every(
							(entry, index) => entry === target.openAdjacentDirections[index],
						), ["moves", direction, "openAdjacentDirections"]);
				}
			}),
		questions: decisionRequestV7Schema.shape.questions,
	})
	.strict();
