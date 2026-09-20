import { expect, test } from "vitest";
import { createState } from "../server/game/engine.js";
import { observedSpace } from "../server/jev/observed-space.js";
import { publicState, type PublicState } from "../shared/snake/types.js";

function board(): PublicState {
	return publicState(
		createState(
			"observed-space",
			"test",
			null,
			{
				width: 7,
				height: 4,
				obstacleCount: 0,
				seed: "observed-space",
				stepMode: "response",
				tickIntervalMs: null,
			},
			"now",
		),
	);
}

// Match 73882ce7-46cb-44fd-95db-e36287f991a2, seq303/tick150.
// Only observed geometry is retained; no model payload or analysis is copied.
function turn150(): PublicState {
	const state = board();
	Object.assign(state.config, { width: 12, height: 9, obstacleCount: 3 });
	state.tick = 150;
	state.direction = "right";
	state.snake = [
		[5, 5],
		[4, 5],
		[3, 5],
		[3, 4],
		[2, 4],
		[1, 4],
		[1, 3],
		[1, 2],
		[1, 1],
		[2, 1],
		[2, 0],
		[3, 0],
		[4, 0],
		[5, 0],
		[6, 0],
		[6, 1],
		[6, 2],
		[6, 3],
		[6, 4],
		[6, 5],
		[6, 6],
	].map(([x, y]) => ({ x, y }));
	state.obstacles = [
		{ x: 4, y: 3 },
		{ x: 10, y: 2 },
		{ x: 2, y: 2 },
	];
	state.apple = { x: 8, y: 1 };
	state.star = { point: { x: 11, y: 4 }, expiresAt: 59680.173458000005 };
	return state;
}

function turn153(): PublicState {
	const state = turn150();
	state.tick = 153;
	state.direction = "up";
	state.snake = [
		{ x: 5, y: 2 },
		{ x: 5, y: 3 },
		{ x: 5, y: 4 },
		...state.snake.slice(0, -3),
	];
	return state;
}

test("tick150 reports both current regions without calling the smaller one fatal", () => {
	const state = turn150();
	const before = structuredClone(state);
	const result = observedSpace(state);
	expect(result.basis).toBe("current_occupancy");
	expect(result.regions).toEqual([
		{ cells: 73, containsApple: true },
		{ cells: 11, containsApple: false },
	]);
	expect(result.moves.up).toEqual({
		entry: "open_cell",
		region: { cells: 11, containsApple: false },
		openAdjacentDirections: ["up", "left"],
		openAdjacentCells: 2,
	});
	expect(result.moves.down).toEqual({
		entry: "open_cell",
		region: { cells: 73, containsApple: true },
		openAdjacentDirections: ["down", "left"],
		openAdjacentCells: 2,
	});
	for (const direction of ["right", "left"] as const)
		expect(result.moves[direction]).toEqual({
			entry: "blocked",
			region: null,
			openAdjacentDirections: [],
			openAdjacentCells: 0,
		});
	expect(result.regions.reduce((sum, region) => sum + region.cells, 0)).toBe(
		12 * 9 - state.snake.length - state.obstacles.length,
	);
	expect(state).toEqual(before);
});

test("tick153 describes shared current occupancy without predicting the moving tail", () => {
	const state = turn153();
	const before = structuredClone(state);
	const result = observedSpace(state);
	expect(result.regions).toEqual([
		{ cells: 76, containsApple: true },
		{ cells: 7, containsApple: false },
		{ cells: 1, containsApple: false },
	]);
	expect(result.moves.up).toEqual({
		entry: "open_cell",
		region: { cells: 7, containsApple: false },
		openAdjacentDirections: ["left"],
		openAdjacentCells: 1,
	});
	expect(result.moves.left).toEqual({
		entry: "open_cell",
		region: { cells: 7, containsApple: false },
		openAdjacentDirections: ["up", "left"],
		openAdjacentCells: 2,
	});
	expect(result.moves.up.region).toBe(result.moves.left.region);
	expect(result.moves.right.entry).toBe("blocked");
	expect(result.moves.down.entry).toBe("blocked");
	expect(state).toEqual(before);
});

test("a non-growing tail entry has no current open region and uses unchanged occupancy", () => {
	const state = board();
	state.snake = [
		{ x: 1, y: 1 },
		{ x: 2, y: 1 },
		{ x: 2, y: 2 },
		{ x: 1, y: 2 },
	];
	state.direction = "left";
	state.obstacles = [{ x: 0, y: 1 }];
	state.apple = { x: 4, y: 1 };
	state.star = { point: { x: 1, y: 0 }, expiresAt: 8000 };
	const before = structuredClone(state);
	const result = observedSpace(state);
	expect(result.regions).toEqual([{ cells: 23, containsApple: true }]);
	expect(result.moves.down).toEqual({
		entry: "vacating_tail",
		region: null,
		openAdjacentDirections: ["down", "left"],
		openAdjacentCells: 2,
	});
	expect(result.moves.right.entry).toBe("blocked");
	expect(result.moves.left.entry).toBe("blocked");
	expect(result.moves.up).toEqual({
		entry: "open_cell",
		region: { cells: 23, containsApple: true },
		openAdjacentDirections: ["right", "left"],
		openAdjacentCells: 2,
	});
	expect(state).toEqual(before);
});

test("bounds exclude off-board neighbors while apples and stars remain open cells", () => {
	const state = board();
	state.config.height = 2;
	state.snake = [
		{ x: 0, y: 0 },
		{ x: 1, y: 0 },
		{ x: 2, y: 0 },
	];
	state.direction = "left";
	state.apple = { x: 0, y: 1 };
	state.star = { point: { x: 6, y: 1 }, expiresAt: 8000 };
	const result = observedSpace(state);
	expect(result.regions).toEqual([{ cells: 11, containsApple: true }]);
	expect(result.moves.down).toEqual({
		entry: "open_cell",
		region: { cells: 11, containsApple: true },
		openAdjacentDirections: ["right"],
		openAdjacentCells: 1,
	});
	for (const direction of ["up", "right", "left"] as const)
		expect(result.moves[direction]).toEqual({
			entry: "blocked",
			region: null,
			openAdjacentDirections: [],
			openAdjacentCells: 0,
		});
	state.apple = null;
	expect(observedSpace(state).regions).toEqual([
		{ cells: 11, containsApple: false },
	]);
});

test("regions retain row-major discovery order instead of ranking open space", () => {
	const state = board();
	state.config.height = 3;
	state.snake = [
		{ x: 4, y: 1 },
		{ x: 5, y: 1 },
		{ x: 6, y: 1 },
	];
	state.direction = "left";
	state.obstacles = [
		{ x: 2, y: 0 },
		{ x: 2, y: 1 },
		{ x: 2, y: 2 },
	];
	state.apple = { x: 0, y: 0 };
	state.star = { point: { x: 6, y: 2 }, expiresAt: 8000 };
	const result = observedSpace(state);
	expect(result.regions).toEqual([
		{ cells: 6, containsApple: true },
		{ cells: 9, containsApple: false },
	]);
	expect(result.moves.left.region).toBe(result.regions[1]);
});

test("a completely occupied board has no open regions", () => {
	const state = board();
	state.config.height = 1;
	state.snake = Array.from({ length: 7 }, (_, x) => ({ x, y: 0 }));
	state.direction = "left";
	state.apple = null;
	const result = observedSpace(state);
	expect(result.regions).toEqual([]);
	for (const move of Object.values(result.moves))
		expect(move).toEqual({
			entry: "blocked",
			region: null,
			openAdjacentDirections: [],
			openAdjacentCells: 0,
		});
});
