import { createState } from "../server/game/engine.js";
import branchedReplay from "./fixtures/branched-trap-replay.json" with { type: "json" };
export function baseState() {
	const state = createState(
		"context",
		"Test",
		null,
		{
			width: 24,
			height: 18,
			obstacleCount: 0,
			tickIntervalMs: 500,
			seed: "context",
		},
		"now",
	);
	state.status = "running";
	state.apple = { x: 23, y: 17 };
	return state;
}

// Actual observed geometry: match 899251a7-7e06-4cad-a9ee-d98a860b227b,
// event seq 733, tick 364, immediately before choosing left into the corridor.
export function deadEndReplay() {
	const state = baseState();
	state.tick = 364;
	state.seq = 733;
	state.direction = "up";
	state.apple = { x: 7, y: 17 };
	state.snake = [
		[11, 7],
		[11, 8],
		[10, 8],
		[9, 8],
		[8, 8],
		[7, 8],
		[6, 8],
		[5, 8],
		[4, 8],
		[4, 7],
		[4, 6],
		[5, 6],
		[6, 6],
		[7, 6],
		[8, 6],
		[9, 6],
		[10, 6],
		[11, 6],
		[12, 6],
		[13, 6],
		[14, 6],
		[15, 6],
		[16, 6],
		[17, 6],
		[18, 6],
		[19, 6],
		[19, 5],
		[19, 4],
	].map(([x, y]) => ({ x, y }));
	state.obstacles = [
		[8, 13],
		[1, 6],
		[1, 4],
		[20, 7],
		[17, 9],
		[10, 5],
		[11, 11],
		[5, 15],
		[7, 1],
		[20, 5],
		[4, 16],
		[17, 13],
	].map(([x, y]) => ({ x, y }));
	state.config.obstacleCount = state.obstacles.length;
	return state;
}

export function nearComplete() {
	const state = baseState();
	state.config.width = 7;
	state.config.height = 1;
	state.config.obstacleCount = 0;
	state.snake = [5, 4, 3, 2, 1, 0].map((x) => ({ x, y: 0 }));
	state.direction = "right";
	state.apple = { x: 6, y: 0 };
	return state;
}

// Match d6eb8e35-4828-4191-804f-8525055538b3, observed tick 1176.
export function branchedTrapReplay() {
	const state = baseState();
	const geometry = structuredClone(branchedReplay.geometry);
	Object.assign(state, geometry);
	return state;
}
export const contextFixtures = {
	opening: baseState,
	corridor: deadEndReplay,
	nearComplete,
};
