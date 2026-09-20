import type { ImmediateMoveFacts } from "../../shared/snake/local-moves.js";
import {
	type DecisionProgress,
	type Direction,
	directions,
	type PublicState,
} from "../../shared/snake/types.js";
import { equal, inspectMove } from "../game/engine.js";

/** Four one-step rule lookups only. Never expands a future state or searches a route. */
export function immediateMoves(
	state: PublicState,
	progress?: DecisionProgress,
): Record<Direction, ImmediateMoveFacts> {
	return Object.fromEntries(
		directions.map((direction) => {
			const step = inspectMove(state, direction);
			const { target } = step;
			const outside =
				target.x < 0 ||
				target.y < 0 ||
				target.x >= state.config.width ||
				target.y >= state.config.height;
			const body = state.snake.some((point) => equal(point, target));
			const vacatingTail =
				body &&
				!step.eatsApple &&
				equal(state.snake[state.snake.length - 1], target);
			const destination: ImmediateMoveFacts["destination"] = outside
				? "outside_board"
				: state.obstacles.some((point) => equal(point, target))
					? "obstacle"
					: vacatingTail
						? "vacating_tail"
						: body
							? "snake_body"
							: step.eatsApple
								? "apple"
								: state.star && equal(state.star.point, target)
									? "star"
									: "empty";
			const legal = step.immediateCollision === null;
			const distance = (point: { x: number; y: number }) =>
				Math.abs(point.x - state.apple!.x) + Math.abs(point.y - state.apple!.y);
			const appleProgress: ImmediateMoveFacts["appleProgress"] = !legal
				? "not_applicable"
				: step.eatsApple
					? "eats_now"
					: !state.apple
						? "no_apple"
						: distance(target) < distance(state.snake[0])
							? "closer"
							: distance(target) > distance(state.snake[0])
								? "farther"
								: "same_distance";
			const history = progress?.actions[direction];
			const departureHistory: ImmediateMoveFacts["departureHistory"] = !history
				? "not_recorded"
				: history.returnsWithoutApple > 0
					? "returned_without_apple"
					: history.timesTaken > 0
						? "taken_without_recorded_return"
						: "not_taken_here";
			const cell = {
				outside_board: "outside the board",
				obstacle: "an obstacle",
				snake_body: "the snake's occupied body",
				vacating_tail: "the tail cell, which vacates on this non-growing move",
				apple: "the visible apple",
				star: "the visible star",
				empty: "an empty cell",
			}[destination];
			const description = !legal
				? `Blocked move. ${step.immediateCollision === "reverse" ? "It directly reverses the current heading, which is illegal." : `It immediately hits ${cell} and ends the game.`}`
				: `Legal for this one move. It enters ${cell}. ${appleProgress === "eats_now" ? "The snake eats the apple and grows now." : appleProgress === "closer" ? "The target is one grid step closer to the apple; this is not a verified route." : appleProgress === "farther" ? "The target is one grid step farther from the apple." : ""}${departureHistory === "returned_without_apple" ? " This departure previously returned to this same position without eating an apple." : ""}`.trim();
			return [
				direction,
				{
					target: { ...target },
					legal,
					blockedBy: step.immediateCollision ?? "none",
					destination,
					appleProgress,
					departureHistory,
					description,
				} satisfies ImmediateMoveFacts,
			];
		}),
	) as Record<Direction, ImmediateMoveFacts>;
}

/** v8 keeps exact one-step rule facts without a food-distance preference cue. */
export function currentMoves(
	state: PublicState,
	progress?: DecisionProgress,
): Record<Direction, Omit<ImmediateMoveFacts, "appleProgress">> {
	const facts = immediateMoves(state, progress);
	return Object.fromEntries(
		directions.map((direction) => {
			const { appleProgress: _distance, ...move } = facts[direction];
			if (move.legal) {
				const cells = {
					empty: "an empty cell",
					apple: "the visible apple",
					star: "the visible star",
					vacating_tail: "the tail cell which vacates on this move",
				};
				const cell = cells[move.destination as keyof typeof cells];
				if (!cell)
					throw new Error("A legal move must have an enterable destination");
				move.description =
					`Legal for this one move. It enters ${cell}.` +
					(move.departureHistory === "returned_without_apple"
						? " This departure previously returned here without eating an apple."
						: "");
			}
			return [direction, move];
		}),
	) as Record<Direction, Omit<ImmediateMoveFacts, "appleProgress">>;
}
