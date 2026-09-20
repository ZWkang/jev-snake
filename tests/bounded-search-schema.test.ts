import { describe, expect, test } from "vitest";
import { decisionBodyV6 } from "../server/jev/board-context.js";
import {
	decisionBodyV7,
	decisionBodyV8,
} from "../server/jev/search-context.js";
import type {
	DecisionRequestV9,
	LocalSearchEvidence,
} from "../shared/snake/bounded-search.js";
import { decisionRequestV9Schema } from "../shared/snake/context-v9-schema.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import { publicState, type PublicState } from "../shared/snake/types.js";
import { baseState } from "./context-fixture.js";

function observed(): PublicState {
	const state = publicState(baseState());
	state.config = {
		width: 8,
		height: 6,
		obstacleCount: 1,
		seed: "bounded-schema",
		stepMode: "response",
		tickIntervalMs: null,
	};
	state.snake = [
		{ x: 3, y: 2 },
		{ x: 2, y: 2 },
		{ x: 1, y: 2 },
	];
	state.direction = "right";
	state.obstacles = [{ x: 6, y: 5 }];
	state.apple = { x: 5, y: 2 };
	state.star = null;
	return state;
}

function evidence(): LocalSearchEvidence {
	return {
		algorithm: "iterative_deepening_dfs",
		foodBoundary: "stop_at_current_apple",
		maxDepth: 2,
		maxNodes: 36,
		expandedNodes: 9,
		moves: {
			up: {
				status: "survival_found",
				expandedNodes: 3,
				nodeBudget: 12,
				maxDepthReached: 2,
				cutoff: "depth",
				witness: ["up", "up"],
				appleExitDirections: null,
			},
			right: {
				status: "apple_reachable",
				expandedNodes: 3,
				nodeBudget: 12,
				maxDepthReached: 2,
				cutoff: "apple",
				witness: ["right", "right"],
				appleExitDirections: ["up", "right", "down"],
			},
			down: {
				status: "survival_found",
				expandedNodes: 3,
				nodeBudget: 12,
				maxDepthReached: 2,
				cutoff: "depth",
				witness: ["down", "down"],
				appleExitDirections: null,
			},
			left: {
				status: "blocked",
				expandedNodes: 0,
				nodeBudget: 0,
				maxDepthReached: 0,
				cutoff: "none",
				witness: null,
				appleExitDirections: null,
			},
		},
	};
}

function request(
	state = observed(),
	localSearch = evidence(),
): DecisionRequestV9 {
	const base = decisionBodyV8(state);
	return {
		...base,
		state: { ...base.state, contextVersion: "bounded-search-v9", localSearch },
	};
}

