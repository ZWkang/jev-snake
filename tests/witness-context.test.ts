import { expect, test, vi } from "vitest";
import { move } from "../server/game/engine.js";
import {
	askJev,
	buildDecisionContext,
	buildPlanContext,
	decisionBodyV3,
	planBodyV3,
} from "../server/jev/client.js";
import {
	witnessContinuity,
	witnessDirections,
} from "../server/jev/witness-context.js";
import {
	decisionRequestSchema,
	decisionSchema,
	planRequestSchema,
} from "../shared/snake/schema.js";
import { directions, planChoices, publicState } from "../shared/snake/types.js";
import { witnessArchiveSchema } from "../shared/snake/witness-schema.js";
import { presentDecisionContext } from "../src/features/snake/contextPresentation.js";
import { baseState, nearComplete } from "./context-fixture.js";

test("v4 retains four symmetric choices and archives witnesses outside the provider request", () => {
	const state = publicState(baseState());
	const before = structuredClone(state);
	const built = buildDecisionContext(state);
	expect(decisionRequestSchema.parse(built.request)).toEqual(built.request);
	expect(witnessArchiveSchema.parse(built.evidence)).toEqual(built.evidence);
	expect(Object.keys(built.request.questions.direction.criteria)).toEqual(
		directions,
	);
	expect(built.request.questions.direction.instructions).not.toMatch(
		/Proven trapped regions|Priority|recommendedDirection/,
	);
	expect(JSON.stringify(built.request)).not.toMatch(
		/prefixDirections|cycleDirections|"evidence"/,
	);
	for (const direction of directions) {
		const opportunity =
			built.request.questions.direction.criteria[direction].opportunity;
		if (!opportunity.witnessId) continue;
		const record = built.evidence.records[opportunity.witnessId];
		expect(witnessDirections(record)[0]).toBe(direction);
		expect(witnessDirections(record)).toHaveLength(opportunity.moves!);
	}
	expect(state).toEqual(before);
});

test("v4 rejects missing evidence, mislabeled context and inconsistent conditional second moves while v3 stays readable", () => {
	const state = publicState(baseState());
	expect(decisionRequestSchema.parse(decisionBodyV3(state))).toEqual(
		decisionBodyV3(state),
	);
	expect(planRequestSchema.parse(planBodyV3(state))).toEqual(planBodyV3(state));
	const built = buildDecisionContext(state);
	const missing = JSON.parse(JSON.stringify(built.request));
	delete missing.questions.direction.criteria.up.opportunity;
	expect(decisionRequestSchema.safeParse(missing).success).toBe(false);
	expect(
		decisionRequestSchema.safeParse({
			...built.request,
			state: { ...built.request.state, contextVersion: "action-facts-v3" },
		}).success,
	).toBe(false);
	const plan = buildPlanContext(state);
	expect(planRequestSchema.parse(plan.request)).toEqual(plan.request);
	expect(Object.keys(plan.request.questions.plan.criteria)).toEqual(
		planChoices,
	);
	const bad = structuredClone(plan.request);
	bad.questions.plan.criteria.up_up.first = "right";
	expect(planRequestSchema.safeParse(bad).success).toBe(false);
	const win = buildPlanContext(publicState(nearComplete()));
	expect(win.request.questions.plan.criteria.right_up.secondStatus).toBe(
		"not_executed_board_complete",
	);
	const grows = baseState();
	grows.apple = { x: grows.snake[0].x + 1, y: grows.snake[0].y };
	const growth = buildPlanContext(publicState(grows));
	expect(growth.request.questions.plan.criteria.right_down.secondStatus).toBe(
		"unknown_after_growth",
	);
	expect(
		growth.request.questions.plan.criteria.right_down.secondFacts,
	).not.toHaveProperty("opportunity");
});

test("continuity only reports actual matching prefixes, never advances moves or claims a plan commitment", () => {
	const state = baseState();
	const built = buildDecisionContext(publicState(state));
	const id =
		built.request.questions.direction.criteria.right.opportunity.witnessId!;
	state.lastDecision = {
		model: "test",
		choice: "right",
		probabilities: { right: 1 },
		confidence: 1,
		requestMs: 0,
		evidence: built.evidence,
		requestId: "previous",
		outcome: "applied",
		targetTick: 1,
	};
	expect(witnessContinuity(publicState(state))).toEqual([]);
	move(state, "right");
	const before = structuredClone(state);
	const continuity = witnessContinuity(publicState(state));
	expect(continuity).toContainEqual(
		expect.objectContaining({ witnessId: id, originTick: 0, matchedMoves: 1 }),
	);
	expect(state).toEqual(before);
	state.apple = { x: 0, y: 0 };
	expect(witnessContinuity(publicState(state))).toEqual([]);
	state.apple = before.apple;
	state.snake[0] = { x: 0, y: 0 };
	expect(witnessContinuity(publicState(state))).toEqual([]);
});

test("real transport preserves a losing model choice and saves evidence separately from exact HTTP body", async () => {
	const state = publicState(baseState());
	let sent = "";
	const transport = vi.fn<typeof fetch>(async (_url, init) => {
		sent = String(init?.body);
		return Response.json({
			model: "test-model",
			answers: {
				direction: {
					type: "choice",
					choice: "left",
					probabilities: { up: 0, right: 0, down: 0, left: 1 },
					confidence: 1,
				},
			},
		});
	});
	const decision = await askJev("test-key", state, { fetch: transport });
	expect(decision.choice).toBe("left");
	expect(decision.request).toEqual(JSON.parse(sent));
	expect(JSON.parse(sent)).not.toHaveProperty("evidence");
	expect(Object.keys(decision.evidence!.records).length).toBeGreaterThan(0);
	expect(decisionSchema.parse(decision)).toEqual(decision);
	expect(transport).toHaveBeenCalledTimes(1);
});

test("replay describes stored v4 without enriching its original JSON or historical v3", () => {
	const state = publicState(baseState());
	const request = buildDecisionContext(state).request;
	const view = presentDecisionContext(request);
	expect(view.request).toBe(request);
	expect(view.version).toBe("action-facts-v4");
	expect(view.semantics).toContain("完整路线单独存档");
	expect(view.json).toBe(JSON.stringify(request, null, 2));
	const old = decisionBodyV3(state);
	expect(presentDecisionContext(old).version).toBe("action-facts-v3");
	expect(presentDecisionContext(old).json).not.toContain("witnessContinuity");
});
