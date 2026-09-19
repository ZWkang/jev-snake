import { describe, expect, test } from "vitest";
import { decisionBody } from "../server/jev/client.js";
import { planBody } from "../server/jev/legacy-context.js";
import { actionSummarySchema } from "../shared/snake/context-schema.js";
import {
	decisionRequestSchema,
	planRequestSchema,
} from "../shared/snake/schema.js";
import { publicState } from "../shared/snake/types.js";
import { baseState, deadEndReplay, nearComplete } from "./context-fixture.js";

describe("explicit danger evidence", () => {
	test("keeps historical v3 single and plan requests without danger unchanged", () => {
		const single = decisionBody(publicState(baseState()));
		const plan = planBody(publicState(baseState()));
		for (const facts of Object.values(single.questions.direction.criteria))
			delete facts.danger;
		for (const facts of Object.values(plan.state.firstActions))
			delete facts.danger;
		for (const pair of Object.values(plan.questions.plan.criteria)) {
			if (pair.secondStatus === "known") delete pair.secondFacts.danger;
		}
		expect(decisionRequestSchema.parse(single)).toEqual(single);
		expect(planRequestSchema.parse(plan)).toEqual(plan);
		expect(single.questions.direction.criteria.up).not.toHaveProperty("danger");
	});

	test("accepts explicit collision and proven fatal evidence in actual requests", () => {
		const single = decisionBody(publicState(deadEndReplay()));
		expect(single.questions.direction.criteria.left.forcedPath?.outcome).toBe(
			"forced_collision",
		);
		single.questions.direction.criteria.left.danger = "proven_fatal";
		const plan = planBody(publicState(baseState()));
		plan.state.firstActions.left.danger = "immediate_collision";
		expect(decisionRequestSchema.parse(single)).toEqual(single);
		expect(planRequestSchema.parse(plan)).toEqual(plan);
	});

	test("requires immediate collisions to carry their own danger label", () => {
		const facts = decisionBody(publicState(baseState())).questions.direction
			.criteria.left;
		expect(facts.immediateCollision).toBe("reverse");
		for (const danger of [null, "proven_fatal"] as const)
			expect(actionSummarySchema.safeParse({ ...facts, danger }).success).toBe(
				false,
			);
	});

	test("rejects immediate danger on a movable action", () => {
		const request = decisionBody(publicState(baseState()));
		request.questions.direction.criteria.up.danger = "immediate_collision";
		expect(decisionRequestSchema.safeParse(request).success).toBe(false);
	});

	test("requires forced collisions to be fatal rather than unlabeled", () => {
		const request = decisionBody(publicState(deadEndReplay()));
		request.questions.direction.criteria.left.danger = null;
		expect(decisionRequestSchema.safeParse(request).success).toBe(false);
		const plan = planBody(publicState(deadEndReplay()));
		plan.state.firstActions.left.danger = null;
		expect(planRequestSchema.safeParse(plan).success).toBe(false);
	});

	test("keeps a completed board's danger null", () => {
		const request = decisionBody(publicState(nearComplete()));
		const facts = request.questions.direction.criteria.right;
		facts.danger = null;
		expect(decisionRequestSchema.parse(request)).toEqual(request);
		facts.danger = "proven_fatal";
		expect(decisionRequestSchema.safeParse(request).success).toBe(false);
	});

	test("allows static fatal evidence at a branch without calling other branches safe", () => {
		const request = decisionBody(publicState(baseState()));
		const facts = request.questions.direction.criteria.up;
		expect(facts.forcedPath?.outcome).toBe("branch");
		for (const danger of [null, "proven_fatal"] as const) {
			facts.danger = danger;
			expect(decisionRequestSchema.parse(request)).toEqual(request);
		}
		Object.assign(facts, { danger: "safe" });
		expect(decisionRequestSchema.safeParse(request).success).toBe(false);
	});

	test("applies danger validation to known second moves", () => {
		const plan = planBody(publicState(baseState()));
		const pair = plan.questions.plan.criteria.up_up;
		expect(pair.secondStatus).toBe("known");
		if (pair.secondStatus !== "known") throw new Error("Expected known pair");
		pair.secondFacts.danger = "immediate_collision";
		expect(planRequestSchema.safeParse(plan).success).toBe(false);
	});

	test("does not add a danger field to unknown post-growth second moves", () => {
		const state = baseState();
		state.apple = { x: state.snake[0].x + 1, y: state.snake[0].y };
		const plan = planBody(publicState(state));
		const pair = plan.questions.plan.criteria.right_up;
		expect(pair.secondStatus).toBe("unknown_after_growth");
		expect(planRequestSchema.parse(plan)).toEqual(plan);
		expect(pair.secondFacts).not.toHaveProperty("danger");
		Object.assign(pair.secondFacts ?? {}, { danger: null });
		expect(planRequestSchema.safeParse(plan).success).toBe(false);
	});
});
