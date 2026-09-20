import { expect, test, vi } from "vitest";
import {
	buildDecisionContextV5 as buildDecisionContext,
	buildDecisionContextV4,
	decisionBodyV3,
} from "../server/jev/analysis-context.js";
import { sendJevRequest } from "../server/jev/client.js";
import {
	decisionRequestSchema,
	decisionSchema,
} from "../shared/snake/schema.js";
import {
	directions,
	publicState,
	type MatchState,
} from "../shared/snake/types.js";
import { presentDecisionContext } from "../src/features/snake/contextPresentation.js";
import { baseState, nearComplete } from "./context-fixture.js";
import large from "./fixtures/action-outcome-2e220.json" with { type: "json" };
import small from "./fixtures/action-outcome-7x5.json" with { type: "json" };
import loop from "./fixtures/apple-alternative-loop-34eb9.json" with { type: "json" };

const checkpoint = (fixture: typeof large) =>
	publicState(
		Object.assign(baseState(), structuredClone(fixture.geometry), {
			tick: fixture.source.tick,
			seq: fixture.source.seq,
		}) as MatchState,
	);

test("v5 places the 11-step reward and unavoidable 13-step death in the same option without old direction cues", () => {
	const state = checkpoint(large);
	const before = structuredClone(state);
	const built = buildDecisionContext(state);
	expect(built.request.state.contextVersion).toBe("action-outcomes-v5");
	expect(Object.keys(built.request.questions.direction.criteria)).toEqual(
		directions,
	);
	const up = built.request.questions.direction.criteria.up;
	expect(up).toMatchObject({
		survival: { status: "proven_fatal", collisionWithinMoves: 13 },
		appleRoute: {
			status: "verified_route",
			moves: 11,
			postApple: {
				status: "proven_fatal",
				collisionWithinMoves: 2,
				collisionWithinMovesFromObservation: 13,
			},
		},
	});
	expect(up.summary).toContain("every continuation collides within 13 moves");
	expect(up.summary).toContain("11 moves");
	expect(up.summary).toContain("does not remove the fatal conclusion");
	expect(built.request.questions.direction.criteria.down).toMatchObject({
		survival: { status: "not_proven_fatal" },
		appleRoute: { moves: 23, postApple: { status: "not_proven_fatal" } },
	});
	expect(JSON.stringify(built.request)).not.toMatch(
		/witnessContinuity|nextDirection|witnessId|opportunity|prefixDirections|recommendedDirection/,
	);
	expect(decisionRequestSchema.parse(built.request)).toEqual(built.request);
	expect(Object.keys(built.evidence.records).length).toBeGreaterThan(0);
	expect(state).toEqual(before);
});

test("a fatal first food witness does not hide alternative growth geometries", () => {
	const request = buildDecisionContext(checkpoint(small)).request;
	for (const direction of ["right", "down"] as const) {
		const option = request.questions.direction.criteria[direction];
		expect(option.survival.status).toBe("not_proven_fatal");
		expect(option.appleRoute.postApple?.status).toBe("not_proven_fatal");
		expect(option.appleRoute.moves).toBe(23);
		expect(option.appleAlternativeSearch?.status).toBe("endpoint_found");
		expect(option.summary).toContain("initial");
	}
	expect(request.questions.direction.criteria.left.survival).toMatchObject({
		status: "proven_fatal",
		collisionWithinMoves: 3,
	});
});

