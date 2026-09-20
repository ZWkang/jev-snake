import { type Direction, directions, type Point, vectors } from "./types.js";

export type ObservedRegion = { cells: number; containsApple: boolean };
export type ObservedSpaceMove = {
	entry: "open_cell" | "vacating_tail" | "blocked";
	region: ObservedRegion | null;
	openAdjacentDirections: Direction[];
	openAdjacentCells: number;
};
export type ObservedSpace = {
	basis: "current_occupancy";
	regions: ObservedRegion[];
	moves: Record<Direction, ObservedSpaceMove>;
};

export type ObservedBoard = {
	width: number;
	height: number;
	body: readonly Point[];
	obstacles: readonly Point[];
	apple: Point | null;
};
export type ObservedEntries = Record<
	Direction,
	{ target: Point; legal: boolean }
>;

/** Current occupancy only. Entries must already satisfy the one-step rules. */
export function scanObservedSpace(
	board: ObservedBoard,
	entries: ObservedEntries,
): ObservedSpace {
	const { width, height } = board;
	const cellCount = width * height;
	const occupied = new Uint8Array(cellCount);
	const regionAt = new Int32Array(cellCount).fill(-1);
	const queue = new Int32Array(cellCount);
	const index = (x: number, y: number) => y * width + x;
	const inside = (x: number, y: number) =>
		x >= 0 && y >= 0 && x < width && y < height;
	for (const point of board.body) occupied[index(point.x, point.y)] = 1;
	for (const point of board.obstacles) occupied[index(point.x, point.y)] = 1;
	const appleCell = board.apple ? index(board.apple.x, board.apple.y) : null;
	const regions: ObservedRegion[] = [];
	// Row-major order (top to bottom, left to right), never ranked by size.
	for (let start = 0; start < cellCount; start++) {
		if (occupied[start] || regionAt[start] !== -1) continue;
		const regionId = regions.length;
		const region: ObservedRegion = { cells: 0, containsApple: false };
		regions.push(region);
		let read = 0;
		let write = 1;
		queue[0] = start;
		regionAt[start] = regionId;
		while (read < write) {
			const cell = queue[read++];
			region.cells++;
			if (cell === appleCell) region.containsApple = true;
			const x = cell % width;
			const y = Math.floor(cell / width);
			for (const direction of directions) {
				const vector = vectors[direction];
				const nx = x + vector.x;
				const ny = y + vector.y;
				if (!inside(nx, ny)) continue;
				const neighbor = index(nx, ny);
				if (occupied[neighbor] || regionAt[neighbor] !== -1) continue;
				regionAt[neighbor] = regionId;
				queue[write++] = neighbor;
			}
		}
	}
	const moves = Object.fromEntries(
		directions.map((direction) => {
			const step = entries[direction];
			if (!step.legal)
				return [
					direction,
					{
						entry: "blocked",
						region: null,
						openAdjacentDirections: [],
						openAdjacentCells: 0,
					} satisfies ObservedSpaceMove,
				];
			const { target } = step;
			const tail = board.body[board.body.length - 1];
			const tailEntry = target.x === tail.x && target.y === tail.y;
			const openAdjacentDirections = directions.filter((candidate) => {
				const vector = vectors[candidate];
				const x = target.x + vector.x;
				const y = target.y + vector.y;
				return inside(x, y) && !occupied[index(x, y)];
			});
			return [
				direction,
				{
					entry: tailEntry ? "vacating_tail" : "open_cell",
					region: tailEntry
						? null
						: regions[regionAt[index(target.x, target.y)]],
					openAdjacentDirections,
					openAdjacentCells: openAdjacentDirections.length,
				} satisfies ObservedSpaceMove,
			];
		}),
	) as Record<Direction, ObservedSpaceMove>;
	return { basis: "current_occupancy", regions, moves };
}
