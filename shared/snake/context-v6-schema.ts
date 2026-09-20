import { z } from "zod";
import type { DecisionRequestV6 } from "./board-context.js";
import { decisionProgressSchema } from "./context-schema.js";
import { directions, type Point } from "./types.js";

const integer = z.number().int().nonnegative();
const point = z.object({ x: integer, y: integer }).strict();
export const decisionStateV6Schema = z
	.object({
		contextVersion: z.literal("board-state-v6"),
		rules: z
			.object({
				objective: z.string(),
				applePoints: integer,
				starPoints: integer,
				coordinates: z.string(),
				mechanics: z.string(),
			})
			.strict(),
		board: z
			.object({
				width: z.number().int().positive(),
				height: z.number().int().positive(),
				obstacles: z.array(point),
			})
			.strict(),
		player: z
			.object({
				bodyHeadToTail: z.array(point).nonempty(),
				direction: z.enum(directions),
				score: integer,
				applesEaten: integer,
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
		timing: z
			.object({
				stateIsProjected: z.literal(false),
				stepMode: z.literal("response"),
				observedTick: integer,
				targetTick: integer,
				gameTimeMs: z.number().nonnegative(),
				tickIntervalMs: z.null(),
				deadlineInMs: z.null(),
			})
			.strict(),
		progress: decisionProgressSchema.optional(),
	})
	.strict()
	.superRefine(validateObservedBoardState);

export function validateObservedBoardState(
	value: Omit<DecisionRequestV6["state"], "contextVersion">,
	context: z.RefinementCtx,
) {
	const issue = (path: (string | number)[], message: string) => {
		context.addIssue({ code: "custom", path, message });
	};
	const occupied = new Set<string>();
	const addCell = (cell: Point, path: (string | number)[]) => {
		if (cell.x >= value.board.width || cell.y >= value.board.height)
			issue(path, "Cell must lie within the board");
		const key = `${cell.x},${cell.y}`;
		if (occupied.has(key)) issue(path, "Board occupants cannot overlap");
		occupied.add(key);
	};
	for (const [index, cell] of value.player.bodyHeadToTail.entries()) {
		const path = ["player", "bodyHeadToTail", index];
		addCell(cell, path);
		const previous = value.player.bodyHeadToTail[index - 1];
		if (
			previous &&
			Math.abs(previous.x - cell.x) + Math.abs(previous.y - cell.y) !== 1
		)
			issue(path, "Consecutive body cells must share an edge");
	}
	for (const [index, cell] of value.board.obstacles.entries())
		addCell(cell, ["board", "obstacles", index]);
	if (value.food.apple) addCell(value.food.apple, ["food", "apple"]);
	if (value.food.star)
		addCell(value.food.star.point, ["food", "star", "point"]);
	if (value.timing.targetTick !== value.timing.observedTick + 1)
		issue(
			["timing", "targetTick"],
			"The model must choose the next observed move",
		);
	if (
		value.progress &&
		value.progress.throughTick !== value.timing.observedTick
	)
		issue(["progress", "throughTick"], "Progress must match the observation");
}

export const decisionRequestV6Schema = z
	.object({
		model: z.string().min(1),
		state: decisionStateV6Schema,
		questions: z
			.object({
				direction: z
					.object({
						type: z.literal("choice"),
						instructions: z.string(),
						criteria: z.record(
							z.enum(directions),
							z.object({ meaning: z.string() }).strict(),
						),
					})
					.strict(),
			})
			.strict(),
	})
	.strict();
