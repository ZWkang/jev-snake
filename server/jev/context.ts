import {
	type ActionFact,
	type Direction,
	directions,
	type ForcedPath,
	type PublicState,
} from "../../shared/snake/types.js";
import { inspectMove } from "../game/engine.js";

export function forcedPath(
	state: PublicState,
	direction: Direction,
): ForcedPath {
	const position = {
		config: state.config,
		obstacles: state.obstacles,
		apple: state.apple,
		snake: [...state.snake],
		direction: state.direction,
	};
	const positionKey = () =>
		JSON.stringify([position.direction, position.snake]);
	const seen = new Set([positionKey()]);
	let steps = 0;
	for (;;) {
		const next = inspectMove(position, direction);
		steps++;
		if (next.immediateCollision) return { outcome: "forced_collision", steps };
		position.snake.unshift(next.target);
		position.direction = direction;
		if (next.eatsApple) {
			if (
				position.snake.length ===
				position.config.width * position.config.height -
					position.obstacles.length
			)
				return { outcome: "board_complete", steps };
			// A new apple cannot occupy the grown body. Whether any next move
			// avoids collision is therefore known even before its random respawn.
			position.apple = null;
			if (
				directions.every(
					(candidate) =>
						inspectMove(position, candidate).immediateCollision !== null,
				)
			)
				return { outcome: "forced_collision", steps: steps + 1 };
			// Further growth and continuation still depend on unknown new food.
			return {
				outcome: "unknown_after_apple",
				steps,
			};
		}
		position.snake.pop();
		const key = positionKey();
		if (seen.has(key)) return { outcome: "cycle", steps };
		seen.add(key);
		const exits = directions.filter(
			(candidate) =>
				inspectMove(position, candidate).immediateCollision === null,
		);
		if (exits.length === 0)
			return { outcome: "forced_collision", steps: steps + 1 };
		if (exits.length > 1) return { outcome: "branch", steps };
		direction = exits[0];
	}
}

export function actionFacts(state: PublicState): Record<Direction, ActionFact> {
	return Object.fromEntries(
		directions.map((direction) => {
			const { target, eatsApple, immediateCollision } = inspectMove(
				state,
				direction,
			);
			return [
				direction,
				{
					target,
					immediateCollision,
					appleDistance: state.apple
						? Math.abs(target.x - state.apple.x) +
							Math.abs(target.y - state.apple.y)
						: null,
					eatsApple,
					forcedPath:
						immediateCollision === null ? forcedPath(state, direction) : null,
				},
			];
		}),
	) as Record<Direction, ActionFact>;
}

export function secondStepFacts(
	state: PublicState,
	first: Direction,
): Record<
	Direction,
	Pick<ActionFact, "immediateCollision" | "forcedPath">
> | null {
	const next = inspectMove(state, first);
	if (next.immediateCollision) return null;
	const snake = [
		next.target,
		...(next.eatsApple ? state.snake : state.snake.slice(0, -1)),
	];
	if (
		snake.length ===
		state.config.width * state.config.height - state.obstacles.length
	)
		return null;
	const position = {
		...state,
		snake,
		direction: first,
		apple: next.eatsApple ? null : state.apple,
	};
	if (!next.eatsApple) return actionFacts(position);
	// A respawn cannot occupy the new snake, including its tail, so it cannot
	// change second-move collision. Growth and later survival are still unknown.
	return Object.fromEntries(
		directions.map((direction) => [
			direction,
			{
				immediateCollision: inspectMove(position, direction).immediateCollision,
			},
		]),
	) as Record<Direction, Pick<ActionFact, "immediateCollision">>;
}
