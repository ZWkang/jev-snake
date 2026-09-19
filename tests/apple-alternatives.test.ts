import { expect, test } from "vitest";
import { inspectMove, move } from "../server/game/engine.js";
import { analyzeAppleAlternatives } from "../server/jev/apple-alternatives.js";
import { createDeathAnalyzer } from "../server/jev/branch-death.js";
import { analyzePositiveEvidence } from "../server/jev/positive-evidence.js";
import {
	type Direction,
	type MatchState,
	publicState,
} from "../shared/snake/types.js";
import { baseState, nearComplete } from "./context-fixture.js";
import small from "./fixtures/action-outcome-7x5.json" with { type: "json" };
import loop from "./fixtures/apple-alternative-loop-34eb9.json" with { type: "json" };

function checkpoint(fixture: typeof loop) {
	return Object.assign(baseState(), structuredClone(fixture.geometry), {
		tick: fixture.source.tick,
		seq: fixture.source.seq,
	}) as MatchState;
}
function verifyAlternative(state: MatchState, direction: Direction) {
	const original = structuredClone(state);
	const analyzer = createDeathAnalyzer();
	const result = analyzeAppleAlternatives(
		publicState(state),
		direction,
		analyzer,
	);
	expect(result.evidence).not.toBeNull();
	if (!result.evidence) throw new Error("Expected an alternative apple route");
	const route = result.evidence.witness.directions;
	expect(route[0]).toBe(direction);
	const replay = structuredClone(state);
	for (const [index, moveDirection] of route.entries()) {
		expect(inspectMove(replay, moveDirection).immediateCollision).toBeNull();
		const event = move(replay, moveDirection);
		if (index === route.length - 1)
			expect(["apple", "won"]).toContain(event.type);
		else expect(["move", "star"]).toContain(event.type);
	}
	expect(replay.snake).toEqual(result.evidence.witness.end.snake);
	expect(replay.direction).toBe(result.evidence.witness.end.direction);
	expect(replay.applesEaten).toBe(state.applesEaten + 1);
	expect(
		analyzer.postApple({
			...publicState(state),
			...result.evidence.witness.end,
		}),
	).toBeNull();
	expect(state).toEqual(original);
	return result;
}

test("tick908 has a six-move apple route after the old first-found endpoint dies", () => {
	const state = checkpoint(loop);
	const old = analyzePositiveEvidence(publicState(state), "up");
	if (old.status !== "apple_route_found")
		throw new Error("Expected the recorded initial route");
	expect(old.witness.directions).toEqual(["up", "left", "down", "down"]);
	expect(
		createDeathAnalyzer().postApple({
			...publicState(state),
			...old.witness.end,
		}),
	).toMatchObject({ collisionWithinMoves: 1 });
	const alternative = verifyAlternative(state, "up");
	expect(alternative.evidence?.witness.directions).toEqual([
		"up",
		"left",
		"left",
		"down",
		"right",
		"down",
	]);
	expect(alternative.expandedStates).toBe(11);
	expect(alternative.fatalAppleEndpoints).toBe(2);
});

test("the other first move has a replayable forty-move route to a different apple endpoint", () => {
	const alternative = verifyAlternative(checkpoint(loop), "left");
	expect(alternative.evidence?.witness.directions).toHaveLength(40);
	expect(alternative.expandedStates).toBe(75506);
	expect(alternative.fatalAppleEndpoints).toBe(5392);
});

test("both previously unresolved 7x5 directions have replayable 23-move alternative growth endpoints", () => {
	for (const direction of ["right", "down"] as const) {
		const alternative = verifyAlternative(checkpoint(small), direction);
		expect(alternative.evidence?.witness.directions).toHaveLength(23);
		expect(alternative.expandedStates).toBeGreaterThan(10000);
		expect(alternative.fatalAppleEndpoints).toBeGreaterThan(0);
	}
});

test("complete-state merging exhausts a repeatable cycle whose only apple entrance is a fatal cul-de-sac", () => {
	const state = baseState();
	state.config = { ...state.config, width: 3, height: 2, obstacleCount: 1 };
	state.snake = [
		{ x: 1, y: 0 },
		{ x: 0, y: 0 },
		{ x: 0, y: 1 },
	];
	state.direction = "right";
	state.obstacles = [{ x: 2, y: 1 }];
	state.apple = { x: 2, y: 0 };
	const cycle = structuredClone(state);
	for (let lap = 0; lap < 2; lap++) {
		for (const direction of ["down", "left", "up", "right"] as const)
			expect(move(cycle, direction).type).toBe("move");
		expect(cycle.snake).toEqual(state.snake);
		expect(cycle.direction).toBe(state.direction);
	}
	expect(move(cycle, "right").type).toBe("apple");
	for (const direction of ["up", "right", "down"] as const)
		expect(move(structuredClone(cycle), direction).type).toBe("gameover");
	expect(analyzeAppleAlternatives(publicState(state), "down")).toEqual({
		evidence: null,
		expandedStates: 4,
		fatalAppleEndpoints: 1,
	});
});

test("an immediately winning apple remains a terminal witness and invalid reversal has no search geometry", () => {
	const state = nearComplete();
	const win = verifyAlternative(state, "right");
	expect(win).toMatchObject({
		evidence: { status: "apple_eaten_now", terminal: "board_complete" },
		expandedStates: 0,
		fatalAppleEndpoints: 0,
	});
	expect(analyzeAppleAlternatives(publicState(state), "left")).toEqual({
		evidence: null,
		expandedStates: 0,
		fatalAppleEndpoints: 0,
	});
});
