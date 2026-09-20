import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { decisionRequestV7Schema } from "../shared/snake/context-v7-schema.js";
import type { DecisionRequestV7 } from "../shared/snake/local-moves.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import { directions } from "../shared/snake/types.js";

function request(): DecisionRequestV7 {
	return {
		model: "typesafe/jev-1.13",
		state: {
			contextVersion: "local-moves-v7",
			rules: {
				objective: "Eat apples and stars while staying alive.",
				applePoints: 10,
				starPoints: 30,
				coordinates: "x increases right; y increases down.",
				mechanics: "Move one cell per response. No direct reversal.",
			},
			board: { width: 8, height: 6, obstacles: [{ x: 2, y: 0 }] },
			player: {
				bodyHeadToTail: [
					{ x: 2, y: 1 },
					{ x: 1, y: 1 },
					{ x: 0, y: 1 },
				],
				direction: "right",
				score: 0,
				applesEaten: 0,
			},
			food: {
				apple: { x: 3, y: 1 },
				star: { point: { x: 2, y: 2 }, expiresAt: 6000 },
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
					target: { x: 2, y: 0 },
					legal: false,
					blockedBy: "obstacle",
					destination: "obstacle",
					appleProgress: "not_applicable",
					departureHistory: "not_recorded",
					description: "Up is an obstacle.",
				},
				right: {
					target: { x: 3, y: 1 },
					legal: true,
					blockedBy: "none",
					destination: "apple",
					appleProgress: "eats_now",
					departureHistory: "not_recorded",
					description: "Right contains the apple.",
				},
				down: {
					target: { x: 2, y: 2 },
					legal: true,
					blockedBy: "none",
					destination: "star",
					appleProgress: "farther",
					departureHistory: "not_recorded",
					description: "Down contains a star.",
				},
				left: {
					target: { x: 1, y: 1 },
					legal: false,
					blockedBy: "reverse",
					destination: "snake_body",
					appleProgress: "not_applicable",
					departureHistory: "not_recorded",
					description: "Left reverses into the body.",
				},
			},
		},
		questions: {
			direction: {
				type: "choice",
				instructions: {
					question: "Which direction should the snake move next?",
					inspect: "Read immediateMoves and the complete board.",
					constraint: "Exclude illegal moves.",
					objective: "Choose a legal move to collect rewards and stay alive.",
					uncertainty: "Adjacent facts do not predict future survival.",
					history: "Consider recorded returns without an apple.",
				},
				criteria: {
					up: {
						meaning: "Move up.",
						chooseWhen: "Up is legal and useful.",
						excludeWhen: "Up is blocked.",
					},
					right: {
						meaning: "Move right.",
						chooseWhen: "Right is legal and useful.",
						excludeWhen: "Right is blocked.",
					},
					down: {
						meaning: "Move down.",
						chooseWhen: "Down is legal and useful.",
						excludeWhen: "Down is blocked.",
					},
					left: {
						meaning: "Move left.",
						chooseWhen: "Left is legal and useful.",
						excludeWhen: "Left is blocked.",
					},
				},
			},
		},
	};
}

