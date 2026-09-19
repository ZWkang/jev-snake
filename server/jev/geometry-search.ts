import {
	type Direction,
	directions,
	opposite,
	type Point,
	type PublicState,
	vectors,
} from "../../shared/snake/types.js";

// This is a frozen graph, NOT a complete search through moving-body states.
export function frozenSearch(
	state: PublicState,
	options: {
		goal?: Point;
		tailTerminal?: boolean;
		avoidApple?: boolean;
		firstDirection?: boolean;
	} = {},
) {
	const { width, height } = state.config;
	const key = (p: Point) => p.y * width + p.x;
	const start = key(state.snake[0]);
	const goal = options.goal === undefined ? undefined : key(options.goal);
	const blocked = new Set(
		[...state.obstacles, ...state.snake.slice(1)].map(key),
	);
	if (options.tailTerminal && goal !== undefined) blocked.delete(goal);
	if (options.avoidApple && state.apple) blocked.add(key(state.apple));
	const queue = [start];
	const parents = new Map<number, { from: number; direction: Direction }>();
	const seen = new Set([start]);
	for (let i = 0; i < queue.length; i++) {
		const cell = queue[i];
		if (cell === goal) {
			const route: Direction[] = [];
			let cursor = cell;
			while (cursor !== start) {
				const edge = parents.get(cursor);
				if (!edge) throw new Error("Missing BFS predecessor");
				route.push(edge.direction);
				cursor = edge.from;
			}
			return { count: seen.size, route: route.reverse() };
		}
		for (const direction of directions) {
			if (
				cell === start &&
				options.firstDirection &&
				direction === opposite[state.direction]
			)
				continue;
			const x = (cell % width) + vectors[direction].x,
				y = Math.floor(cell / width) + vectors[direction].y;
			if (x < 0 || x >= width || y < 0 || y >= height) continue;
			const next = y * width + x;
			if (blocked.has(next) || seen.has(next)) continue;
			seen.add(next);
			parents.set(next, { from: cell, direction });
			queue.push(next);
		}
	}
	return { count: seen.size, route: null };
}
