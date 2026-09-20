import { performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import { createState, inspectMove, move } from "../server/game/engine.js";
import { searchLocalMoves } from "../server/jev/bounded-search.js";
import type { LocalSearchEvidence } from "../shared/snake/bounded-search.js";
import {
	directions,
	type Direction,
	type MatchState,
} from "../shared/snake/types.js";
import oom from "./fixtures/board-v6-oom-tick275.json";

function board(seed = "bounded-search"): MatchState {
	const state = createState(
		"bounded",
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

// Geometry at seq303/tick150 of 73882ce7-46cb-44fd-95db-e36287f991a2.
function turn150(): MatchState {
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
	return state;
}

function verifyWitnesses(state: MatchState, evidence: LocalSearchEvidence) {
	for (const direction of directions) {
		const result = evidence.moves[direction];
		expect(result.expandedNodes).toBeLessThanOrEqual(result.nodeBudget);
		expect(result.maxDepthReached).toBeLessThanOrEqual(evidence.maxDepth);
		if (result.status !== "apple_reachable")
			expect(result.appleExitDirections).toBeNull();
		if (!result.witness) continue;
		expect(result.witness[0]).toBe(direction);
		expect(result.witness.length).toBeLessThanOrEqual(result.maxDepthReached);
		const replay = structuredClone(state);
		for (const [index, action] of result.witness.entries()) {
			expect(inspectMove(replay, action).immediateCollision).toBeNull();
			const event = move(replay, action);
			if (event.type === "apple" || event.type === "won")
				expect(index).toBe(result.witness.length - 1);
		}
		if (result.status === "survival_found") {
			expect(replay.applesEaten).toBe(state.applesEaten);
			expect(
				directions.some(
					(d) => inspectMove(replay, d).immediateCollision === null,
				),
			).toBe(true);
		} else {
			expect(replay.applesEaten).toBe(state.applesEaten + 1);
			expect(replay.status === "won").toBe(result.status === "win_reachable");
			if (result.status === "apple_reachable")
				expect(result.appleExitDirections).toEqual(
					directions.filter(
						(d) => inspectMove(replay, d).immediateCollision === null,
					),
				);
		}
	}
	expect(evidence.expandedNodes).toBe(
		Object.values(evidence.moves).reduce(
			(sum, result) => sum + result.expandedNodes,
			0,
		),
	);
	expect(evidence.expandedNodes).toBeLessThanOrEqual(evidence.maxNodes);
}

test("tick153 proves the up branch dead and verifies an executable left apple route", () => {
	const state = turn150();
	for (let index = 0; index < 3; index++) move(state, "up");
	const before = structuredClone(state);
	const evidence = searchLocalMoves(state);
	expect(evidence.moves.up).toMatchObject({
		status: "proven_dead",
		cutoff: "none",
		witness: null,
		maxDepthReached: 6,
	});
	expect(evidence.moves.left).toMatchObject({
		status: "apple_reachable",
		cutoff: "apple",
		witness: ["left", "up", "right", "right", "right", "right"],
	});
	verifyWitnesses(state, evidence);
	expect(state).toEqual(before);
});

test("tick150 retains uncertainty at depth8 instead of labelling its upward detour dead", () => {
	const state = turn150();
	const evidence = searchLocalMoves(state);
	expect(evidence.moves.up.status).toBe("survival_found");
	expect(evidence.moves.up.cutoff).toBe("depth");
	expect(evidence.moves.up.witness).toHaveLength(8);
	expect(evidence.moves.down.status).toBe("survival_found");
	verifyWitnesses(state, evidence);
});

test("an early completed candidate does not lend its unused budget to another direction", () => {
	const state = turn150();
	for (let index = 0; index < 3; index++) move(state, "up");
	const evidence = searchLocalMoves(state, { maxDepth: 8, maxNodes: 90 });
	expect(evidence.moves.up).toMatchObject({
		status: "proven_dead",
		nodeBudget: 45,
		expandedNodes: 35,
	});
	expect(evidence.moves.left).toMatchObject({
		status: "survival_found",
		nodeBudget: 45,
		expandedNodes: 45,
		cutoff: "nodes",
	});
	expect(evidence.expandedNodes).toBe(80);
	verifyWitnesses(state, evidence);
});

test("node budgets are equal per legal first move, including unused remainder and zero budgets", () => {
	const state = turn150();
	for (const maxNodes of [0, 1, 3]) {
		const evidence = searchLocalMoves(state, { maxDepth: 8, maxNodes });
		for (const direction of ["up", "down"] as const) {
			const result = evidence.moves[direction];
			expect(result.nodeBudget).toBe(Math.floor(maxNodes / 2));
			expect(result.cutoff).toBe("nodes");
			expect(result.expandedNodes).toBe(result.nodeBudget);
			expect(result.status).toBe(maxNodes < 2 ? "unknown" : "survival_found");
		}
		for (const direction of ["right", "left"] as const)
			expect(evidence.moves[direction]).toEqual({
				status: "blocked",
				nodeBudget: 0,
				expandedNodes: 0,
				maxDepthReached: 0,
				cutoff: "none",
				witness: null,
				appleExitDirections: null,
			});
		verifyWitnesses(state, evidence);
	}
});

function corridor(): MatchState {
	const state = board();
	state.config.height = 1;
	state.snake = [
		{ x: 2, y: 0 },
		{ x: 1, y: 0 },
		{ x: 0, y: 0 },
	];
	state.direction = "right";
	state.apple = { x: 6, y: 0 };
	return state;
}

test("iterative deepening counts repeated expansions and only reports actual cutoffs", () => {
	const state = corridor();
	const atDepth = searchLocalMoves(state, { maxDepth: 2, maxNodes: 3 });
	expect(atDepth.moves.right).toEqual({
		status: "survival_found",
		nodeBudget: 3,
		expandedNodes: 3,
		maxDepthReached: 2,
		cutoff: "depth",
		witness: ["right", "right"],
		appleExitDirections: null,
	});
	const atNodes = searchLocalMoves(state, { maxDepth: 3, maxNodes: 3 });
	expect(atNodes.moves.right).toEqual({
		...atDepth.moves.right,
		cutoff: "nodes",
	});
	const midPass = searchLocalMoves(state, { maxDepth: 3, maxNodes: 5 });
	expect(midPass.moves.right).toMatchObject({
		expandedNodes: 5,
		maxDepthReached: 2,
		cutoff: "nodes",
		witness: ["right", "right"],
	});
	for (const evidence of [atDepth, atNodes, midPass])
		verifyWitnesses(state, evidence);
});

test("a fully explored dead leaf is proven even when it uses the final budget node", () => {
	const state = board();
	state.config.height = 2;
	state.snake = [
		{ x: 3, y: 0 },
		{ x: 2, y: 0 },
		{ x: 1, y: 0 },
	];
	state.direction = "right";
	state.obstacles = [
		{ x: 4, y: 0 },
		{ x: 2, y: 1 },
		{ x: 4, y: 1 },
	];
	state.apple = { x: 6, y: 0 };
	expect(
		searchLocalMoves(state, { maxDepth: 1, maxNodes: 1 }).moves.down,
	).toEqual({
		status: "proven_dead",
		nodeBudget: 1,
		expandedNodes: 1,
		maxDepthReached: 1,
		cutoff: "none",
		witness: null,
		appleExitDirections: null,
	});
});

test("non-growing tail entries execute correctly and repeated body cycles are not deaths", () => {
	const state = board();
	state.snake = [
		{ x: 1, y: 1 },
		{ x: 2, y: 1 },
		{ x: 2, y: 2 },
		{ x: 1, y: 2 },
	];
	state.direction = "left";
	state.apple = { x: 6, y: 3 };
	state.obstacles = [];
	for (let y = 0; y < state.config.height; y++)
		for (let x = 0; x < state.config.width; x++)
			if (
				!state.snake.some((p) => p.x === x && p.y === y) &&
				!(x === 6 && y === 3)
			)
				state.obstacles.push({ x, y });
	const before = structuredClone(state);
	const evidence = searchLocalMoves(state);
	expect(evidence.moves.down).toMatchObject({
		status: "survival_found",
		cutoff: "depth",
		expandedNodes: 36,
		maxDepthReached: 8,
		witness: ["down", "right", "up", "left", "down", "right", "up", "left"],
	});
	verifyWitnesses(state, evidence);
	expect(state).toEqual(before);
	// The engine does not release the tail if an apple would grow this move.
	state.apple = { ...state.snake[state.snake.length - 1] };
	expect(searchLocalMoves(state).moves.down.status).toBe("blocked");
});

test("growth with no legal continuation is a terminal dead leaf without exploring a new apple", () => {
	const state = board();
	state.config.height = 3;
	state.snake = [
		{ x: 1, y: 0 },
		{ x: 1, y: 1 },
		{ x: 0, y: 1 },
		{ x: 0, y: 2 },
	];
	state.direction = "up";
	state.obstacles = [{ x: 2, y: 0 }];
	state.apple = { x: 0, y: 0 };
	const before = structuredClone(state);
	const evidence = searchLocalMoves(state);
	expect(evidence.moves.left).toMatchObject({
		status: "proven_dead",
		cutoff: "none",
		witness: null,
		appleExitDirections: null,
		expandedNodes: 1,
		maxDepthReached: 1,
	});
	verifyWitnesses(state, evidence);
	const replay = structuredClone(state);
	move(replay, "left");
	expect(
		directions.every((d) => inspectMove(replay, d).immediateCollision !== null),
	).toBe(true);
	expect(state).toEqual(before);
});

test("an apple endpoint retains its tail, which may release on the following move", () => {
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
	const evidence = searchLocalMoves(state);
	expect(evidence.moves.left).toMatchObject({
		status: "apple_reachable",
		cutoff: "apple",
		witness: ["left"],
		appleExitDirections: ["down"],
		expandedNodes: 1,
	});
	verifyWitnesses(state, evidence);
});

test("seed1 tick28 backtracks past trapped apple leaves within the same candidate budget", () => {
	// Actual final request geometry in seed-1-v9.jsonl, paired run 2026-09-20.
	const state = board();
	Object.assign(state.config, { width: 8, height: 6, obstacleCount: 1 });
	state.tick = 28;
	state.snake = [
		[0, 1],
		[1, 1],
		[1, 0],
		[2, 0],
		[3, 0],
		[4, 0],
		[5, 0],
		[5, 1],
	].map(([x, y]) => ({ x, y }));
	state.direction = "left";
	state.obstacles = [{ x: 1, y: 3 }];
	state.apple = { x: 0, y: 0 };
	const evidence = searchLocalMoves(state);
	expect(evidence.expandedNodes).toBe(449);
	expect(evidence.moves.up).toMatchObject({
		status: "proven_dead",
		cutoff: "none",
		witness: null,
		appleExitDirections: null,
		expandedNodes: 1,
	});
	expect(evidence.moves.down).toMatchObject({
		status: "survival_found",
		cutoff: "depth",
		expandedNodes: 448,
		maxDepthReached: 8,
		appleExitDirections: null,
	});
	verifyWitnesses(state, evidence);
	const previousRoute: Direction[] = [
		"down",
		"right",
		"right",
		"up",
		"up",
		"left",
		"left",
	];
	const replay = structuredClone(state);
	for (const direction of previousRoute) {
		expect(inspectMove(replay, direction).immediateCollision).toBeNull();
		move(replay, direction);
	}
	expect(replay.applesEaten).toBe(state.applesEaten + 1);
	expect(
		directions.every((d) => inspectMove(replay, d).immediateCollision !== null),
	).toBe(true);
	const deeper = searchLocalMoves(state, { maxDepth: 9, maxNodes: 5000 });
	expect(deeper.moves.down).toMatchObject({
		status: "apple_reachable",
		cutoff: "apple",
		expandedNodes: 489,
		witness: [
			"down",
			"right",
			"right",
			"up",
			"right",
			"up",
			"left",
			"left",
			"left",
		],
		appleExitDirections: ["down"],
	});
	verifyWitnesses(state, deeper);
});

test("one-step board completion is a verified win, not an unknown future apple", () => {
	const state = corridor();
	state.snake = [5, 4, 3, 2, 1, 0].map((x) => ({ x, y: 0 }));
	const evidence = searchLocalMoves(state);
	expect(evidence.moves.right).toMatchObject({
		status: "win_reachable",
		cutoff: "none",
		witness: ["right"],
		expandedNodes: 1,
		maxDepthReached: 1,
	});
	verifyWitnesses(state, evidence);
});

test("stars do not create growth or terminate the search for the observed apple", () => {
	const state = corridor();
	state.config.width = 8;
	state.star = { point: { x: 3, y: 0 }, expiresAt: 8000 };
	const evidence = searchLocalMoves(state);
	expect(evidence.moves.right).toMatchObject({
		status: "apple_reachable",
		witness: ["right", "right", "right", "right"],
		expandedNodes: 10,
	});
	verifyWitnesses(state, evidence);
});

// Independent shallow reference: clone and execute the real game engine for
// every legal branch, rather than reproducing the ring/undo implementation.
function reference(state: MatchState, first: Direction, maxDepth: number) {
	if (inspectMove(state, first).immediateCollision) return "blocked";
	let apple = false;
	let win = false;
	let frontier = false;
	function visit(source: MatchState, direction: Direction, depth: number) {
		const next = structuredClone(source);
		const event = move(next, direction);
		if (event.type === "won") {
			win = true;
			return;
		}
		if (event.type === "apple") {
			// The immediate legal exits are independent of the unknown respawn.
			if (
				directions.some((d) => inspectMove(next, d).immediateCollision === null)
			)
				apple = true;
			return;
		}
		const legal = directions.filter(
			(d) => inspectMove(next, d).immediateCollision === null,
		);
		if (legal.length === 0) return;
		if (depth === maxDepth) {
			frontier = true;
			return;
		}
		for (const action of legal) visit(next, action, depth + 1);
	}
	visit(state, first, 1);
	return win
		? "win_reachable"
		: apple
			? "apple_reachable"
			: frontier
				? "survival_found"
				: "proven_dead";
}

test("shallow results and every witness agree with the actual engine across generated boards", () => {
	for (let seed = 0; seed < 16; seed++) {
		const state = board(`reference-${seed}`);
		const evidence = searchLocalMoves(state, { maxDepth: 4, maxNodes: 5000 });
		for (const direction of directions)
			expect(evidence.moves[direction].status, `${seed}:${direction}`).toBe(
				reference(state, direction, 4),
			);
		verifyWitnesses(state, evidence);
	}
});

test("the historical OOM board stays within the explicit node budget and returns engine-valid witnesses", () => {
	const state = Object.assign(board(), structuredClone(oom)) as MatchState;
	const before = structuredClone(state);
	const start = performance.now();
	const evidence = searchLocalMoves(state);
	expect(performance.now() - start).toBeLessThan(1000);
	verifyWitnesses(state, evidence);
	expect(state).toEqual(before);
});

test.each([
	{ maxDepth: 0, maxNodes: 5 },
	{ maxDepth: -1, maxNodes: 5 },
	{ maxDepth: 1.5, maxNodes: 5 },
	{ maxDepth: 8, maxNodes: -1 },
	{ maxDepth: 8, maxNodes: 1.5 },
	{ maxDepth: Infinity, maxNodes: 5 },
])(
	"invalid options throw instead of silently changing the budget: %j",
	(options) => {
		expect(() => searchLocalMoves(board(), options)).toThrow(RangeError);
	},
);