describe("local-moves-v7 request validation", () => {
	test("round-trips independent adjacent facts, complete geometry and structured questions", () => {
		const value = request();
		expect(decisionRequestV7Schema.parse(value)).toEqual(value);
		expect(decisionRequestSchema.parse(value)).toEqual(value);
	});

	test("accepts negative wall targets while keeping board occupants in bounds", () => {
		const value = request();
		value.state.board.obstacles = [];
		value.state.player = {
			...value.state.player,
			direction: "up",
			bodyHeadToTail: [
				{ x: 0, y: 0 },
				{ x: 0, y: 1 },
				{ x: 0, y: 2 },
			],
		};
		value.state.food = { apple: { x: 1, y: 0 }, star: null };
		Object.assign(value.state.immediateMoves.up, {
			target: { x: 0, y: -1 },
			blockedBy: "wall",
			destination: "outside_board",
		});
		Object.assign(value.state.immediateMoves.right, { target: { x: 1, y: 0 } });
		Object.assign(value.state.immediateMoves.down, {
			target: { x: 0, y: 1 },
			legal: false,
			blockedBy: "reverse",
			destination: "snake_body",
			appleProgress: "not_applicable",
		});
		Object.assign(value.state.immediateMoves.left, {
			target: { x: -1, y: 0 },
			blockedBy: "wall",
			destination: "outside_board",
		});
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		value.state.player.bodyHeadToTail[2] = { x: -1, y: 1 };
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("distinguishes a releasing tail from occupied body cells", () => {
		const value = request();
		value.state.board.obstacles = [];
		value.state.player.bodyHeadToTail = [
			{ x: 1, y: 1 },
			{ x: 0, y: 1 },
			{ x: 0, y: 0 },
			{ x: 1, y: 0 },
		];
		value.state.food = { apple: { x: 2, y: 1 }, star: null };
		Object.assign(value.state.immediateMoves.up, {
			target: { x: 1, y: 0 },
			legal: true,
			blockedBy: "none",
			destination: "vacating_tail",
			appleProgress: "farther",
		});
		Object.assign(value.state.immediateMoves.right, { target: { x: 2, y: 1 } });
		Object.assign(value.state.immediateMoves.down, {
			target: { x: 1, y: 2 },
			destination: "empty",
		});
		Object.assign(value.state.immediateMoves.left, { target: { x: 0, y: 1 } });
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		value.state.player.bodyHeadToTail.push({ x: 2, y: 0 });
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		Object.assign(value.state.immediateMoves.up, {
			legal: false,
			blockedBy: "body",
			destination: "snake_body",
			appleProgress: "not_applicable",
		});
		expect(decisionRequestSchema.parse(value)).toEqual(value);
	});

	test("distinguishes adjacent collection, Manhattan distance and absence without claiming a route", () => {
		const value = request();
		value.state.food.apple = { x: 5, y: 1 };
		Object.assign(value.state.immediateMoves.right, {
			destination: "empty",
			appleProgress: "closer",
		});
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		value.state.food.apple = null;
		value.state.immediateMoves.right.appleProgress = "no_apple";
		value.state.immediateMoves.down.appleProgress = "no_apple";
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		value.state.immediateMoves.up.appleProgress = "no_apple";
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("requires history summaries to agree with actual recorded departures", () => {
		const value = request();
		value.state.timing.observedTick = 12;
		value.state.timing.targetTick = 13;
		value.state.progress = {
			historyVersion: "progress-v1",
			historyStartTick: 0,
			throughTick: 12,
			lastAppleTick: 0,
			movesSinceApple: 12,
			positionVisits: 2,
			previousVisitTick: 4,
			repeatAfterMoves: 8,
			actions: {
				up: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
				right: { timesTaken: 1, returnsWithoutApple: 1, lastTakenTick: 5 },
				down: { timesTaken: 1, returnsWithoutApple: 0, lastTakenTick: 1 },
				left: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
			},
		};
		value.state.immediateMoves.up.departureHistory = "not_taken_here";
		value.state.immediateMoves.right.departureHistory =
			"returned_without_apple";
		value.state.immediateMoves.down.departureHistory =
			"taken_without_recorded_return";
		value.state.immediateMoves.left.departureHistory = "not_taken_here";
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		value.state.immediateMoves.right.departureHistory = "not_taken_here";
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		value.state.immediateMoves.right.departureHistory =
			"returned_without_apple";
		value.state.progress.throughTick = 11;
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test.each<{ name: string; mutate: (value: DecisionRequestV7) => void }>([
		{
			name: "incorrect target",
			mutate: (v) => {
				v.state.immediateMoves.right.target.x = 4;
			},
		},
		{
			name: "fractional target",
			mutate: (v) => {
				v.state.immediateMoves.right.target.x = 3.5;
			},
		},
		{
			name: "hidden obstacle",
			mutate: (v) => {
				v.state.immediateMoves.up.blockedBy = "none";
			},
		},
		{
			name: "false legality",
			mutate: (v) => {
				v.state.immediateMoves.up.legal = true;
			},
		},
		{
			name: "wrong destination",
			mutate: (v) => {
				v.state.immediateMoves.right.destination = "empty";
			},
		},
		{
			name: "imagined progress",
			mutate: (v) => {
				v.state.immediateMoves.down.appleProgress = "eats_now";
			},
		},
		{
			name: "imagined history",
			mutate: (v) => {
				v.state.immediateMoves.right.departureHistory =
					"returned_without_apple";
			},
		},
		{
			name: "missing move",
			mutate: (v) => {
				Reflect.deleteProperty(v.state.immediateMoves, "left");
			},
		},
		{
			name: "empty body",
			mutate: (v) => {
				v.state.player.bodyHeadToTail = [];
			},
		},
		{
			name: "overlapping food",
			mutate: (v) => {
				v.state.food.apple = v.state.food.star!.point;
			},
		},
		{
			name: "disconnected body",
			mutate: (v) => {
				v.state.player.bodyHeadToTail[2] = { x: 0, y: 3 };
			},
		},
		{
			name: "projected tick",
			mutate: (v) => {
				v.state.timing.targetTick = 2;
			},
		},
		{
			name: "analysis field",
			mutate: (v) => {
				Object.assign(v.state.immediateMoves.right, { safeRoute: ["right"] });
			},
		},
		{
			name: "old string instruction",
			mutate: (v) => {
				Object.assign(v.questions.direction, {
					instructions: "Choose a direction.",
				});
			},
		},
		{
			name: "missing instruction",
			mutate: (v) => {
				Reflect.deleteProperty(
					v.questions.direction.instructions,
					"uncertainty",
				);
			},
		},
		{
			name: "missing criteria condition",
			mutate: (v) => {
				Reflect.deleteProperty(
					v.questions.direction.criteria.up,
					"excludeWhen",
				);
			},
		},
		{
			name: "unknown field",
			mutate: (v) => {
				Object.assign(v, { recommendation: "right" });
			},
		},
		{
			name: "mislabeled version",
			mutate: (v) => {
				Object.assign(v.state, { contextVersion: "board-state-v6" });
			},
		},
	])("rejects $name without normalizing or falling back", ({ mutate }) => {
		const value = request();
		mutate(value);
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("retains all four choices, including directions that the model should exclude", () => {
		for (const direction of directions) {
			const value = request();
			Reflect.deleteProperty(value.questions.direction.criteria, direction);
			expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		}
	});

	test("preserves historical requests instead of rewriting them as v7", () => {
		const read = (name: string) =>
			JSON.parse(
				readFileSync(
					new URL(`./fixtures/${name}.json`, import.meta.url),
					"utf8",
				),
			);
		const legacy = read("context-legacy");
		const v2 = read("context-v2") as Record<string, { single: unknown }>;
		const v4 = read("outcome-input-regressions") as {
			cases: { recordedRequest: unknown }[];
		};
		const { immediateMoves: _, ...v6State } = request().state;
		const v6 = {
			model: request().model,
			state: { ...v6State, contextVersion: "board-state-v6" },
			questions: {
				direction: {
					type: "choice",
					instructions: "Original board-only input.",
					criteria: Object.fromEntries(
						directions.map((direction) => [
							direction,
							{ meaning: `Move ${direction}.` },
						]),
					),
				},
			},
		};
		const values = [
			...Object.values(legacy),
			...Object.values(v2).map((value) => value.single),
			read("no-static-route-loop").request,
			...v4.cases.map((value) => value.recordedRequest),
			v6,
		];
		for (const value of values)
			expect(decisionRequestSchema.parse(value)).toEqual(value);
	});
});
