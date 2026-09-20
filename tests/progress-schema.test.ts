import { describe, expect, test } from "vitest";
import { decisionBodyV5 as decisionBody } from "../server/jev/analysis-context.js";
import { planBody } from "../server/jev/legacy-context.js";
import {
	decisionRequestSchema,
	planRequestSchema,
} from "../shared/snake/schema.js";
import {
	type DecisionProgress,
	directions,
	publicState,
} from "../shared/snake/types.js";
import { presentDecisionContext } from "../src/features/snake/contextPresentation.js";
import { baseState } from "./context-fixture.js";

function progress(): DecisionProgress {
	return {
		historyVersion: "progress-v1",
		historyStartTick: 0,
		throughTick: 34,
		lastAppleTick: 10,
		movesSinceApple: 24,
		positionVisits: 2,
		previousVisitTick: 10,
		repeatAfterMoves: 24,
		actions: {
			up: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
			right: { timesTaken: 1, returnsWithoutApple: 1, lastTakenTick: 11 },
			down: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
			left: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
		},
	};
}

function requests() {
	const state = baseState();
	state.tick = 34;
	return {
		single: decisionBody(publicState(state)),
		plan: planBody(publicState(state)),
	};
}

describe("recorded progress contracts", () => {
	test("preserves historical single and plan v3 without fabricating progress", () => {
		const { single, plan } = requests();
		delete single.state.progress;
		delete plan.state.progress;
		expect(decisionRequestSchema.parse(single)).toEqual(single);
		expect(planRequestSchema.parse(plan)).toEqual(plan);
		for (const request of [single, plan]) {
			const presentation = presentDecisionContext(request);
			expect(presentation.request?.state).not.toHaveProperty("progress");
			expect(presentation.semantics).not.toContain("历史记录覆盖");
			expect(presentation.json).toBe(JSON.stringify(request, null, 2));
		}
	});

	test("preserves progress evidence in single and plan requests and replay JSON", () => {
		const { single, plan } = requests();
		single.state.progress = progress();
		plan.state.progress = progress();
		expect(decisionRequestSchema.parse(single)).toEqual(single);
		expect(planRequestSchema.parse(plan)).toEqual(plan);
		for (const request of [single, plan]) {
			const original = structuredClone(request);
			const presentation = presentDecisionContext(request);
			expect(presentation.semantics).toContain("连续 24 步未吃苹果");
			expect(presentation.semantics).toContain("出现 2 次");
			expect(presentation.semantics).toContain("距上次相同局面 24 步");
			expect(presentation.json).toBe(JSON.stringify(original, null, 2));
			expect(request).toEqual(original);
		}
	});

	test("accepts an apple reset with no previous visit or action", () => {
		const { single } = requests();
		const value = progress();
		value.lastAppleTick = 34;
		value.movesSinceApple = 0;
		value.positionVisits = 1;
		value.previousVisitTick = null;
		value.repeatAfterMoves = null;
		value.actions.right = {
			timesTaken: 0,
			returnsWithoutApple: 0,
			lastTakenTick: null,
		};
		single.state.progress = value;
		expect(decisionRequestSchema.parse(single)).toEqual(single);
		expect(presentDecisionContext(single).semantics).not.toContain(
			"距上次相同局面",
		);
	});

	test("requires progress to cover the request's exact observed tick in both modes", () => {
		const { single, plan } = requests();
		single.state.progress = progress();
		plan.state.progress = progress();
		single.state.timing.observedTick = 35;
		plan.state.timing.observedTick = 35;
		expect(decisionRequestSchema.safeParse(single).success).toBe(false);
		expect(planRequestSchema.safeParse(plan).success).toBe(false);
	});

	test("requires complete direction evidence and rejects unknown progress fields", () => {
		for (const direction of directions) {
			const { single, plan } = requests();
			const value = progress();
			Reflect.deleteProperty(value.actions, direction);
			single.state.progress = value;
			plan.state.progress = value;
			expect(decisionRequestSchema.safeParse(single).success, direction).toBe(
				false,
			);
			expect(planRequestSchema.safeParse(plan).success, direction).toBe(false);
		}
		for (const mutate of [
			(value: DecisionProgress) => Object.assign(value, { endedForLoop: true }),
			(value: DecisionProgress) => Object.assign(value.actions, { wait: {} }),
			(value: DecisionProgress) =>
				Object.assign(value.actions.up, { blocked: true }),
		]) {
			const { single } = requests();
			const value = progress();
			mutate(value);
			single.state.progress = value;
			expect(decisionRequestSchema.safeParse(single).success).toBe(false);
		}
	});

	test.each<{
		name: string;
		mutate: (value: DecisionProgress) => void;
	}>([
		{
			name: "unknown history version",
			mutate: (value) =>
				Object.assign(value, { historyVersion: "progress-v2" }),
		},
		{
			name: "negative count",
			mutate: (value) => {
				value.movesSinceApple = -1;
			},
		},
		{
			name: "fractional count",
			mutate: (value) => {
				value.positionVisits = 1.5;
			},
		},
		{
			name: "zero visits",
			mutate: (value) => {
				value.positionVisits = 0;
			},
		},
		{
			name: "history after apple",
			mutate: (value) => {
				value.historyStartTick = 11;
			},
		},
		{
			name: "apple after observation",
			mutate: (value) => {
				value.lastAppleTick = 35;
			},
		},
		{
			name: "incorrect elapsed moves",
			mutate: (value) => {
				value.movesSinceApple = 23;
			},
		},
		{
			name: "first visit with repeat",
			mutate: (value) => {
				value.positionVisits = 1;
			},
		},
		{
			name: "repeat without prior tick",
			mutate: (value) => {
				value.previousVisitTick = null;
			},
		},
		{
			name: "repeat predating apple",
			mutate: (value) => {
				value.previousVisitTick = 9;
				value.repeatAfterMoves = 25;
			},
		},
		{
			name: "future visit",
			mutate: (value) => {
				value.previousVisitTick = 35;
			},
		},
		{
			name: "zero repeat interval",
			mutate: (value) => {
				value.previousVisitTick = 34;
				value.repeatAfterMoves = 0;
			},
		},
		{
			name: "incorrect repeat interval",
			mutate: (value) => {
				value.repeatAfterMoves = 23;
			},
		},
		{
			name: "unrecorded interval",
			mutate: (value) => {
				value.repeatAfterMoves = null;
			},
		},
		{
			name: "negative action count",
			mutate: (value) => {
				value.actions.up.timesTaken = -1;
			},
		},
		{
			name: "negative return count",
			mutate: (value) => {
				value.actions.right.returnsWithoutApple = -1;
			},
		},
		{
			name: "returns exceeding actions",
			mutate: (value) => {
				value.actions.right.returnsWithoutApple = 2;
			},
		},
		{
			name: "action without execution tick",
			mutate: (value) => {
				value.actions.right.lastTakenTick = null;
			},
		},
		{
			name: "tick without action",
			mutate: (value) => {
				value.actions.up.lastTakenTick = 20;
			},
		},
		{
			name: "action before apple",
			mutate: (value) => {
				value.actions.right.lastTakenTick = 9;
			},
		},
		{
			name: "future execution",
			mutate: (value) => {
				value.actions.right.lastTakenTick = 35;
			},
		},
	])("rejects $name instead of normalizing history", ({ mutate }) => {
		const { single, plan } = requests();
		const value = progress();
		mutate(value);
		single.state.progress = value;
		plan.state.progress = value;
		expect(decisionRequestSchema.safeParse(single).success).toBe(false);
		expect(planRequestSchema.safeParse(plan).success).toBe(false);
	});
});
