import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { decisionBodyV4 as decisionBody } from "../server/jev/client.js";
import { planBody } from "../server/jev/legacy-context.js";
import {
	allControlSchema,
	decisionRequestSchema,
	decisionSchema,
	planDecisionSchema,
	planRequestSchema,
} from "../shared/snake/schema.js";
import {
	type DecisionRequest,
	directions,
	type LegacyDecisionRequest,
	type LegacyPlanRequest,
	type PlanRequest,
	planChoices,
	publicState,
} from "../shared/snake/types.js";
import { baseState, contextFixtures, nearComplete } from "./context-fixture.js";

const legacy = JSON.parse(
	readFileSync(
		new URL("./fixtures/context-legacy.json", import.meta.url),
		"utf8",
	),
) as Record<"v1" | "unversioned", LegacyDecisionRequest>;
const v2 = JSON.parse(
	readFileSync(new URL("./fixtures/context-v2.json", import.meta.url), "utf8"),
) as Record<string, { single: LegacyDecisionRequest; plan: LegacyPlanRequest }>;

function singleDecision(request: DecisionRequest) {
	return {
		model: request.model,
		choice: "up",
		probabilities: { up: 0.69, right: 0.1, down: 0.1, left: 0.1 },
		confidence: 0.8,
		requestMs: 21.5,
		request,
	};
}
function planDecision(request: PlanRequest) {
	return {
		kind: "plan",
		model: request.model,
		choice: "up_up",
		probabilities: Object.fromEntries(
			planChoices.map((choice) => [choice, choice === "up_up" ? 0.99 : 0]),
		),
		confidence: 0.8,
		requestMs: 21.5,
		request,
	};
}
function growthPlan() {
	const state = baseState();
	state.apple = { x: state.snake[0].x + 1, y: state.snake[0].y };
	return planBody(publicState(state));
}

