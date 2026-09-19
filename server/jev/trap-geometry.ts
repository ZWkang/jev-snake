import {
	directions,
	type PublicState,
	vectors,
} from "../../shared/snake/types.js";
import { inspectMove } from "../game/engine.js";

export type PostAppleForcedDeath = {
	collisionWithinMoves: number;
	freeCellsAfterGrowth: number;
};

// Sufficient proof after eating the observed apple. Without later growth the
// body releases cells as early as possible. While that optimistic body has one
// exit, every actual continuation must follow it or collide earlier: additional
// growth only occupies more cells along the same head path. This bound does not
// predict the new food. Filling the board before the collision can instead win.
export function postAppleForcedDeath(
	afterGrowth: PublicState,
): PostAppleForcedDeath | null {
	const position = {
		config: afterGrowth.config,
		obstacles: afterGrowth.obstacles,
		snake: [...afterGrowth.snake],
		direction: afterGrowth.direction,
		apple: null,
	};
	const freeCellsAfterGrowth =
		position.config.width * position.config.height -
		position.obstacles.length -
		position.snake.length;
	if (freeCellsAfterGrowth === 0) return null;
	const seen = new Set<string>();
	let successfulMoves = 0;
	for (;;) {
		const key = JSON.stringify([position.direction, position.snake]);
		if (seen.has(key)) return null;
		seen.add(key);
		const exits = directions.flatMap((direction) => {
			const next = inspectMove(position, direction);
			return next.immediateCollision === null
				? [{ direction, target: next.target }]
				: [];
		});
		if (exits.length === 0)
			return freeCellsAfterGrowth > successfulMoves
				? { collisionWithinMoves: successfulMoves + 1, freeCellsAfterGrowth }
				: null;
		if (exits.length > 1) return null;
		position.direction = exits[0].direction;
		position.snake.unshift(exits[0].target);
		position.snake.pop();
		successfulMoves++;
	}
}

export type TrappedRegion = {
	regionCells: number;
	bodyLength: number;
	boundaryReleaseLowerBound: number;
};

// Exact sufficient proof, not a space-score threshold or a search budget.
// With A reachable cells (including the head) and length L > A, at most A-1
// further moves fit without revisiting the new body. Escape would need a
// boundary body cell to vacate by move A. If all such cells take longer, every
// continuation dies. Growth only delays release. Exclude regions containing
// all remaining empty cells: growing to fill the board could instead win.
export function trappedRegion(state: PublicState): TrappedRegion | null {
	const { width, height } = state.config;
	const key = (x: number, y: number) => y * width + x;
	const body = new Map(
		state.snake.slice(1).map((p, i) => [key(p.x, p.y), i + 1]),
	);
	const obstacles = new Set(state.obstacles.map((p) => key(p.x, p.y)));
	const head = state.snake[0];
	const queue = [key(head.x, head.y)];
	const seen = new Set(queue);
	const bodyLength = state.snake.length;
	let boundaryReleaseLowerBound = bodyLength;
	for (let i = 0; i < queue.length; i++) {
		const cell = queue[i];
		for (const direction of directions) {
			const x = (cell % width) + vectors[direction].x;
			const y = Math.floor(cell / width) + vectors[direction].y;
			if (x < 0 || x >= width || y < 0 || y >= height) continue;
			const next = key(x, y);
			if (obstacles.has(next)) continue;
			const index = body.get(next);
			if (index !== undefined) {
				// A segment at index i can be entered after L-i non-growing moves.
				boundaryReleaseLowerBound = Math.min(
					boundaryReleaseLowerBound,
					bodyLength - index,
				);
			} else if (!seen.has(next)) {
				seen.add(next);
				queue.push(next);
			}
		}
	}
	const regionCells = seen.size;
	const emptyCells = width * height - obstacles.size - bodyLength;
	if (
		regionCells >= bodyLength ||
		boundaryReleaseLowerBound <= regionCells ||
		emptyCells <= regionCells - 1
	)
		return null; // No proof; this says nothing about whether the move is safe.
	return { regionCells, bodyLength, boundaryReleaseLowerBound };
}