describe("bounded search evidence contract", () => {
	test("round-trips true apple and no-growth witnesses without altering the request", () => {
		const value = request();
		const original = structuredClone(value);
		expect(decisionRequestV9Schema.parse(value)).toEqual(original);
		expect(decisionRequestSchema.parse(value)).toEqual(original);
		expect(value).toEqual(original);
	});

	test("accepts a shared budget too small to expand any legal candidate", () => {
		const value = request();
		const search = value.state.localSearch;
		search.maxNodes = 2;
		search.expandedNodes = 0;
		for (const move of Object.values(search.moves)) {
			if (move.status === "blocked") continue;
			Object.assign(move, {
				status: "unknown",
				expandedNodes: 0,
				nodeBudget: 0,
				maxDepthReached: 0,
				cutoff: "nodes",
				witness: null,
				appleExitDirections: null,
			});
		}
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		search.maxNodes = 0;
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		search.moves.up.appleExitDirections = [];
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("retains a verified survival route after its node share is exhausted", () => {
		const value = request();
		const search = value.state.localSearch;
		search.maxNodes = 3;
		search.expandedNodes = 3;
		for (const [direction, move] of Object.entries(search.moves)) {
			if (move.status === "blocked") continue;
			Object.assign(move, {
				status: "survival_found",
				expandedNodes: 1,
				nodeBudget: 1,
				maxDepthReached: 1,
				cutoff: "nodes",
				witness: [direction],
				appleExitDirections: null,
			});
		}
		expect(decisionRequestSchema.parse(value)).toEqual(value);
	});

	test("accepts entering a tail cell that vacates on a non-growing move", () => {
		const state = observed();
		state.snake = [
			{ x: 1, y: 1 },
			{ x: 0, y: 1 },
			{ x: 0, y: 2 },
			{ x: 1, y: 2 },
		];
		const search = evidence();
		search.moves.up.witness = ["up", "right"];
		search.moves.right = { ...search.moves.up, witness: ["right", "down"] };
		search.moves.down.witness = ["down", "right"];
		const value = request(state, search);
		expect(value.state.immediateMoves.down.destination).toBe("vacating_tail");
		expect(decisionRequestSchema.parse(value)).toEqual(value);
	});

	test("accepts an actual terminal win and keeps it separate from an apple cutoff", () => {
		const state = observed();
		state.config = { ...state.config, width: 7, height: 1, obstacleCount: 0 };
		state.snake = [5, 4, 3, 2, 1, 0].map((x) => ({ x, y: 0 }));
		state.obstacles = [];
		state.apple = { x: 6, y: 0 };
		const search = evidence();
		search.expandedNodes = 1;
		search.moves.up = { ...search.moves.left };
		search.moves.down = { ...search.moves.left };
		search.moves.right = {
			status: "win_reachable",
			expandedNodes: 1,
			nodeBudget: 36,
			maxDepthReached: 1,
			cutoff: "none",
			witness: ["right"],
			appleExitDirections: null,
		};
		const value = request(state, search);
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		search.moves.right.appleExitDirections = [];
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		search.moves.right.appleExitDirections = null;
		value.state.localSearch.moves.right.status = "apple_reachable";
		value.state.localSearch.moves.right.cutoff = "apple";
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("accepts a completely exhausted dead branch without future geometry claims", () => {
		const state = observed();
		state.config = { ...state.config, width: 7, height: 1, obstacleCount: 1 };
		state.snake = [4, 3, 2].map((x) => ({ x, y: 0 }));
		state.obstacles = [{ x: 6, y: 0 }];
		state.apple = { x: 0, y: 0 };
		const search = evidence();
		search.expandedNodes = 1;
		search.moves.up = { ...search.moves.left };
		search.moves.down = { ...search.moves.left };
		search.moves.right = {
			status: "proven_dead",
			expandedNodes: 1,
			nodeBudget: 36,
			maxDepthReached: 1,
			cutoff: "none",
			witness: null,
			appleExitDirections: null,
		};
		const value = request(state, search);
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		search.moves.right.appleExitDirections = [];
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		search.moves.right.appleExitDirections = null;
		Object.assign(search.moves.right, {
			status: "survival_found",
			cutoff: "nodes",
			nodeBudget: 1,
			witness: ["right"],
		});
		search.maxNodes = 1;
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("an apple route with no immediate exit stays a reachable apple, not a proof about every route", () => {
		const state = observed();
		state.config = { ...state.config, width: 7, height: 1, obstacleCount: 1 };
		state.snake = [4, 3, 2].map((x) => ({ x, y: 0 }));
		state.obstacles = [{ x: 6, y: 0 }];
		state.apple = { x: 5, y: 0 };
		const search = evidence();
		search.expandedNodes = 1;
		search.moves.up = { ...search.moves.left };
		search.moves.down = { ...search.moves.left };
		search.moves.right = {
			status: "apple_reachable",
			expandedNodes: 1,
			nodeBudget: 36,
			maxDepthReached: 1,
			cutoff: "apple",
			witness: ["right"],
			appleExitDirections: [],
		};
		const value = request(state, search);
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		expect(value.state.localSearch.moves.right.status).toBe("apple_reachable");
		search.moves.right.appleExitDirections = ["right"];
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("apple endpoint exits include its vacating tail, even while the next apple location is unknown", () => {
		const state = observed();
		state.snake = [
			{ x: 1, y: 2 },
			{ x: 0, y: 2 },
			{ x: 0, y: 1 },
		];
		state.apple = { x: 1, y: 1 };
		const search = evidence();
		search.maxDepth = 1;
		search.maxNodes = 3;
		search.expandedNodes = 3;
		for (const direction of ["up", "right", "down"] as const)
			Object.assign(search.moves[direction], {
				status: "survival_found",
				expandedNodes: 1,
				nodeBudget: 1,
				maxDepthReached: 1,
				cutoff: "depth",
				witness: [direction],
				appleExitDirections: null,
			});
		Object.assign(search.moves.up, {
			status: "apple_reachable",
			cutoff: "apple",
			appleExitDirections: ["up", "right", "left"],
		});
		const value = request(state, search);
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		search.moves.up.appleExitDirections = ["up", "right"];
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test.each<{
		name: string;
		exits: DecisionRequestV9["state"]["localSearch"]["moves"]["right"]["appleExitDirections"];
	}>([
		{ name: "null", exits: null },
		{ name: "missing legal exits", exits: [] },
		{ name: "duplicate direction", exits: ["up", "right", "down", "down"] },
		{ name: "wrong ordering", exits: ["down", "right", "up"] },
		{ name: "illegal reversal", exits: ["up", "right", "down", "left"] },
	])("rejects apple exit evidence with $name", ({ exits }) => {
		const value = request();
		value.state.localSearch.moves.right.appleExitDirections = exits;
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("requires the exit field and forbids exit claims on other search outcomes", () => {
		const missing = request();
		Reflect.deleteProperty(
			missing.state.localSearch.moves.right,
			"appleExitDirections",
		);
		expect(decisionRequestSchema.safeParse(missing).success).toBe(false);
		for (const direction of ["up", "left"] as const) {
			const value = request();
			value.state.localSearch.moves[direction].appleExitDirections = [];
			expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		}
	});

	test.each<{ name: string; mutate: (value: DecisionRequestV9) => void }>([
		{
			name: "missing direction",
			mutate: (v) => {
				Reflect.deleteProperty(v.state.localSearch.moves, "left");
			},
		},
		{
			name: "extra search recommendation",
			mutate: (v) => {
				Object.assign(v.state.localSearch, { bestDirection: "right" });
			},
		},
		{
			name: "negative budget",
			mutate: (v) => {
				v.state.localSearch.maxNodes = -1;
			},
		},
		{
			name: "unsafe budget integer",
			mutate: (v) => {
				v.state.localSearch.maxNodes = Number.MAX_SAFE_INTEGER + 1;
			},
		},
		{
			name: "fractional depth",
			mutate: (v) => {
				v.state.localSearch.maxDepth = 2.5;
			},
		},
		{
			name: "zero depth",
			mutate: (v) => {
				v.state.localSearch.maxDepth = 0;
			},
		},
		{
			name: "wrong total expansion count",
			mutate: (v) => {
				v.state.localSearch.expandedNodes++;
			},
		},
		{
			name: "overspent move budget",
			mutate: (v) => {
				v.state.localSearch.moves.up.expandedNodes = 13;
				v.state.localSearch.expandedNodes = 19;
			},
		},
		{
			name: "unequal legal budget",
			mutate: (v) => {
				v.state.localSearch.moves.up.nodeBudget = 11;
			},
		},
		{
			name: "depth exceeding configured bound",
			mutate: (v) => {
				v.state.localSearch.moves.up.maxDepthReached = 3;
			},
		},
		{
			name: "depth without expansion",
			mutate: (v) => {
				v.state.localSearch.moves.up.maxDepthReached = 4;
			},
		},
		{
			name: "blocked legal move",
			mutate: (v) => {
				v.state.localSearch.moves.up.status = "blocked";
			},
		},
		{
			name: "searched blocked move",
			mutate: (v) => {
				v.state.localSearch.moves.left.expandedNodes = 1;
				v.state.localSearch.expandedNodes++;
			},
		},
		{
			name: "node cutoff before budget exhaustion",
			mutate: (v) => {
				v.state.localSearch.moves.up.cutoff = "nodes";
			},
		},
		{
			name: "death after truncation",
			mutate: (v) => {
				v.state.localSearch.moves.up.status = "proven_dead";
				v.state.localSearch.moves.up.witness = null;
			},
		},
		{
			name: "death with witness",
			mutate: (v) => {
				v.state.localSearch.moves.up.status = "proven_dead";
				v.state.localSearch.moves.up.cutoff = "none";
			},
		},
		{
			name: "unknown with verified route",
			mutate: (v) => {
				v.state.localSearch.moves.up.status = "unknown";
			},
		},
		{
			name: "apple route without witness",
			mutate: (v) => {
				v.state.localSearch.moves.right.witness = null;
			},
		},
		{
			name: "empty witness",
			mutate: (v) => {
				v.state.localSearch.moves.right.witness = [];
			},
		},
		{
			name: "wrong first direction",
			mutate: (v) => {
				v.state.localSearch.moves.up.witness = ["right", "up"];
			},
		},
		{
			name: "witness exceeds observed depth",
			mutate: (v) => {
				v.state.localSearch.moves.up.maxDepthReached = 1;
			},
		},
		{
			name: "short depth witness",
			mutate: (v) => {
				v.state.localSearch.moves.up.witness = ["up"];
			},
		},
		{
			name: "reversal inside witness",
			mutate: (v) => {
				v.state.localSearch.moves.up.witness = ["up", "down"];
			},
		},
		{
			name: "survival witness eats apple",
			mutate: (v) => {
				v.state.localSearch.moves.right.status = "survival_found";
				v.state.localSearch.moves.right.cutoff = "depth";
			},
		},
		{
			name: "apple route never reaches apple",
			mutate: (v) => {
				v.state.localSearch.moves.up.status = "apple_reachable";
				v.state.localSearch.moves.up.cutoff = "apple";
			},
		},
		{
			name: "win route leaves free cells",
			mutate: (v) => {
				v.state.localSearch.moves.right.status = "win_reachable";
				v.state.localSearch.moves.right.cutoff = "none";
			},
		},
		{
			name: "unvalidated board overlap",
			mutate: (v) => {
				v.state.board.obstacles.push(v.state.player.bodyHeadToTail[0]);
			},
		},
		{
			name: "wrong immediate observation",
			mutate: (v) => {
				v.state.immediateMoves.up.target.x++;
			},
		},
		{
			name: "wrong space observation",
			mutate: (v) => {
				v.state.observedSpace.regions[0].cells++;
			},
		},
	])("rejects $name", ({ mutate }) => {
		const value = request();
		mutate(value);
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("rejects routes that continue beyond the current apple boundary", () => {
		const value = request();
		const search = value.state.localSearch;
		search.maxDepth = 3;
		search.expandedNodes = 10;
		search.moves.right.witness = ["right", "right", "down"];
		search.moves.right.maxDepthReached = 3;
		search.moves.right.expandedNodes = 4;
		for (const direction of ["up", "down"] as const) {
			search.moves[direction].cutoff = "nodes";
			search.moves[direction].expandedNodes = 12;
		}
		search.expandedNodes = 28;
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test.each(["wall", "obstacle", "body"] as const)(
		"rejects a witness whose second step collides with %s",
		(collision) => {
			const state = observed();
			const search = evidence();
			if (collision === "wall") {
				state.snake = [3, 2, 1].map((x) => ({ x, y: 1 }));
				state.apple = { x: 5, y: 1 };
			} else if (collision === "obstacle") {
				state.obstacles.push({ x: 3, y: 0 });
				state.config.obstacleCount++;
			} else {
				state.snake = [
					{ x: 3, y: 2 },
					{ x: 2, y: 2 },
					{ x: 2, y: 1 },
					{ x: 1, y: 1 },
					{ x: 1, y: 2 },
				];
				search.moves.up.witness = ["up", "left"];
			}
			const value = request(state, search);
			expect(value.state.immediateMoves.up.legal).toBe(true);
			const result = decisionRequestSchema.safeParse(value);
			expect(result.success).toBe(false);
			if (!result.success)
				expect(result.error.issues.map((issue) => issue.path)).toContainEqual([
					"state",
					"localSearch",
					"moves",
					"up",
					"witness",
					1,
				]);
		},
	);

	test("preserves previous observed-board request versions", () => {
		for (const build of [decisionBodyV6, decisionBodyV7, decisionBodyV8]) {
			const value = build(observed());
			expect(decisionRequestSchema.parse(value)).toEqual(value);
			expect(value.state).not.toHaveProperty("localSearch");
		}
	});
});
