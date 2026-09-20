import { expect, test, vi } from "vitest";
import { inspectMove } from "../server/game/engine.js";
import { decisionBodyV5 } from "../server/jev/analysis-context.js";
import { continuationDeathProof } from "../server/jev/branch-death.js";
import { sendJevRequest } from "../server/jev/client.js";
import {
	advanceGeometry,
	analyzeAction,
	analyzeSecondActions,
} from "../server/jev/context-v3.js";
import { forcedPath } from "../server/jev/context.js";
import { trapInstructions } from "../server/jev/trap-evidence.js";
import {
	type Direction,
	directions,
	type PublicState,
	publicState,
} from "../shared/snake/types.js";
import { baseState, nearComplete } from "./context-fixture.js";
import edgeReplay from "./fixtures/edge-branch-trap.json" with { type: "json" };
import postGrowthReplay from "./fixtures/post-growth-loop-regression.json" with { type: "json" };

const edgeState = () => structuredClone(edgeReplay.state) as PublicState;

test("the real edge fork combines both fatal exits into a six-move upper bound", () => {
	const state = edgeState();
	const before = structuredClone(state);
	expect(forcedPath(state, "right")).toEqual({ outcome: "branch", steps: 1 });
	const entered = advanceGeometry(state, "right");
	expect(continuationDeathProof(entered)).toEqual({
		collisionWithinMoves: 6,
		forcedPrefixMoves: 0,
		branchHead: { x: 11, y: 5 },
		branches: [
			{
				direction: "up",
				collisionWithinMoves: 6,
				proof: { kind: "forced_path", steps: 6 },
			},
			{
				direction: "down",
				collisionWithinMoves: 4,
				proof: { kind: "forced_path", steps: 4 },
			},
		],
	});
	expect(analyzeAction(state, "right").danger).toBe("proven_fatal");
	expect(analyzeAction(state, "left").danger).toBeNull();
	expect(continuationDeathProof(advanceGeometry(state, "left"))).toBeNull();
	let escaped = state;
	for (const direction of edgeReplay.escapePath as Direction[]) {
		expect(inspectMove(escaped, direction).immediateCollision).toBeNull();
		escaped = advanceGeometry(escaped, direction);
	}
	expect(edgeReplay.escapePath).toHaveLength(26);
	expect(trapInstructions(state)).toContain(
		'"move":"right","collisionWithinMoves":6,"forcedPrefixMoves":0',
	);
	expect(state).toEqual(before);
});

test("the bound matches every legal continuation rather than a chosen route", () => {
	let frontier = [advanceGeometry(edgeState(), "right")];
	for (let step = 1; step <= 6; step++) {
		frontier = frontier.flatMap((state) =>
			directions.flatMap((direction) =>
				inspectMove(state, direction).immediateCollision === null
					? [advanceGeometry(state, direction)]
					: [],
			),
		);
		if (step < 6) expect(frontier.length).toBeGreaterThan(0);
	}
	expect(frontier).toEqual([]);
});

test("one unproven exit prevents an all-branches death certificate", () => {
	const state = edgeState();
	state.config.width = 13;
	const entered = advanceGeometry(state, "right");
	expect(inspectMove(entered, "right").immediateCollision).toBeNull();
	expect(continuationDeathProof(entered)).toBeNull();
	expect(analyzeAction(state, "right").danger).toBeNull();
});

test("a unique prefix contributes to the bound before its first fatal fork", () => {
	const state = publicState(baseState());
	state.config.width = 5;
	state.config.height = 3;
	state.direction = "right";
	state.snake = [3, 2, 1].map((x) => ({ x, y: 1 }));
	state.obstacles = [
		{ x: 2, y: 0 },
		{ x: 3, y: 0 },
		{ x: 2, y: 2 },
		{ x: 3, y: 2 },
	];
	state.apple = { x: 0, y: 0 };
	expect(continuationDeathProof(state)).toMatchObject({
		collisionWithinMoves: 3,
		forcedPrefixMoves: 1,
		branchHead: { x: 4, y: 1 },
		branches: [
			{ direction: "up", collisionWithinMoves: 2 },
			{ direction: "down", collisionWithinMoves: 2 },
		],
	});
});

