import { expect, test } from "vitest";
import { move, stateHash } from "../server/game/engine.js";
import { decisionBody } from "../server/jev/client.js";
import { actionFacts, secondStepFacts } from "../server/jev/context.js";
import { planBody } from "../server/jev/legacy-context.js";
import { allControlSchema, planRequestSchema } from "../shared/snake/schema.js";
import { directions, publicState } from "../shared/snake/types.js";
import { baseState, deadEndReplay } from "./context-fixture.js";
import legacyRequests from "./fixtures/context-legacy.json";

test("replay tick 364 exposes the fatal body corridor while preserving the right exit", () => {
	const state = deadEndReplay();
	const before = structuredClone(state);
	const facts = actionFacts(publicState(state));
	expect(facts.left).toMatchObject({
		immediateCollision: null,
		forcedPath: { outcome: "forced_collision", steps: 7 },
	});
	expect(facts.right).toMatchObject({
		immediateCollision: null,
		forcedPath: { outcome: "branch", steps: 1 },
	});
	expect(facts.up.forcedPath).toBeNull();
	expect(facts.down.forcedPath).toBeNull();
	expect(state).toEqual(before);
	for (let i = 0; i < 6; i++) expect(move(state, "left").type).toBe("move");
	expect(move(state, "left")).toMatchObject({
		type: "gameover",
		data: { reason: "self", target: { x: 4, y: 7 } },
	});
	expect(state.tick).toBe(371);
	const escapeState = structuredClone(before);
	for (const direction of [
		"right",
		"right",
		...Array(10).fill("down"),
	] as const) {
		expect(move(escapeState, direction).type).toBe("move");
	}
	expect(escapeState.status).toBe("running");
});

test("a moving tail opens a corridor that looks blocked in the static board", () => {
	const state = baseState();
	state.direction = "down";
	state.snake = [
		[0, 1],
		[0, 0],
		[1, 0],
		[2, 0],
		[3, 0],
		[3, 1],
		[3, 2],
		[2, 2],
	].map(([x, y]) => ({ x, y }));
	state.obstacles = [
		{ x: 1, y: 1 },
		{ x: 0, y: 3 },
		{ x: 1, y: 3 },
	];
	expect(actionFacts(publicState(state)).down.forcedPath).toEqual({
		outcome: "branch",
		steps: 3,
	});
	for (const direction of ["down", "right", "right"] as const)
		expect(move(state, direction).type).toBe("move");
	expect(state.snake[0]).toEqual({ x: 2, y: 2 });
});

test("a forced cycle following the departing tail terminates without being called a dead end", () => {
	const state = baseState();
	state.direction = "left";
	state.snake = [
		[0, 0],
		[1, 0],
		[1, 1],
		[0, 1],
	].map(([x, y]) => ({ x, y }));
	state.obstacles = [
		[0, 2],
		[1, 2],
		[2, 0],
		[2, 1],
	].map(([x, y]) => ({ x, y }));
	expect(actionFacts(publicState(state)).down.forcedPath).toEqual({
		outcome: "cycle",
		steps: 4,
	});
	for (const direction of ["down", "right", "up", "left"] as const)
		expect(move(state, direction).type).toBe("move");
});

test("eating the known apple stops before unknown food respawn without changing state or RNG", () => {
	const state = baseState();
	state.apple = { x: state.snake[0].x + 2, y: state.snake[0].y };
	for (const x of [state.snake[0].x + 1]) {
		state.obstacles.push(
			{ x, y: state.snake[0].y - 1 },
			{ x, y: state.snake[0].y + 1 },
		);
	}
	const before = structuredClone(state);
	expect(actionFacts(publicState(state)).right.forcedPath).toEqual({
		outcome: "unknown_after_apple",
		steps: 2,
	});
	expect(state).toEqual(before);
});

test("filling the board is distinguished from an unknown food respawn", () => {
	const state = baseState();
	state.config.width = 7;
	state.config.height = 1;
	state.snake = [5, 4, 3, 2, 1, 0].map((x) => ({ x, y: 0 }));
	state.direction = "right";
	state.apple = { x: 6, y: 0 };
	expect(actionFacts(publicState(state)).right.forcedPath).toEqual({
		outcome: "board_complete",
		steps: 1,
	});
	expect(move(state, "right").type).toBe("won");
});

test("both request modes transmit the body-corridor facts through the strict control schema", () => {
	const state = deadEndReplay();
	const single = decisionBody(publicState(state));
	expect(single.state.contextVersion).toBe("action-facts-v4");
	expect(single.questions.direction.criteria.left).toMatchObject({
		forcedPath: { outcome: "forced_collision", steps: 7 },
	});
	const action = {
		protocolVersion: 1,
		type: "action",
		requestId: "context-action",
		observedSeq: state.seq,
		targetTick: 365,
		expectedStateHash: stateHash(state),
		direction: "right",
		decision: {
			model: "test",
			choice: "right",
			confidence: 1,
			requestMs: 1,
			probabilities: { up: 0, right: 1, down: 0, left: 0 },
			request: single,
		},
	};
	expect(allControlSchema.parse(action)).toEqual(action);
	const plan = planBody(publicState(state));
	expect(plan.state.contextVersion).toBe("two-step-plan-v4");
	expect(planRequestSchema.parse(plan)).toEqual(plan);
	for (const direction of directions) {
		const { meaning: _meaning, ...fact } =
			single.questions.direction.criteria[direction];
		expect(plan.state.firstActions[direction]).toEqual(fact);
	}
	expect(plan.questions.plan.criteria.right_up).toMatchObject({
		secondStatus: "known",
		secondFacts: { immediateCollision: "body" },
	});
	expect(plan.questions.plan.criteria.right_left).toMatchObject({
		secondStatus: "known",
		secondFacts: { immediateCollision: "reverse" },
	});
	expect(plan.questions.plan.criteria.right_down).toMatchObject({
		secondStatus: "known",
		secondFacts: { immediateCollision: null },
	});
	for (const request of Object.values(legacyRequests)) {
		const legacy = { ...action, decision: { ...action.decision, request } };
		expect(allControlSchema.parse(legacy)).toEqual(legacy);
	}
});

test("two-step facts use the moved body and mark post-apple continuation unknown", () => {
	const replay = deadEndReplay();
	const afterRight = secondStepFacts(publicState(replay), "right");
	expect(afterRight?.up.immediateCollision).toBe("body");
	expect(afterRight?.left.immediateCollision).toBe("reverse");
	expect(afterRight?.down.immediateCollision).toBeNull();
	move(replay, "right");
	expect(move(replay, "up").type).toBe("gameover");
	const state = baseState();
	state.apple = { x: state.snake[0].x + 1, y: state.snake[0].y };
	const before = structuredClone(state);
	const afterApple = secondStepFacts(publicState(state), "right");
	expect(afterApple?.left.immediateCollision).toBe("reverse");
	expect(afterApple?.right.immediateCollision).toBeNull();
	expect(afterApple?.right).not.toHaveProperty("forcedPath");
	expect(
		planBody(publicState(state)).questions.plan.criteria.right_right,
	).toMatchObject({
		secondStatus: "unknown_after_growth",
		secondFacts: { reason: "new_apple_position_unknown" },
	});
	expect(state).toEqual(before);
});
