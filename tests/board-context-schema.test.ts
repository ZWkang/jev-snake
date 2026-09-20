import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { DecisionRequestV6 } from "../shared/snake/board-context.js";
import { decisionRequestV6Schema } from "../shared/snake/context-v6-schema.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import { directions } from "../shared/snake/types.js";

function request(): DecisionRequestV6 {
	return {
		model: "typesafe/jev-1.13",
		state: {
			contextVersion: "board-state-v6",
			rules: {
				objective: "Eat apples and stars while staying alive.",
				applePoints: 10,
				starPoints: 30,
				coordinates: "x increases right; y increases down.",
				mechanics: "Move one cell per response. No direct reversal.",
			},
			board: { width: 8, height: 6, obstacles: [{ x: 7, y: 5 }] },
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
				apple: { x: 4, y: 1 },
				star: { point: { x: 4, y: 4 }, expiresAt: 6000 },
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
			progress: {
				historyVersion: "progress-v1",
				historyStartTick: 0,
				throughTick: 0,
				lastAppleTick: 0,
				movesSinceApple: 0,
				positionVisits: 1,
				previousVisitTick: null,
				repeatAfterMoves: null,
				actions: {
					up: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
					right: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
					down: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
					left: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
				},
			},
		},
		questions: {
			direction: {
				type: "choice",
				instructions: "Choose the next direction from the full board.",
				criteria: {
					up: { meaning: "Move up one cell." },
					right: { meaning: "Move right one cell." },
					down: { meaning: "Move down one cell." },
					left: { meaning: "Move left one cell." },
				},
			},
		},
	};
}

