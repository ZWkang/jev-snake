import type { ActionFact, Direction, Point } from "./types.js";
import { opposite, vectors } from "./types.js";

export type MoveGeometry = {
	config: { width: number; height: number };
	snake: readonly Point[];
	direction: Direction;
	obstacles: readonly Point[];
	apple: Point | null;
};

const equal = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

// The live engine and decision observations use exactly the same immediate rules.
export function inspectMove(
	s: MoveGeometry,
	direction: Direction,
): Pick<ActionFact, "target" | "eatsApple" | "immediateCollision"> {
	const from = s.snake[0];
	const v = vectors[direction];
	const target = { x: from.x + v.x, y: from.y + v.y };
	const growing = !!s.apple && equal(target, s.apple);
	const body = growing ? s.snake : s.snake.slice(0, -1);
	const immediateCollision =
		direction === opposite[s.direction]
			? "reverse"
			: target.x < 0 ||
				  target.y < 0 ||
				  target.x >= s.config.width ||
				  target.y >= s.config.height
				? "wall"
				: s.obstacles.some((p) => equal(p, target))
					? "obstacle"
					: body.some((p) => equal(p, target))
						? "body"
						: null;
	return { target, eatsApple: growing, immediateCollision };
}