test("full ordered-body cycles remain unproven and tail release is legal", () => {
	const state = publicState(baseState());
	state.direction = "left";
	state.snake = [
		{ x: 0, y: 0 },
		{ x: 1, y: 0 },
		{ x: 1, y: 1 },
		{ x: 0, y: 1 },
	];
	state.obstacles = [
		{ x: 0, y: 2 },
		{ x: 1, y: 2 },
		{ x: 2, y: 0 },
		{ x: 2, y: 1 },
	];
	expect(inspectMove(state, "down").immediateCollision).toBeNull();
	expect(forcedPath(state, "down").outcome).toBe("cycle");
	const before = structuredClone(state);
	expect(continuationDeathProof(state)).toBeNull();
	expect(state).toEqual(before);
});

test("a temporarily enclosed region can escape when the boundary tail vacates", () => {
	const state = publicState(baseState());
	state.config.width = 7;
	state.config.height = 5;
	state.direction = "down";
	state.snake = [
		[1, 1],
		[1, 0],
		[2, 0],
		[3, 0],
		[4, 0],
		[4, 1],
	].map(([x, y]) => ({ x, y }));
	state.obstacles = [
		[0, 1],
		[0, 2],
		[3, 1],
		[3, 2],
		[1, 3],
		[2, 3],
	].map(([x, y]) => ({ x, y }));
	state.apple = { x: 6, y: 4 };
	expect(continuationDeathProof(state)).toBeNull();
	let position = state;
	for (const direction of [
		"down",
		"right",
		"up",
		"up",
		"right",
		"right",
	] as const) {
		expect(inspectMove(position, direction).immediateCollision).toBeNull();
		position = advanceGeometry(position, direction);
	}
});

test("unknown later apples and a possible board-complete win never become death proofs", () => {
	const state = publicState(nearComplete());
	expect(continuationDeathProof(state)).toBeNull();
	expect(continuationDeathProof(advanceGeometry(state, "right"))).toBeNull();
	state.snake = [3, 2, 1, 0].map((x) => ({ x, y: 0 }));
	state.apple = { x: 4, y: 0 };
	expect(forcedPath(state, "right").outcome).toBe("unknown_after_apple");
	expect(continuationDeathProof(state)).toBeNull();
	expect(trapInstructions(state)).not.toContain("Proven continuation deaths");
	for (const pair of Object.values(analyzeSecondActions(state, "right")))
		expect(pair.secondStatus).toBe("unknown_after_growth");
});

test("known apple growth may contribute its independent proof without predicting respawn", () => {
	const state = postGrowthReplay.state as PublicState;
	const proof = continuationDeathProof(state);
	expect(proof).toBeNull(); // Its other exit remains unproven.
	const forced = structuredClone(state);
	const left = inspectMove(forced, "left").target;
	forced.obstacles.push(left);
	expect(continuationDeathProof(forced)).toMatchObject({
		collisionWithinMoves: 4,
		branches: [
			{
				direction: "down",
				collisionWithinMoves: 4,
				proof: { kind: "post_apple_forced_death", collisionWithinMoves: 3 },
			},
		],
	});
});

test("known second-step facts carry the same certificate and growth stays unknown", () => {
	const state = edgeState();
	const previous: PublicState = {
		...state,
		snake: [...state.snake.slice(1), { x: 8, y: 6 }],
	};
	expect(advanceGeometry(previous, "up").snake).toEqual(state.snake);
	expect(analyzeSecondActions(previous, "up").right).toMatchObject({
		secondStatus: "known",
		secondFacts: { danger: "proven_fatal" },
	});
	expect(trapInstructions(previous, true)).toContain(
		'"move":"second:up_right","collisionWithinMoves":6',
	);
	previous.apple = { ...state.snake[0] };
	for (const pair of Object.values(analyzeSecondActions(previous, "up")))
		expect(pair.secondStatus).toBe("unknown_after_growth");
	expect(trapInstructions(previous, true)).not.toContain('"move":"second:up_');
});

test("offline v5 transport preserves a model choice whose option carries a fatal certificate", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
		Response.json({
			model: "test-only-model-choice",
			answers: {
				direction: {
					type: "choice",
					choice: "right",
					probabilities: { up: 0, right: 1, down: 0, left: 0 },
					confidence: 1,
				},
			},
		}),
	);
	const { decision } = await sendJevRequest(
		"test-only-credential",
		decisionBodyV5(edgeState()),
		{ fetch },
	);
	const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
	expect(Object.keys(body.questions.direction.criteria)).toEqual([
		...directions,
	]);
	expect(body.questions.direction.criteria.right.survival.status).toBe(
		"proven_fatal",
	);
	expect(body.questions.direction.criteria.left.survival.status).toBe(
		"not_proven_fatal",
	);
	expect(decision.choice).toBe("right");
	expect(decision.request).toEqual(body);
	expect(fetch).toHaveBeenCalledTimes(1);
});