describe("versioned context contracts", () => {
	test("preserves unversioned/v1/v2 coordinate bodies without migration", () => {
		for (const request of [
			...Object.values(legacy),
			...Object.values(v2).map((f) => f.single),
		]) {
			expect(decisionRequestSchema.parse(request)).toEqual(request);
			expect(decisionSchema.parse(singleDecision(request))).toEqual(
				singleDecision(request),
			);
		}
		for (const { plan } of Object.values(v2)) {
			expect(planRequestSchema.parse(plan)).toEqual(plan);
			const v1Plan = structuredClone(plan);
			v1Plan.state.contextVersion = "two-step-plan-v1";
			expect(planRequestSchema.parse(v1Plan)).toEqual(v1Plan);
			expect(planDecisionSchema.parse(planDecision(v1Plan))).toEqual(
				planDecision(v1Plan),
			);
		}
	});

	test("retains legacy projected timing rather than relabeling it as observed", () => {
		const request = structuredClone(legacy.unversioned);
		request.state.timing = {
			stateIsProjected: true,
			projectedBeforeTick: 3,
			gameTimeMs: 1000,
			tickIntervalMs: 500,
		};
		expect(decisionRequestSchema.parse(request)).toEqual(request);
	});

	test.each(Object.keys(contextFixtures) as (keyof typeof contextFixtures)[])(
		"accepts actual v3 single and plan builders for %s",
		(fixture) => {
			const state = publicState(contextFixtures[fixture]());
			const single = decisionBody(state);
			const plan = planBody(state);
			expect(decisionRequestSchema.parse(single)).toEqual(single);
			expect(planRequestSchema.parse(plan)).toEqual(plan);
			expect(Object.keys(single.questions.direction.criteria)).toEqual([
				...directions,
			]);
			expect(Object.keys(plan.state.firstActions)).toEqual([...directions]);
			expect(Object.keys(plan.questions.plan.criteria)).toEqual(planChoices);
		},
	);

	test("accepts response single-step context with explicitly unknown fixed timing", () => {
		const state = baseState();
		state.config = {
			...state.config,
			stepMode: "response",
			decisionMode: "single_step",
			tickIntervalMs: null,
		};
		const request = decisionBody(publicState(state));
		expect(request.state.timing).toMatchObject({
			stepMode: "response",
			tickIntervalMs: null,
			deadlineInMs: null,
		});
		expect(decisionRequestSchema.parse(request)).toEqual(request);
	});

	test("rejects every omitted direction, first action, and pair", () => {
		for (const direction of directions) {
			const single = decisionBody(publicState(baseState()));
			Reflect.deleteProperty(single.questions.direction.criteria, direction);
			expect(
				decisionRequestSchema.safeParse(single).success,
				`single ${direction}`,
			).toBe(false);
			const plan = planBody(publicState(baseState()));
			Reflect.deleteProperty(plan.state.firstActions, direction);
			expect(
				planRequestSchema.safeParse(plan).success,
				`first ${direction}`,
			).toBe(false);
		}
		for (const choice of planChoices) {
			const plan = planBody(publicState(baseState()));
			Reflect.deleteProperty(plan.questions.plan.criteria, choice);
			expect(planRequestSchema.safeParse(plan).success, choice).toBe(false);
		}
	});

	test("rejects unknown versions and v3 bodies mislabeled as historical", () => {
		for (const version of [
			undefined,
			"action-facts-v1",
			"action-facts-v2",
			"action-facts-v5",
			"two-step-plan-v3",
		]) {
			const request = decisionBody(publicState(baseState()));
			Object.assign(request.state, { contextVersion: version });
			expect(
				decisionRequestSchema.safeParse(request).success,
				String(version),
			).toBe(false);
		}
		for (const version of [
			undefined,
			"two-step-plan-v1",
			"two-step-plan-v2",
			"two-step-plan-v5",
			"action-facts-v3",
		]) {
			const request = planBody(publicState(baseState()));
			Object.assign(request.state, { contextVersion: version });
			expect(
				planRequestSchema.safeParse(request).success,
				String(version),
			).toBe(false);
		}
		const legacyWithV3Label = structuredClone(legacy.v1);
		Object.assign(legacyWithV3Label.state, {
			contextVersion: "action-facts-v3",
		});
		expect(decisionRequestSchema.safeParse(legacyWithV3Label).success).toBe(
			false,
		);
	});

	test("rejects missing facts and extra coordinate fields instead of stripping them", () => {
		const request = decisionBody(publicState(baseState()));
		Reflect.deleteProperty(request.questions.direction.criteria.up, "space");
		expect(decisionRequestSchema.safeParse(request).success).toBe(false);
		const withBody = decisionBody(publicState(baseState()));
		Object.assign(withBody.state.player, { bodyHeadToTail: baseState().snake });
		expect(decisionRequestSchema.safeParse(withBody).success).toBe(false);
		const withObstacles = decisionBody(publicState(baseState()));
		Object.assign(withObstacles.state.board, { obstacles: [] });
		expect(decisionRequestSchema.safeParse(withObstacles).success).toBe(false);
		const withDuplicate = decisionBody(publicState(baseState()));
		Object.assign(withDuplicate.state, {
			actionFacts: withDuplicate.questions.direction.criteria,
		});
		expect(decisionRequestSchema.safeParse(withDuplicate).success).toBe(false);
	});

	test("requires unknown post-growth second steps to contain collision and reason only", () => {
		const valid = growthPlan();
		expect(valid.questions.plan.criteria.right_up.secondStatus).toBe(
			"unknown_after_growth",
		);
		expect(planRequestSchema.parse(valid)).toEqual(valid);
		for (const property of [
			"eatsApple",
			"forcedPath",
			"space",
			"appleRoute",
			"starRoute",
			"terminal",
		]) {
			const request = growthPlan();
			Object.assign(
				request.questions.plan.criteria.right_up.secondFacts ?? {},
				{ [property]: null },
			);
			expect(planRequestSchema.safeParse(request).success, property).toBe(
				false,
			);
		}
		const missingReason = growthPlan();
		Reflect.deleteProperty(
			missingReason.questions.plan.criteria.right_up.secondFacts ?? {},
			"reason",
		);
		expect(planRequestSchema.safeParse(missingReason).success).toBe(false);
		const mislabeledKnown = growthPlan();
		Object.assign(mislabeledKnown.questions.plan.criteria.right_up, {
			secondStatus: "known",
		});
		expect(planRequestSchema.safeParse(mislabeledKnown).success).toBe(false);
	});

	test("preserves known/blocked/complete pair branches and rejects inconsistent pair associations", () => {
		const plan = planBody(publicState(baseState()));
		expect(plan.questions.plan.criteria.up_up.secondStatus).toBe("known");
		expect(plan.questions.plan.criteria.left_up).toMatchObject({
			secondStatus: "not_executed_first_blocked",
			secondFacts: null,
		});
		const completed = planBody(publicState(nearComplete()));
		expect(completed.questions.plan.criteria.right_up).toMatchObject({
			secondStatus: "not_executed_board_complete",
			secondFacts: null,
		});
		expect(planRequestSchema.parse(completed)).toEqual(completed);
		Object.assign(plan.questions.plan.criteria.up_up, { first: "right" });
		expect(planRequestSchema.safeParse(plan).success).toBe(false);
		const contradicted = growthPlan();
		Object.assign(contradicted.questions.plan.criteria.right_up, {
			secondStatus: "known",
			secondFacts: planBody(publicState(baseState())).state.firstActions.up,
		});
		expect(planRequestSchema.safeParse(contradicted).success).toBe(false);
	});

	test("distinguishes null not-applicable data from unrecorded, false, and zero", () => {
		const request = decisionBody(publicState(baseState()));
		expect(request.questions.direction.criteria.left).toMatchObject({
			immediateCollision: "reverse",
			space: null,
			forcedPath: null,
			appleRoute: {
				status: "not_applicable",
				distance: null,
				verified: null,
				postEat: null,
			},
		});
		const missing = structuredClone(request);
		Reflect.deleteProperty(
			missing.questions.direction.criteria.left.appleRoute,
			"postEat",
		);
		expect(decisionRequestSchema.safeParse(missing).success).toBe(false);
		const fakeCount = structuredClone(request);
		Object.assign(fakeCount.questions.direction.criteria.left.appleRoute, {
			distance: 0,
			verified: false,
		});
		expect(decisionRequestSchema.safeParse(fakeCount).success).toBe(false);
		const blockedSpace = structuredClone(request);
		blockedSpace.questions.direction.criteria.left.space =
			request.questions.direction.criteria.up.space;
		expect(decisionRequestSchema.safeParse(blockedSpace).success).toBe(false);
		const noEscapeEvidence = structuredClone(request);
		noEscapeEvidence.questions.direction.criteria.up.space = null;
		expect(decisionRequestSchema.safeParse(noEscapeEvidence).success).toBe(
			false,
		);
	});

	test("requires verified apple routes to include growth evidence and invalid routes to include failure", () => {
		const request = decisionBody(publicState(baseState()));
		expect(request.questions.direction.criteria.up.appleRoute.status).toBe(
			"path_found",
		);
		Object.assign(request.questions.direction.criteria.up.appleRoute, {
			postEat: null,
		});
		expect(decisionRequestSchema.safeParse(request).success).toBe(false);
		const invalid = decisionBody(publicState(baseState()));
		invalid.questions.direction.criteria.up.appleRoute = {
			status: "candidate_invalid",
			distance: 3,
			verified: false,
			postEat: null,
			failure: { step: 2, collision: "body" },
		};
		expect(decisionRequestSchema.parse(invalid)).toEqual(invalid);
		Reflect.deleteProperty(
			invalid.questions.direction.criteria.up.appleRoute,
			"failure",
		);
		expect(decisionRequestSchema.safeParse(invalid).success).toBe(false);
		const victory = decisionBody(publicState(nearComplete()));
		expect(victory.questions.direction.criteria.right.appleRoute).toMatchObject(
			{
				status: "eaten_now",
				distance: 1,
				postEat: { terminal: "board_complete", legalNextMoves: null },
			},
		);
		Object.assign(
			victory.questions.direction.criteria.right.appleRoute.postEat ?? {},
			{ legalNextMoves: 0 },
		);
		expect(decisionRequestSchema.safeParse(victory).success).toBe(false);
	});

	test("keeps v3 timing modes distinct and never accepts projected v3 state", () => {
		for (const timing of [
			{ stepMode: "fixed", tickIntervalMs: null },
			{ stepMode: "fixed", tickIntervalMs: 0 },
			{ stepMode: "response", tickIntervalMs: 500 },
			{ stepMode: "response", tickIntervalMs: null, deadlineInMs: 500 },
			{ stateIsProjected: true },
			{ stepMode: undefined },
		]) {
			const request = decisionBody(publicState(baseState()));
			Object.assign(request.state.timing, timing);
			expect(
				decisionRequestSchema.safeParse(request).success,
				JSON.stringify(timing),
			).toBe(false);
		}
		const plan = planBody(publicState(baseState()));
		Object.assign(plan.state.timing, {
			stepMode: "response",
			tickIntervalMs: null,
			deadlineInMs: null,
		});
		expect(planRequestSchema.safeParse(plan).success).toBe(false);
	});

	test("accepts optional diagnostics in existing protocol envelopes without normalizing probabilities", () => {
		const request = decisionBody(publicState(baseState()));
		const decision = {
			...singleDecision(request),
			contextBuildMs: 0.125,
			requestBytes: Buffer.byteLength(JSON.stringify(request)),
			inputTokens: 42,
		};
		const action = {
			protocolVersion: 1,
			type: "action",
			requestId: "context-v3",
			observedSeq: 0,
			targetTick: 1,
			expectedStateHash: "a".repeat(64),
			direction: "up",
			decision,
		};
		expect(allControlSchema.parse(action)).toEqual(action);
		expect(decisionSchema.parse(singleDecision(legacy.v1))).not.toHaveProperty(
			"contextBuildMs",
		);
		expect(decisionSchema.parse(singleDecision(legacy.v1))).not.toHaveProperty(
			"requestBytes",
		);
		const plan = planBody(publicState(baseState()));
		const control = {
			...action,
			protocolVersion: 2,
			type: "plan",
			directions: ["up", "up"],
			decision: {
				...planDecision(plan),
				contextBuildMs: 1.25,
				requestBytes: Buffer.byteLength(JSON.stringify(plan)),
			},
		};
		Reflect.deleteProperty(control, "direction");
		expect(allControlSchema.parse(control)).toEqual(control);
		for (const diagnostic of [
			{ contextBuildMs: -1 },
			{ contextBuildMs: NaN },
			{ requestBytes: -1 },
			{ requestBytes: 1.5 },
			{ requestBytes: NaN },
		]) {
			expect(
				decisionSchema.safeParse({ ...decision, ...diagnostic }).success,
				JSON.stringify(diagnostic),
			).toBe(false);
			expect(
				planDecisionSchema.safeParse({ ...control.decision, ...diagnostic })
					.success,
				JSON.stringify(diagnostic),
			).toBe(false);
		}
	});
});
