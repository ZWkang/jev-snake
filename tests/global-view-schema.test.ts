import { expect, test } from "vitest";
import { decisionRequestV8Schema } from "../shared/snake/context-v8-schema.js";
import type { DecisionRequestV8 } from "../shared/snake/global-view.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";

function request(): DecisionRequestV8 {
	return {
		model: "typesafe/jev-1.13",
		state: {
			contextVersion: "global-view-v8",
			rules: {
				objective: "Collect apples while staying alive.",
				applePoints: 10,
				starPoints: 30,
				coordinates: "x increases right; y increases down.",
				mechanics: "Move one cell. No direct reversal.",
			},
			board: {
				width: 7,
				height: 3,
				obstacles: [
					{ x: 0, y: 1 },
					{ x: 4, y: 1 },
					{ x: 5, y: 1 },
					{ x: 6, y: 1 },
				],
			},
			player: {
				bodyHeadToTail: [
					{ x: 3, y: 1 },
					{ x: 2, y: 1 },
					{ x: 1, y: 1 },
				],
				direction: "right",
				score: 0,
				applesEaten: 0,
			},
			food: {
				apple: { x: 0, y: 0 },
				star: { point: { x: 6, y: 2 }, expiresAt: 8000 },
			},
			timing: {
				stateIsProjected: false,
				stepMode: "response",
				observedTick: 0,
				targetTick: 1,
				gameTimeMs: 0,
				tickIntervalMs: null,
				deadlineInMs: null,
			},
			immediateMoves: {
				up: {
					target: { x: 3, y: 0 },
					legal: true,
					blockedBy: "none",
					destination: "empty",
					departureHistory: "not_recorded",
					description: "Up is currently empty.",
				},
				right: {
					target: { x: 4, y: 1 },
					legal: false,
					blockedBy: "obstacle",
					destination: "obstacle",
					departureHistory: "not_recorded",
					description: "Right is an obstacle.",
				},
				down: {
					target: { x: 3, y: 2 },
					legal: true,
					blockedBy: "none",
					destination: "empty",
					departureHistory: "not_recorded",
					description: "Down is currently empty.",
				},
				left: {
					target: { x: 2, y: 1 },
					legal: false,
					blockedBy: "reverse",
					destination: "snake_body",
					departureHistory: "not_recorded",
					description: "Left is the occupied neck, a reversal.",
				},
			},
			observedSpace: {
				basis: "current_occupancy",
				regions: [
					{ cells: 7, containsApple: true },
					{ cells: 7, containsApple: false },
				],
				moves: {
					up: {
						entry: "open_cell",
						region: { cells: 7, containsApple: true },
						openAdjacentDirections: ["right", "left"],
						openAdjacentCells: 2,
					},
					right: {
						entry: "blocked",
						region: null,
						openAdjacentDirections: [],
						openAdjacentCells: 0,
					},
					down: {
						entry: "open_cell",
						region: { cells: 7, containsApple: false },
						openAdjacentDirections: ["right", "left"],
						openAdjacentCells: 2,
					},
					left: {
						entry: "blocked",
						region: null,
						openAdjacentDirections: [],
						openAdjacentCells: 0,
					},
				},
			},
		},
		questions: {
			direction: {
				type: "choice",
				instructions: {
					question: "Which absolute direction should the snake move next?",
					inspect: "Compare current occupancy and the complete board.",
					constraint: "Choose a legal move.",
					objective: "Collect apples while staying alive.",
					uncertainty: "Current regions do not predict future body movement.",
					history: "Read actual recorded departures.",
				},
				criteria: {
					up: {
						meaning: "Move up.",
						chooseWhen: "Up supports the objective.",
						excludeWhen: "Up is blocked.",
					},
					right: {
						meaning: "Move right.",
						chooseWhen: "Right supports the objective.",
						excludeWhen: "Right is blocked.",
					},
					down: {
						meaning: "Move down.",
						chooseWhen: "Down supports the objective.",
						excludeWhen: "Down is blocked.",
					},
					left: {
						meaning: "Move left.",
						chooseWhen: "Left supports the objective.",
						excludeWhen: "Left is blocked.",
					},
				},
			},
		},
	};
}

test("v8 round-trips independently specified geometry and current occupancy without distance labels", () => {
	const value = request();
	expect(decisionRequestV8Schema.parse(value)).toEqual(value);
	expect(decisionRequestSchema.parse(value)).toEqual(value);
	expect(JSON.stringify(value)).not.toContain("appleProgress");
	const copy = structuredClone(value);
	decisionRequestSchema.parse(value);
	expect(value).toEqual(copy);
});

