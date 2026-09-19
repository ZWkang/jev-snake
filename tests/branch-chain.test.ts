import { expect, test } from "vitest";
import { inspectMove } from "../server/game/engine.js";
import { continuationDeathProof } from "../server/jev/branch-death.js";
import {
	advanceGeometry,
	analyzeAction,
	analyzeSecondActions,
} from "../server/jev/context-v3.js";
import { forcedPath } from "../server/jev/context.js";
import {
	type Direction,
	directions,
	type PublicState,
	publicState,
} from "../shared/snake/types.js";
import { baseState, nearComplete } from "./context-fixture.js";
import replay from "./fixtures/multilevel-branch-trap.json" with { type: "json" };

const replayState = () => structuredClone(replay.state) as PublicState;

test("the real nested trap is proven while its live escape remains unproven", () => {
	const state = replayState();
	const proof = continuationDeathProof(advanceGeometry(state, "left"));
	expect(proof).toMatchObject({
		forcedPrefixMoves: 0,
		branchHead: { x: 4, y: 9 },
		branches: [
			{ direction: "up", proof: { kind: "continuation" } },
			{ direction: "left", proof: { kind: "continuation" } },
		],
	});
	expect(proof!.collisionWithinMoves).toBeGreaterThanOrEqual(
		replay.fatalEvidence.collisionWithinMovesAfterCandidate,
	);
	expect(proof!.collisionWithinMoves).toBeLessThanOrEqual(15);
	expect(analyzeAction(state, "left").danger).toBe("proven_fatal");
	expect(analyzeAction(state, "up").danger).toBeNull();
	expect(continuationDeathProof(advanceGeometry(state, "up"))).toBeNull();

	let position = state;
	const path = [
		...replay.escapePath,
		...replay.foodContinuation,
	] as Direction[];
	for (const [index, direction] of path.entries()) {
		const next = inspectMove(position, direction);
		expect(next.immediateCollision).toBeNull();
		expect(next.eatsApple).toBe(index === path.length - 1);
		position = advanceGeometry(position, direction);
	}
	expect(position.snake).toHaveLength(state.snake.length + 1);
	expect(position.snake[0]).toEqual(state.apple);
});

test("every actual legal continuation dies within the composed bound", () => {
	const entered = advanceGeometry(replayState(), "left");
	const proof = continuationDeathProof(entered)!;
	let frontier = [entered];
	const counts = [frontier.length];
	for (let step = 1; step <= proof.collisionWithinMoves; step++) {
		frontier = frontier.flatMap((state) =>
			directions.flatMap((direction) => {
				const next = inspectMove(state, direction);
				if (next.immediateCollision) return [];
				expect(next.eatsApple).toBe(false);
				return [advanceGeometry(state, direction)];
			}),
		);
		counts.push(frontier.length);
		if (frontier.length === 0) break;
	}
	expect(frontier).toEqual([]);
	expect(counts).toEqual(replay.fatalEvidence.frontierCountsAfterCandidate);
	expect(counts.reduce((total, count) => total + count, 0)).toBe(
		replay.fatalEvidence.totalStatesIncludingAfterCandidate,
	);
});

test("the same fact reaches known second actions without crossing unknown growth", () => {
	const state = replayState();
	const previous: PublicState = {
		...state,
		snake: [...state.snake.slice(1), { x: 9, y: 15 }],
	};
	expect(advanceGeometry(previous, "left").snake).toEqual(state.snake);
	const facts = analyzeSecondActions(previous, "left");
	expect(facts.left).toMatchObject({
		secondStatus: "known",
		secondFacts: { danger: "proven_fatal" },
	});
	expect(facts.up).toMatchObject({
		secondStatus: "known",
		secondFacts: { danger: null },
	});
	previous.apple = { ...state.snake[0] };
	for (const pair of Object.values(analyzeSecondActions(previous, "left")))
		expect(pair.secondStatus).toBe("unknown_after_growth");
});

test("multiple uncertified exits remain unknown", () => {
	const state = publicState(baseState());
	expect(
		directions.filter(
			(direction) => inspectMove(state, direction).immediateCollision === null,
		),
	).toHaveLength(3);
	expect(continuationDeathProof(state)).toBeNull();
	// The actual parent also has two exits without a single-junction proof.
	// A nested death fact for left cannot establish that the parent must die.
	expect(continuationDeathProof(replayState())).toBeNull();
});

test("one fatal exit alongside a repeating ordered-body route does not prove death", () => {
	const state = publicState(baseState());
	state.config = { ...state.config, width: 5, height: 4 };
	state.direction = "up";
	state.snake = [
		[1, 1],
		[1, 2],
		[2, 2],
		[2, 1],
	].map(([x, y]) => ({ x, y }));
	state.obstacles = [
		[0, 0],
		[2, 0],
		[0, 1],
		[0, 2],
		[3, 1],
		[3, 2],
		[1, 3],
		[2, 3],
	].map(([x, y]) => ({ x, y }));
	state.apple = { x: 4, y: 3 };
	expect(forcedPath(state, "up").outcome).toBe("forced_collision");
	expect(forcedPath(state, "right").outcome).toBe("cycle");
	expect(continuationDeathProof(state)).toBeNull();
	let position = state;
	for (const direction of ["right", "down", "left", "up"] as const)
		position = advanceGeometry(position, direction);
	expect(position.snake).toEqual(state.snake);
	expect(position.direction).toBe(state.direction);
});

test("an uncertified apple exit and a board-complete win stop the chain", () => {
	const state = publicState(baseState());
	state.config = { ...state.config, width: 6, height: 5 };
	state.direction = "right";
	state.snake = [
		[2, 2],
		[1, 2],
		[0, 2],
		[0, 3],
	].map(([x, y]) => ({ x, y }));
	state.obstacles = [
		[1, 1],
		[3, 1],
		[2, 0],
		[2, 3],
	].map(([x, y]) => ({ x, y }));
	state.apple = { x: 3, y: 2 };
	expect(forcedPath(state, "up").outcome).toBe("forced_collision");
	expect(forcedPath(state, "right").outcome).toBe("unknown_after_apple");
	expect(continuationDeathProof(state)).toBeNull();
	const almostFull = publicState(nearComplete());
	expect(forcedPath(almostFull, "right").outcome).toBe("board_complete");
	expect(continuationDeathProof(almostFull)).toBeNull();
	expect(
		continuationDeathProof(advanceGeometry(almostFull, "right")),
	).toBeNull();
});

test("composing nested certificates preserves source state and game RNG", () => {
	const state = { ...baseState(), ...replayState() };
	const before = structuredClone(state);
	const entered = advanceGeometry(state, "left");
	const enteredBefore = structuredClone(entered);
	const first = continuationDeathProof(entered);
	expect(continuationDeathProof(entered)).toEqual(first);
	expect(first).not.toBeNull();
	expect(entered).toEqual(enteredBefore);
	expect(state).toEqual(before);
	expect(state.rngState).toBe(before.rngState);
});