describe("complete observed board context", () => {
	test("round-trips the complete board and all four choices without adding analysis", () => {
		const value = request();
		expect(decisionRequestV6Schema.parse(value)).toEqual(value);
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		delete value.state.progress;
		value.state.food = { apple: null, star: null };
		value.state.board.obstacles = [];
		expect(decisionRequestSchema.parse(value)).toEqual(value);
	});

	test("requires both full body geometry and obstacle coordinates", () => {
		for (const missing of ["body", "obstacles"] as const) {
			const value = request();
			if (missing === "body") {
				Reflect.deleteProperty(value.state.player, "bodyHeadToTail");
				Object.assign(value.state.player, { head: { x: 2, y: 1 }, length: 3 });
			} else {
				Reflect.deleteProperty(value.state.board, "obstacles");
				Object.assign(value.state.board, { obstacleCount: 1 });
			}
			expect(decisionRequestSchema.safeParse(value).success, missing).toBe(
				false,
			);
		}
	});

	test.each<{
		name: string;
		mutate: (value: DecisionRequestV6) => void;
	}>([
		{
			name: "empty body",
			mutate: (v) => {
				v.state.player.bodyHeadToTail = [];
			},
		},
		{
			name: "overlapping body",
			mutate: (v) => {
				v.state.player.bodyHeadToTail[2] = { x: 2, y: 1 };
			},
		},
		{
			name: "disconnected body",
			mutate: (v) => {
				v.state.player.bodyHeadToTail[2] = { x: 0, y: 3 };
			},
		},
		{
			name: "diagonal body",
			mutate: (v) => {
				v.state.player.bodyHeadToTail[2] = { x: 0, y: 2 };
			},
		},
		{
			name: "overlapping obstacles",
			mutate: (v) => {
				v.state.board.obstacles.push({ x: 7, y: 5 });
			},
		},
		{
			name: "obstacle on body",
			mutate: (v) => {
				v.state.board.obstacles = [{ x: 1, y: 1 }];
			},
		},
		{
			name: "apple on body",
			mutate: (v) => {
				v.state.food.apple = { x: 2, y: 1 };
			},
		},
		{
			name: "apple on obstacle",
			mutate: (v) => {
				v.state.food.apple = { x: 7, y: 5 };
			},
		},
		{
			name: "star on body",
			mutate: (v) => {
				v.state.food.star!.point = { x: 2, y: 1 };
			},
		},
		{
			name: "star on obstacle",
			mutate: (v) => {
				v.state.food.star!.point = { x: 7, y: 5 };
			},
		},
		{
			name: "overlapping food",
			mutate: (v) => {
				v.state.food.star!.point = { x: 4, y: 1 };
			},
		},
		{
			name: "zero board width",
			mutate: (v) => {
				v.state.board.width = 0;
			},
		},
		{
			name: "fractional board height",
			mutate: (v) => {
				v.state.board.height = 6.5;
			},
		},
		{
			name: "future target",
			mutate: (v) => {
				v.state.timing.targetTick = 2;
			},
		},
		{
			name: "stale history",
			mutate: (v) => {
				v.state.timing.observedTick = 1;
				v.state.timing.targetTick = 2;
			},
		},
		{
			name: "projected state",
			mutate: (v) => {
				Object.assign(v.state.timing, { stateIsProjected: true });
			},
		},
		{
			name: "fixed clock",
			mutate: (v) => {
				Object.assign(v.state.timing, {
					stepMode: "fixed",
					tickIntervalMs: 500,
				});
			},
		},
		{
			name: "response deadline",
			mutate: (v) => {
				Object.assign(v.state.timing, { deadlineInMs: 500 });
			},
		},
		{
			name: "missing deadline",
			mutate: (v) => {
				Reflect.deleteProperty(v.state.timing, "deadlineInMs");
			},
		},
		{
			name: "action recommendation",
			mutate: (v) => {
				Object.assign(v.questions.direction.criteria.up, { danger: null });
			},
		},
		{
			name: "route analysis",
			mutate: (v) => {
				Object.assign(v.state, { actionFacts: {} });
			},
		},
		{
			name: "unknown field",
			mutate: (v) => {
				Object.assign(v, { recommendation: "right" });
			},
		},
	])("rejects $name without normalizing the request", ({ mutate }) => {
		const value = request();
		mutate(value);
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("checks every occupant against both board boundaries and integer coordinates", () => {
		for (const key of ["body", "obstacle", "apple", "star"] as const) {
			for (const cell of [
				{ x: 8, y: 1 },
				{ x: 4, y: 6 },
				{ x: -1, y: 1 },
				{ x: 4, y: -1 },
				{ x: 4.5, y: 1 },
			]) {
				const value = request();
				if (key === "body") value.state.player.bodyHeadToTail = [cell];
				if (key === "obstacle") value.state.board.obstacles = [cell];
				if (key === "apple") value.state.food.apple = cell;
				if (key === "star") value.state.food.star!.point = cell;
				expect(
					decisionRequestSchema.safeParse(value).success,
					`${key}: ${JSON.stringify(cell)}`,
				).toBe(false);
			}
		}
	});

	test("retains every direction, including reversal, as a model choice", () => {
		for (const direction of directions) {
			const value = request();
			Reflect.deleteProperty(value.questions.direction.criteria, direction);
			expect(decisionRequestSchema.safeParse(value).success, direction).toBe(
				false,
			);
		}
		const value = request();
		Object.assign(value.questions.direction.criteria, {
			wait: { meaning: "Wait" },
		});
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("keeps captured historical v1, v2 and v3 payloads unchanged", () => {
		const read = (name: string) =>
			JSON.parse(
				readFileSync(
					new URL(`./fixtures/${name}.json`, import.meta.url),
					"utf8",
				),
			);
		const legacy = read("context-legacy");
		const v2 = read("context-v2") as Record<string, { single: unknown }>;
		const values = [
			...Object.values(legacy),
			...Object.values(v2).map((value) => value.single),
			read("no-static-route-loop").request,
		];
		for (const value of values)
			expect(decisionRequestSchema.parse(value)).toEqual(value);
	});
});