test.each<{ name: string; mutate: (value: DecisionRequestV8) => void }>([
	{
		name: "distance label",
		mutate: (v) => {
			Object.assign(v.state.immediateMoves.up, { appleProgress: "closer" });
		},
	},
	{
		name: "missing observation",
		mutate: (v) => {
			Reflect.deleteProperty(v.state, "observedSpace");
		},
	},
	{
		name: "predicted basis",
		mutate: (v) => {
			Object.assign(v.state.observedSpace, { basis: "after_move" });
		},
	},
	{
		name: "region size",
		mutate: (v) => {
			v.state.observedSpace.regions[0].cells = 8;
		},
	},
	{
		name: "missing region",
		mutate: (v) => {
			v.state.observedSpace.regions.pop();
		},
	},
	{
		name: "region ordering",
		mutate: (v) => {
			v.state.observedSpace.regions.reverse();
		},
	},
	{
		name: "invented apple connectivity",
		mutate: (v) => {
			v.state.observedSpace.moves.down.region!.containsApple = true;
		},
	},
	{
		name: "source head counted as empty",
		mutate: (v) => {
			v.state.observedSpace.moves.up.openAdjacentDirections.push("down");
			v.state.observedSpace.moves.up.openAdjacentCells = 3;
		},
	},
	{
		name: "neighbor count",
		mutate: (v) => {
			v.state.observedSpace.moves.up.openAdjacentCells = 3;
		},
	},
	{
		name: "duplicate neighbor",
		mutate: (v) => {
			v.state.observedSpace.moves.up.openAdjacentDirections = [
				"right",
				"right",
			];
		},
	},
	{
		name: "missing move",
		mutate: (v) => {
			Reflect.deleteProperty(v.state.observedSpace.moves, "left");
		},
	},
	{
		name: "blocked region",
		mutate: (v) => {
			v.state.observedSpace.moves.left.region = {
				cells: 7,
				containsApple: true,
			};
		},
	},
	{
		name: "invented tail release",
		mutate: (v) => {
			v.state.observedSpace.moves.up.entry = "vacating_tail";
			v.state.observedSpace.moves.up.region = null;
		},
	},
	{
		name: "false legal move",
		mutate: (v) => {
			v.state.immediateMoves.right.legal = true;
		},
	},
	{
		name: "incorrect target",
		mutate: (v) => {
			v.state.immediateMoves.up.target.y = -1;
		},
	},
	{
		name: "incorrect destination",
		mutate: (v) => {
			v.state.immediateMoves.up.destination = "apple";
		},
	},
	{
		name: "imagined departure",
		mutate: (v) => {
			v.state.immediateMoves.up.departureHistory = "returned_without_apple";
		},
	},
	{
		name: "negative board",
		mutate: (v) => {
			v.state.board.width = -1;
		},
	},
	{
		name: "fractional board",
		mutate: (v) => {
			v.state.board.height = 1.5;
		},
	},
	{
		name: "empty body",
		mutate: (v) => {
			v.state.player.bodyHeadToTail = [];
		},
	},
	{
		name: "overlapping board",
		mutate: (v) => {
			v.state.food.apple = { x: 3, y: 1 };
		},
	},
	{
		name: "wrong tick",
		mutate: (v) => {
			v.state.timing.targetTick = 2;
		},
	},
	{
		name: "mislabelled version",
		mutate: (v) => {
			Object.assign(v.state, { contextVersion: "local-moves-v7" });
		},
	},
	{
		name: "route prediction",
		mutate: (v) => {
			Object.assign(v.state.observedSpace.moves.up, { forcedDeath: true });
		},
	},
	{
		name: "extra instruction",
		mutate: (v) => {
			Object.assign(v.questions.direction.instructions, {
				recommendation: "up",
			});
		},
	},
])("rejects $name without rewriting the request", ({ mutate }) => {
	const value = request();
	mutate(value);
	expect(decisionRequestSchema.safeParse(value).success).toBe(false);
});

test("v8 validates a vacating-tail entry without assigning it a predicted region", () => {
	const value = request();
	value.state.board = { width: 7, height: 4, obstacles: [{ x: 0, y: 1 }] };
	value.state.player.bodyHeadToTail = [
		{ x: 1, y: 1 },
		{ x: 2, y: 1 },
		{ x: 2, y: 2 },
		{ x: 1, y: 2 },
	];
	value.state.player.direction = "left";
	value.state.food = {
		apple: { x: 4, y: 1 },
		star: { point: { x: 1, y: 0 }, expiresAt: 8000 },
	};
	Object.assign(value.state.immediateMoves.up, {
		target: { x: 1, y: 0 },
		destination: "star",
	});
	Object.assign(value.state.immediateMoves.right, {
		target: { x: 2, y: 1 },
		blockedBy: "reverse",
		destination: "snake_body",
	});
	Object.assign(value.state.immediateMoves.down, {
		target: { x: 1, y: 2 },
		destination: "vacating_tail",
	});
	Object.assign(value.state.immediateMoves.left, {
		target: { x: 0, y: 1 },
		blockedBy: "obstacle",
		destination: "obstacle",
	});
	value.state.observedSpace.regions = [{ cells: 23, containsApple: true }];
	value.state.observedSpace.moves.up.region = {
		cells: 23,
		containsApple: true,
	};
	value.state.observedSpace.moves.down = {
		entry: "vacating_tail",
		region: null,
		openAdjacentDirections: ["down", "left"],
		openAdjacentCells: 2,
	};
	expect(decisionRequestSchema.parse(value)).toEqual(value);
	value.state.observedSpace.moves.down.region = {
		cells: 23,
		containsApple: true,
	};
	expect(decisionRequestSchema.safeParse(value).success).toBe(false);
});

test("v7 payloads retain their original distance labels and no space observation", () => {
	const v8 = request();
	const { observedSpace: _, ...state } = v8.state;
	const v7 = {
		...v8,
		state: {
			...state,
			contextVersion: "local-moves-v7",
			immediateMoves: {
				up: { ...state.immediateMoves.up, appleProgress: "closer" },
				right: {
					...state.immediateMoves.right,
					appleProgress: "not_applicable",
				},
				down: { ...state.immediateMoves.down, appleProgress: "farther" },
				left: { ...state.immediateMoves.left, appleProgress: "not_applicable" },
			},
		},
	};
	expect(decisionRequestSchema.parse(v7)).toEqual(v7);
	Reflect.deleteProperty(v7.state.immediateMoves.up, "appleProgress");
	expect(decisionRequestSchema.safeParse(v7).success).toBe(false);
});