test("the observed 34-step loop receives the six-step alternative without an instruction to follow it", () => {
	const built = buildDecisionContext(checkpoint(loop));
	const up = built.request.questions.direction.criteria.up;
	expect(up.appleRoute).toMatchObject({
		moves: 6,
		postApple: { status: "not_proven_fatal" },
	});
	expect(up.appleAlternativeSearch).toMatchObject({
		status: "endpoint_found",
		initialRouteMoves: 4,
	});
	expect(Object.keys(built.request.questions.direction.criteria)).toEqual(
		directions,
	);
	expect(decisionRequestSchema.parse(built.request)).toEqual(built.request);
	expect(JSON.stringify(built.request)).not.toMatch(
		/nextDirection|recommendedDirection|witnessId|prefixDirections/,
	);
	const historical = structuredClone(built.request);
	for (const direction of directions)
		delete historical.questions.direction.criteria[direction]
			.appleAlternativeSearch;
	expect(decisionRequestSchema.parse(historical)).toEqual(historical);
	const wrong = structuredClone(built.request);
	wrong.questions.direction.criteria.up.appleAlternativeSearch!.status =
		"exhausted";
	expect(decisionRequestSchema.safeParse(wrong).success).toBe(false);
});

test("v5 contract rejects missing choices, recycled v4 fields and inconsistent proof scopes", () => {
	const request = buildDecisionContext(checkpoint(large)).request;
	for (const direction of directions) {
		const missing = structuredClone(request);
		Reflect.deleteProperty(missing.questions.direction.criteria, direction);
		expect(decisionRequestSchema.safeParse(missing).success).toBe(false);
	}
	const historyCue = {
		...request,
		state: { ...request.state, witnessContinuity: [] },
	};
	expect(decisionRequestSchema.safeParse(historyCue).success).toBe(false);
	const mislabeled = {
		...request,
		state: { ...request.state, contextVersion: "action-facts-v4" },
	};
	expect(decisionRequestSchema.safeParse(mislabeled).success).toBe(false);
	const invalidBound = structuredClone(request);
	invalidBound.questions.direction.criteria.up.appleRoute.postApple!.collisionWithinMovesFromObservation = 2;
	expect(decisionRequestSchema.safeParse(invalidBound).success).toBe(false);
	const falseDeath = structuredClone(request);
	falseDeath.questions.direction.criteria.down.survival.status = "proven_fatal";
	expect(decisionRequestSchema.safeParse(falseDeath).success).toBe(false);
	const wrongReverse = structuredClone(request);
	wrongReverse.questions.direction.criteria.right.survival.collisionWithinMoves = 1;
	expect(decisionRequestSchema.safeParse(wrongReverse).success).toBe(false);
});

test("winning and historical bodies remain distinct and unmodified in presentation", () => {
	const win = buildDecisionContext(publicState(nearComplete())).request;
	expect(win.questions.direction.criteria.right.survival.status).toBe(
		"board_complete",
	);
	expect(decisionRequestSchema.parse(win)).toEqual(win);
	const observed = checkpoint(large);
	for (const old of [
		decisionBodyV3(observed),
		buildDecisionContextV4(observed).request,
	]) {
		expect(decisionRequestSchema.parse(old)).toEqual(old);
		expect(presentDecisionContext(old).json).toBe(JSON.stringify(old, null, 2));
	}
	const view = presentDecisionContext(win);
	expect(view.version).toBe("action-outcomes-v5");
	expect(view.request).toBe(win);
	expect(view.semantics).toContain("所有续路");
	expect(view.json).not.toContain("witnessContinuity");
});

test("offline v5 transport preserves a losing choice and keeps the archive separate", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(async () =>
		Response.json({
			model: "test-model",
			answers: {
				direction: {
					type: "choice",
					choice: "up",
					probabilities: { up: 1, right: 0, down: 0, left: 0 },
					confidence: 1,
				},
			},
		}),
	);
	const built = buildDecisionContext(checkpoint(large));
	const { decision } = await sendJevRequest("test-credential", built.request, {
		fetch,
		evidence: built.evidence,
	});
	const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
	expect(body.questions.direction.criteria.up.survival.status).toBe(
		"proven_fatal",
	);
	expect(decision.choice).toBe("up");
	expect(decision.probabilities.up).toBe(1);
	expect(decision.request).toEqual(body);
	expect(body).not.toHaveProperty("evidence");
	expect(decision.evidence?.version).toBe("positive-v1");
	expect(decisionSchema.parse(decision)).toEqual(decision);
	expect(fetch).toHaveBeenCalledTimes(1);
});
