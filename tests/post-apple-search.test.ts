import { performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import { createState, inspectMove, move } from "../server/game/engine.js";
import { searchLocalMoves } from "../server/jev/bounded-search.js";
import { searchPostAppleMoves } from "../server/jev/post-apple-search.js";
import type { PostAppleSearchEvidence } from "../shared/snake/post-apple-search.js";
import { directions, type MatchState } from "../shared/snake/types.js";
import oom from "./fixtures/board-v6-oom-tick275.json";
import live559 from "./fixtures/post-apple-live-559.json";

function board(seed = "post-apple"): MatchState {
	const state = createState(
		"post-apple",
		"test",
		null,
		{
			width: 7,
			height: 4,
			obstacleCount: 0,
			seed,
			stepMode: "response",
			tickIntervalMs: null,
		},
		"now",
	);
	state.status = "running";
	state.star = null;
	return state;
}

// Minimal geometry from validated-20260920/seed-0-v9.jsonl, request tick99.
function seed99(): MatchState {
	const state = board();
	Object.assign(state.config, { width: 8, height: 6, obstacleCount: 1 });
	state.tick = 99;
	state.snake = [
		[0, 2],
		[1, 2],
		[2, 2],
		[3, 2],
		[3, 1],
		[3, 0],
		[4, 0],
		[5, 0],
		[6, 0],
		[6, 1],
		[7, 1],
		[7, 2],
		[6, 2],
		[5, 2],
		[4, 2],
		[4, 3],
		[4, 4],
		[3, 4],
	].map(([x, y]) => ({ x, y }));
	state.direction = "left";
	state.obstacles = [{ x: 2, y: 3 }];
	state.apple = { x: 0, y: 0 };
	return state;
}

// c2ce62cb-6021-4003-8ebc-36c3d07234b0, seq1138/tick565 provider observation.
function live565(): MatchState {
	const state = board();
	Object.assign(state.config, { width: 20, height: 15, obstacleCount: 8 });
	state.tick = 565;
	state.snake = [
		[19, 7],
		[19, 8],
		[19, 9],
		[19, 10],
		[19, 11],
		[19, 12],
		[19, 13],
		[18, 13],
		[17, 13],
		[17, 12],
		[17, 11],
		[17, 10],
		[17, 9],
		[17, 8],
		[17, 7],
		[17, 6],
		[17, 5],
		[18, 5],
		[19, 5],
		[19, 4],
		[19, 3],
		[18, 3],
		[18, 2],
		[18, 1],
		[17, 1],
		[16, 1],
		[15, 1],
	].map(([x, y]) => ({ x, y }));
	state.direction = "up";
	state.obstacles = [
		[15, 12],
		[3, 4],
		[13, 13],
		[1, 2],
		[7, 13],
		[9, 6],
		[13, 9],
		[10, 8],
	].map(([x, y]) => ({ x, y }));
	state.apple = { x: 18, y: 7 };
	return state;
}

function validateEvidence(
	state: MatchState,
	evidence: PostAppleSearchEvidence,
) {
	const legalCount = directions.filter(
		(d) => inspectMove(state, d).immediateCollision === null,
	).length;
	let total = 0;
	for (const direction of directions) {
		const result = evidence.moves[direction];
		total += result.expandedNodes;
		expect(result.expandedNodes).toBeLessThanOrEqual(result.nodeBudget);
		expect(result.postAppleExpandedNodes).toBeLessThanOrEqual(
			result.expandedNodes,
		);
		expect(result.rejectedAppleEndpoints).toBeLessThanOrEqual(
			result.expandedNodes - result.postAppleExpandedNodes,
		);
		expect(result.maxDepthReached).toBeLessThanOrEqual(evidence.maxDepth);
		expect(result.nodeBudget).toBe(
			result.status === "blocked"
				? 0
				: Math.floor(evidence.maxNodes / legalCount),
		);
		if (result.status !== "apple_reachable") {
			expect(result.postApple).toBeNull();
			expect(result.appleExitDirections).toBeNull();
		}
		if (!result.witness) continue;
		expect(result.witness[0]).toBe(direction);
		const replay = structuredClone(state);
		for (const [index, action] of result.witness.entries()) {
			expect(inspectMove(replay, action).immediateCollision).toBeNull();
			const event = move(replay, action);
			if (event.type === "apple" || event.type === "won")
				expect(index).toBe(result.witness.length - 1);
		}
		if (result.status === "apple_reachable") {
			expect(replay.applesEaten).toBe(state.applesEaten + 1);
			expect(result.appleExitDirections).toEqual(
				directions.filter(
					(d) => inspectMove(replay, d).immediateCollision === null,
				),
			);
			expect(result.postApple!.assumption).toBe("no_further_growth");
			expect(result.postApple!.maxDepth).toBe(
				evidence.maxDepth - result.witness.length,
			);
			expect(result.postApple!.expandedNodes).toBeLessThanOrEqual(
				result.postAppleExpandedNodes,
			);
			expect(
				result.postApple!.maxDepthReached + result.witness.length,
			).toBeLessThanOrEqual(result.maxDepthReached);
		} else if (result.status === "win_reachable")
			expect(replay.status).toBe("won");
		else {
			expect(replay.applesEaten).toBe(state.applesEaten);
			expect(
				directions.some(
					(d) => inspectMove(replay, d).immediateCollision === null,
				),
			).toBe(true);
		}
	}
	expect(total).toBe(evidence.expandedNodes);
	expect(total).toBeLessThanOrEqual(evidence.maxNodes);
}

// Independent proof oracle. It clones and executes the actual engine, clears
// the unknown next food, and never exceeds 5000 visited continuation nodes.
function referenceDeath(source: MatchState, maxDepth: number) {
	let nodes = 0;
	const originalApple = source.apple;
	function visit(
		state: MatchState,
		depth: number,
		eatenAt: number | null,
	): boolean {
		if (++nodes > 5000)
			throw new Error("Reference proof exceeded its explicit node budget");
		if (eatenAt !== null) {
			const needed =
				state.config.width * state.config.height -
				state.obstacles.length -
				state.snake.length;
			if (needed === 0 || depth - eatenAt >= needed) return false;
		}
		const legal = directions.filter(
			(d) => inspectMove(state, d).immediateCollision === null,
		);
		if (legal.length === 0) return true;
		if (depth === maxDepth) return false;
		for (const direction of legal) {
			const next = structuredClone(state);
			const event = move(next, direction);
			if (event.type === "won") return false;
			const ate = originalApple !== null && event.type === "apple";
			if (ate) next.apple = null;
			if (!visit(next, depth + 1, ate ? depth + 1 : eatenAt)) return false;
		}
		return true;
	}
	return {
		dead: visit(structuredClone(source), 0, null),
		get nodes() {
			return nodes;
		},
	};
}

test("seedA tick99 rejects the apple route that inevitably dies several moves after growth", () => {
	const state = seed99();
	const before = structuredClone(state);
	expect(searchLocalMoves(state).moves.up.status).toBe("apple_reachable");
	const evidence = searchPostAppleMoves(state, { maxDepth: 8, maxNodes: 5000 });
	expect(evidence.moves.up).toMatchObject({
		status: "proven_dead",
		cutoff: "none",
		witness: null,
	});
	expect(evidence.moves.up.postAppleExpandedNodes).toBeGreaterThan(0);
	expect(evidence.moves.up.rejectedAppleEndpoints).toBeGreaterThan(1);
	expect(evidence.moves.down).toMatchObject({
		status: "survival_found",
		cutoff: "depth",
	});
	const committed = structuredClone(state);
	move(committed, "up");
	expect(referenceDeath(committed, 7).dead).toBe(true);
	validateEvidence(state, evidence);
	expect(state).toEqual(before);
});

test("seedA tick100 and live565 remain dead for every food placement without reading future RNG", () => {
	const seed = seed99();
	move(seed, "up");
	for (const state of [seed, live565()]) {
		const original = searchLocalMoves(state);
		expect(
			Object.values(original.moves).some((m) => m.status === "apple_reachable"),
		).toBe(true);
		const evidence = searchPostAppleMoves(state);
		expect(
			Object.values(evidence.moves).every((m) =>
				["blocked", "proven_dead"].includes(m.status),
			),
		).toBe(true);
		expect(referenceDeath(state, 8).dead).toBe(true);
		validateEvidence(state, evidence);
		const differentRng = { ...state, rngState: state.rngState ^ 0xffffffff };
		expect(searchPostAppleMoves(differentRng)).toEqual(evidence);
	}
});

test("depth16 catches the first fatal live559 turn without increasing the total node budget", () => {
	const state = board();
	Object.assign(state.config, live559.config);
	Object.assign(state, {
		tick: live559.source.tick,
		snake: structuredClone(live559.snake),
		direction: live559.direction,
		obstacles: structuredClone(live559.obstacles),
		apple: structuredClone(live559.apple),
		star: live559.star,
	});
	const before = structuredClone(state);
	const shallow = searchPostAppleMoves(state, { maxDepth: 8, maxNodes: 5000 });
	expect(shallow.moves.up).toMatchObject({
		status: "apple_reachable",
		postApple: { maxDepth: 1, maxDepthReached: 1, cutoff: "depth" },
	});
	const deeper = searchPostAppleMoves(state, { maxDepth: 16, maxNodes: 5000 });
	const currentDefault = searchPostAppleMoves(state);
	expect(currentDefault.maxDepth).toBe(32);
	expect(currentDefault.maxNodes).toBe(5000);
	expect(currentDefault.moves.up.status).toBe("proven_dead");
	expect(currentDefault.moves.down.status).toBe("survival_found");
	expect(searchLocalMoves(state).maxDepth).toBe(8);
	expect(deeper.moves.up).toMatchObject({
		status: "proven_dead",
		expandedNodes: 2062,
		postAppleExpandedNodes: 1006,
		maxDepthReached: 14,
	});
	expect(deeper.moves.down).toMatchObject({
		status: "survival_found",
		cutoff: "nodes",
		nodeBudget: 2500,
		expandedNodes: 2500,
		maxDepthReached: 14,
	});
	expect(deeper.expandedNodes).toBe(4562);
	const committed = structuredClone(state);
	move(committed, "up");
	expect(referenceDeath(committed, 15).dead).toBe(true);
	validateEvidence(state, deeper);
	expect(state).toEqual(before);
});

function almostFilled(): MatchState {
	const state = board();
	state.config.height = 1;
	state.snake = [3, 2, 1, 0].map((x) => ({ x, y: 0 }));
	state.direction = "right";
	state.apple = { x: 4, y: 0 };
	return state;
}

test("possible earlier victory prevents a false death proof at the exact remaining-growth boundary", () => {
	const state = almostFilled();
	const evidence = searchPostAppleMoves(state, { maxDepth: 8, maxNodes: 5000 });
	expect(evidence.moves.right).toMatchObject({
		status: "apple_reachable",
		cutoff: "apple",
		witness: ["right"],
		expandedNodes: 3,
		postAppleExpandedNodes: 2,
		maxDepthReached: 3,
		postApple: {
			result: "unknown",
			cutoff: "possible_win",
			maxDepth: 7,
			maxDepthReached: 2,
			expandedNodes: 2,
		},
	});
	const possible = structuredClone(state);
	move(possible, "right");
	// Existential placements, not a prediction or reading of the future RNG.
	possible.apple = { x: 5, y: 0 };
	move(possible, "right");
	possible.apple = { x: 6, y: 0 };
	expect(move(possible, "right").type).toBe("won");
	validateEvidence(state, evidence);
});

test("zero post-apple depth and exhausted shared nodes explicitly retain uncertainty", () => {
	const state = almostFilled();
	const zeroDepth = searchPostAppleMoves(state, { maxDepth: 1, maxNodes: 100 });
	expect(zeroDepth.moves.right.postApple).toMatchObject({
		result: "unknown",
		cutoff: "depth",
		maxDepth: 0,
		maxDepthReached: 0,
		expandedNodes: 0,
	});
	for (const maxNodes of [1, 2]) {
		const evidence = searchPostAppleMoves(state, { maxDepth: 8, maxNodes });
		expect(evidence.moves.right).toMatchObject({
			status: "apple_reachable",
			expandedNodes: maxNodes,
			postAppleExpandedNodes: maxNodes - 1,
			postApple: {
				result: "unknown",
				cutoff: "nodes",
				expandedNodes: maxNodes - 1,
				maxDepthReached: maxNodes - 1,
			},
		});
		validateEvidence(state, evidence);
	}
	const frontier = searchPostAppleMoves(state, { maxDepth: 2, maxNodes: 100 });
	expect(frontier.moves.right.postApple).toMatchObject({
		result: "survival_possible",
		cutoff: "depth",
		maxDepth: 1,
		maxDepthReached: 1,
		expandedNodes: 1,
	});
	validateEvidence(state, zeroDepth);
	validateEvidence(state, frontier);
});

test("winning now skips post-apple uncertainty and immediate trapping rejects without extra expansion", () => {
	const won = almostFilled();
	won.snake = [5, 4, 3, 2, 1, 0].map((x) => ({ x, y: 0 }));
	won.apple = { x: 6, y: 0 };
	expect(searchPostAppleMoves(won).moves.right).toMatchObject({
		status: "win_reachable",
		postApple: null,
		postAppleExpandedNodes: 0,
		rejectedAppleEndpoints: 0,
		expandedNodes: 1,
	});
	const trapped = board();
	trapped.config.height = 3;
	trapped.snake = [
		{ x: 1, y: 0 },
		{ x: 1, y: 1 },
		{ x: 0, y: 1 },
		{ x: 0, y: 2 },
	];
	trapped.direction = "up";
	trapped.obstacles = [{ x: 2, y: 0 }];
	trapped.apple = { x: 0, y: 0 };
	expect(searchPostAppleMoves(trapped).moves.left).toMatchObject({
		status: "proven_dead",
		postApple: null,
		postAppleExpandedNodes: 0,
		rejectedAppleEndpoints: 1,
		expandedNodes: 1,
	});
});

test("the grown optimistic body releases its tail during each checked continuation", () => {
	const state = board();
	state.config.height = 2;
	state.snake = [
		{ x: 1, y: 0 },
		{ x: 1, y: 1 },
		{ x: 0, y: 1 },
	];
	state.direction = "up";
	state.obstacles = [{ x: 2, y: 0 }];
	state.apple = { x: 0, y: 0 };
	const evidence = searchPostAppleMoves(state, { maxDepth: 8, maxNodes: 5000 });
	expect(evidence.moves.left).toMatchObject({
		status: "apple_reachable",
		appleExitDirections: ["down"],
		postApple: {
			assumption: "no_further_growth",
			result: "survival_possible",
			cutoff: "depth",
			maxDepthReached: 7,
		},
	});
	validateEvidence(state, evidence);
});

test("all prefix and repeated endpoint checks share the same fair candidate budgets", () => {
	const state = seed99();
	for (const maxNodes of [0, 1, 3, 12, 60, 150, 5000]) {
		const evidence = searchPostAppleMoves(state, { maxDepth: 8, maxNodes });
		validateEvidence(state, evidence);
		expect(evidence.moves.up.nodeBudget).toBe(Math.floor(maxNodes / 2));
		expect(evidence.moves.down.nodeBudget).toBe(Math.floor(maxNodes / 2));
		if (maxNodes < 2)
			expect(evidence.moves.up).toMatchObject({
				status: "unknown",
				cutoff: "nodes",
				expandedNodes: 0,
				postAppleExpandedNodes: 0,
			});
	}
});

test("generated small-board death conclusions agree with independent real-engine proofs", () => {
	for (let seed = 0; seed < 12; seed++) {
		const state = board(`post-proof-${seed}`);
		const evidence = searchPostAppleMoves(state, {
			maxDepth: 4,
			maxNodes: 5000,
		});
		for (const direction of directions) {
			if (inspectMove(state, direction).immediateCollision) continue;
			const next = structuredClone(state);
			const first = move(next, direction);
			if (first.type === "apple" || first.type === "won") continue;
			expect(evidence.moves[direction].status === "proven_dead").toBe(
				referenceDeath(next, 3).dead,
			);
		}
		validateEvidence(state, evidence);
	}
});

test("the historical OOM board stays bounded after including post-apple work", () => {
	const state = Object.assign(board(), structuredClone(oom)) as MatchState;
	const before = structuredClone(state);
	const start = performance.now();
	const evidence = searchPostAppleMoves(state);
	expect(performance.now() - start).toBeLessThan(1000);
	validateEvidence(state, evidence);
	expect(state).toEqual(before);
});

test("depth32 keeps its shared 5000-node ceiling over 300 seeded boards", () => {
	const sizes = [
		[8, 6],
		[10, 8],
		[12, 9],
		[16, 12],
		[20, 15],
		[24, 18],
	];
	for (let seed = 0; seed < 300; seed++) {
		const [width, height] = sizes[seed % sizes.length];
		const state = createState(
			`depth32-${seed}`,
			"test",
			null,
			{
				width,
				height,
				obstacleCount: Math.floor((width * height) / 36),
				seed: `depth32-budget-${seed}`,
				layoutVersion: 2,
				stepMode: "response",
				tickIntervalMs: null,
			},
			"now",
		);
		state.status = "running";
		const evidence = searchPostAppleMoves(state, {
			maxDepth: 32,
			maxNodes: 5000,
		});
		validateEvidence(state, evidence);
	}
});

test.each([
	{ maxDepth: 0, maxNodes: 5 },
	{ maxDepth: 1.5, maxNodes: 5 },
	{ maxDepth: 8, maxNodes: -1 },
])("invalid budgets remain explicit failures: %j", (options) => {
	expect(() => searchPostAppleMoves(board(), options)).toThrow(RangeError);
});
