import { describe, expect, test } from "vitest";
import { decisionRequestV11Schema } from "../shared/snake/context-v11-schema.js";
import type { DecisionRequestV11 } from "../shared/snake/model-planning.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import { directions } from "../shared/snake/types.js";

function request(): DecisionRequestV11 {
	return {
		model: "test-model",
		state: {
			contextVersion: "model-planning-v11",
			rules: {
				objective: "Fill the traversable board while staying alive.",
				applePoints: 10,
				starPoints: 30,
				coordinates: "Zero-based coordinates: x right, y down.",
				mechanics:
					"Move one cell per response. No direct reversal. Apples grow the body; stars do not.",
			},
			board: { width: 8, height: 6, obstacles: [{ x: 5, y: 4 }] },
			player: {
				bodyHeadToTail: [3, 2, 1, 0].map((x) => ({ x, y: 2 })),
				direction: "right",
				score: 0,
				applesEaten: 0,
			},
			food: { apple: { x: 7, y: 5 }, star: null },
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
				instructions:
					"Plan your own next direction using the full observed board, rules and actual history.",
				criteria: {
					up: { meaning: "Move toward y-1." },
					right: { meaning: "Move toward x+1." },
					down: { meaning: "Move toward y+1." },
					left: { meaning: "Move toward x-1." },
				},
			},
		},
	};
}

describe("model-only planning request schema", () => {
	test("round-trips full observations and actual history without adding derived facts", () => {
		const value = request();
		const original = structuredClone(value);
		expect(decisionRequestV11Schema.parse(value)).toEqual(original);
		expect(decisionRequestSchema.parse(value)).toEqual(original);
		expect(value).toEqual(original);
		expect(Object.keys(value.questions.direction.criteria)).toEqual(directions);
		delete value.state.progress;
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		expect(decisionRequestSchema.parse(value).state).not.toHaveProperty(
			"progress",
		);
	});

	test.each([
		"immediateMoves",
		"observedSpace",
		"localSearch",
		"actionFacts",
		"firstActions",
		"witnessContinuity",
		"postAppleSearch",
		"recommendedDirection",
		"appleRoute",
		"futureBody",
	])("rejects server analysis field %s rather than stripping it", (field) => {
		const value = request();
		Object.assign(value.state, { [field]: {} });
		expect(decisionRequestV11Schema.safeParse(value).success).toBe(false);
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		expect(value.state).toHaveProperty(field);
	});

	test.each([
		"legal",
		"blockedBy",
		"chooseWhen",
		"excludeWhen",
		"survival",
		"appleRoute",
		"witness",
	])("rejects analytical direction field %s", (field) => {
		const value = request();
		Object.assign(value.questions.direction.criteria.up, {
			[field]: "derived",
		});
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("requires all four unfiltered directions and a plain instruction string", () => {
		for (const direction of directions) {
			const value = request();
			Reflect.deleteProperty(value.questions.direction.criteria, direction);
			expect(decisionRequestSchema.safeParse(value).success, direction).toBe(
				false,
			);
		}
		const value = request();
		Object.assign(value.questions.direction, {
			instructions: { inspect: "Use supplied route assessments." },
		});
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test.each<{ name: string; mutate: (value: DecisionRequestV11) => void }>([
		{
			name: "empty body",
			mutate: (v) => {
				v.state.player.bodyHeadToTail = [];
			},
		},
		{
			name: "missing body coordinates",
			mutate: (v) => {
				Reflect.deleteProperty(v.state.player, "bodyHeadToTail");
			},
		},
		{
			name: "missing obstacle coordinates",
			mutate: (v) => {
				Reflect.deleteProperty(v.state.board, "obstacles");
			},
		},
		{
			name: "disconnected body",
			mutate: (v) => {
				v.state.player.bodyHeadToTail[3] = { x: 0, y: 4 };
			},
		},
		{
			name: "repeated body cell",
			mutate: (v) => {
				v.state.player.bodyHeadToTail[3] = { x: 3, y: 2 };
			},
		},
		{
			name: "overlapping obstacle",
			mutate: (v) => {
				v.state.board.obstacles = [{ x: 3, y: 2 }];
			},
		},
		{
			name: "apple on body",
			mutate: (v) => {
				v.state.food.apple = { x: 3, y: 2 };
			},
		},
		{
			name: "out of bounds apple",
			mutate: (v) => {
				v.state.food.apple = { x: 8, y: 5 };
			},
		},
		{
			name: "out of bounds obstacle",
			mutate: (v) => {
				v.state.board.obstacles = [{ x: 5, y: 6 }];
			},
		},
		{
			name: "wrong target tick",
			mutate: (v) => {
				v.state.timing.targetTick = 3;
			},
		},
		{
			name: "history for another observation",
			mutate: (v) => {
				v.state.timing.observedTick = 1;
				v.state.timing.targetTick = 2;
			},
		},
		{
			name: "projected board",
			mutate: (v) => {
				Object.assign(v.state.timing, { stateIsProjected: true });
			},
		},
		{
			name: "predicted history",
			mutate: (v) => {
				Object.assign(v.state.progress!, { predictedVisits: 2 });
			},
		},
		{
			name: "root recommendation",
			mutate: (v) => {
				Object.assign(v, { recommendation: "up" });
			},
		},
	])("retains strict observed-board validation for $name", ({ mutate }) => {
		const value = request();
		mutate(value);
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("keeps the previous raw-board version readable without rewriting its version", () => {
		const value = request();
		const legacy = {
			...value,
			state: { ...value.state, contextVersion: "board-state-v6" },
		};
		expect(decisionRequestSchema.parse(legacy)).toEqual(legacy);
		expect(decisionRequestV11Schema.safeParse(legacy).success).toBe(false);
	});
});
