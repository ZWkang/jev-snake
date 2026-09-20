import { z } from "zod";
import {
	decisionStateV6Schema,
	validateObservedBoardState,
} from "./context-v6-schema.js";
import type { DecisionRequestV7, ImmediateMoveFacts } from "./local-moves.js";
import {
	type Direction,
	directions,
	opposite,
	type Point,
	vectors,
} from "./types.js";

export const immediateMoveFactsSchema = z
	.object({
		target: z.object({ x: z.number().int(), y: z.number().int() }).strict(),
		legal: z.boolean(),
		blockedBy: z.enum(["none", "reverse", "wall", "obstacle", "body"]),
		destination: z.enum([
			"outside_board",
			"obstacle",
			"snake_body",
			"vacating_tail",
			"apple",
			"star",
			"empty",
		]),
		appleProgress: z.enum([
			"eats_now",
			"closer",
			"farther",
			"same_distance",
			"no_apple",
			"not_applicable",
		]),
		departureHistory: z.enum([
			"not_taken_here",
			"taken_without_recorded_return",
			"returned_without_apple",
			"not_recorded",
		]),
		description: z.string().min(1),
	})
	.strict();

const equal = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const distance = (a: Point, b: Point) =>
	Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

const state = z
	.object({
		...decisionStateV6Schema.shape,
		contextVersion: z.literal("local-moves-v7"),
		immediateMoves: z.record(z.enum(directions), immediateMoveFactsSchema),
	})
	.strict()
	.superRefine(validateObservedBoardState)
	.superRefine(validateImmediateMoves);

type ImmediateObservedState = Omit<
	DecisionRequestV7["state"],
	"contextVersion" | "immediateMoves"
> & {
	immediateMoves: Record<
		Direction,
		Omit<ImmediateMoveFacts, "appleProgress"> &
			Partial<Pick<ImmediateMoveFacts, "appleProgress">>
	>;
};

export function validateImmediateMoves(
	value: ImmediateObservedState,
	context: z.RefinementCtx,
) {
	const body = value.player.bodyHeadToTail;
	// The inherited nonempty body schema reports this malformed observation.
	if (body.length === 0) return;
	const head = body[0];
	const tail = body[body.length - 1];
	const apple = value.food.apple;
	for (const direction of directions) {
		const facts = value.immediateMoves[direction];
		const vector = vectors[direction];
		const target = { x: head.x + vector.x, y: head.y + vector.y };
		const outside =
			target.x < 0 ||
			target.y < 0 ||
			target.x >= value.board.width ||
			target.y >= value.board.height;
		const obstacle = value.board.obstacles.some((p) => equal(p, target));
		const eatsApple = apple !== null && equal(apple, target);
		const vacatingTail = !eatsApple && equal(tail, target);
		const occupiedBody = body.some(
			(p, index) => (index < body.length - 1 || eatsApple) && equal(p, target),
		);
		const blockedBy: ImmediateMoveFacts["blockedBy"] =
			direction === opposite[value.player.direction]
				? "reverse"
				: outside
					? "wall"
					: obstacle
						? "obstacle"
						: occupiedBody
							? "body"
							: "none";
		const destination: ImmediateMoveFacts["destination"] = outside
			? "outside_board"
			: obstacle
				? "obstacle"
				: occupiedBody
					? "snake_body"
					: vacatingTail
						? "vacating_tail"
						: eatsApple
							? "apple"
							: value.food.star && equal(value.food.star.point, target)
								? "star"
								: "empty";

		const actionHistory = value.progress?.actions[direction];
		const departureHistory: ImmediateMoveFacts["departureHistory"] =
			!actionHistory
				? "not_recorded"
				: actionHistory.returnsWithoutApple > 0
					? "returned_without_apple"
					: actionHistory.timesTaken > 0
						? "taken_without_recorded_return"
						: "not_taken_here";
		const require = (valid: boolean, field: string) => {
			if (!valid)
				context.addIssue({
					code: "custom",
					path: ["immediateMoves", direction, field],
					message: "Immediate facts must match the observed board and history",
				});
		};
		require(equal(facts.target, target), "target");
		require(facts.legal === (blockedBy === "none"), "legal");
		require(facts.blockedBy === blockedBy, "blockedBy");
		require(facts.destination === destination, "destination");
		if ("appleProgress" in facts) {
			const appleProgress: ImmediateMoveFacts["appleProgress"] =
				blockedBy !== "none"
					? "not_applicable"
					: apple === null
						? "no_apple"
						: eatsApple
							? "eats_now"
							: distance(target, apple) < distance(head, apple)
								? "closer"
								: distance(target, apple) > distance(head, apple)
									? "farther"
									: "same_distance";
			require(facts.appleProgress === appleProgress, "appleProgress");
		}
		require(facts.departureHistory === departureHistory, "departureHistory");
	}
}

export const decisionRequestV7Schema = z
	.object({
		model: z.string().min(1),
		state,
		questions: z
			.object({
				direction: z
					.object({
						type: z.literal("choice"),
						instructions: z
							.object({
								question: z.string().min(1),
								inspect: z.string().min(1),
								constraint: z.string().min(1),
								objective: z.string().min(1),
								uncertainty: z.string().min(1),
								history: z.string().min(1),
							})
							.strict(),
						criteria: z.record(
							z.enum(directions),
							z
								.object({
									meaning: z.string().min(1),
									chooseWhen: z.string().min(1),
									excludeWhen: z.string().min(1),
								})
								.strict(),
						),
					})
					.strict(),
			})
			.strict(),
	})
	.strict();
