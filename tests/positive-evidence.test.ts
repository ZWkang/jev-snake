import { expect, test } from "vitest";
import { inspectMove, move } from "../server/game/engine.js";
import { advanceGeometry, staticFoodPath } from "../server/jev/context-v3.js";
import {
	analyzePositiveEvidence,
	type PositiveEvidence,
	type PositiveGeometry,
} from "../server/jev/positive-evidence.js";
import {
	type Direction,
	directions,
	type MatchState,
	publicState,
} from "../shared/snake/types.js";
import { baseState, nearComplete } from "./context-fixture.js";
import releaseReplay from "./fixtures/positive-release-replay.json" with { type: "json" };

function replayWithEngine(state: MatchState, route: Direction[]) {
	const actual = structuredClone(state);
	for (const [index, direction] of route.entries()) {
		expect(inspectMove(actual, direction).immediateCollision).toBeNull();
		const event = move(actual, direction);
		expect(event.type).not.toBe("gameover");
		if (event.type === "apple" || event.type === "won")
			expect(index).toBe(route.length - 1);
	}
	return actual;
}

function verifyGeometry(actual: MatchState, expected: PositiveGeometry) {
	expect(actual.snake).toEqual(expected.snake);
	expect(actual.direction).toBe(expected.direction);
}

function verifyWitness(state: MatchState, evidence: PositiveEvidence) {
	if (
		evidence.status === "apple_route_found" ||
		evidence.status === "apple_eaten_now"
	) {
		const actual = replayWithEngine(state, evidence.witness.directions);
		verifyGeometry(actual, evidence.witness.end);
		expect(actual.applesEaten).toBe(state.applesEaten + 1);
		expect(evidence.witness.end.apple).toBeNull();
		for (const passage of evidence.witness.releasePassages) {
			expect(state.snake[passage.originalBodyIndex]).toEqual(passage.point);
			expect(passage.earliestReleaseStep).toBe(
				state.snake.length - passage.originalBodyIndex,
			);
			expect(passage.enteredAtStep).toBeGreaterThanOrEqual(
				passage.earliestReleaseStep,
			);
			const entered = replayWithEngine(
				state,
				evidence.witness.directions.slice(0, passage.enteredAtStep),
			);
			expect(entered.snake[0]).toEqual(passage.point);
		}
	} else if (evidence.status === "non_growth_cycle") {
		const { witness } = evidence;
		expect(witness.prefixDirections.length).toBeGreaterThanOrEqual(1);
		expect(witness.cycleDirections.length).toBeGreaterThan(0);
		const atCycle = replayWithEngine(state, witness.prefixDirections);
		verifyGeometry(atCycle, witness.cycleStart);
		const afterCycle = replayWithEngine(atCycle, witness.cycleDirections);
		verifyGeometry(afterCycle, witness.end);
		expect(witness.end).toEqual(witness.cycleStart);
		expect(afterCycle.apple).toEqual(state.apple);
		expect(afterCycle.applesEaten).toBe(state.applesEaten);
		const anotherCycle = replayWithEngine(afterCycle, witness.cycleDirections);
		verifyGeometry(anotherCycle, witness.end);
	}
}

function smallBoard() {
	const state = baseState();
	state.config.width = 7;
	state.config.height = 5;
	state.snake = [
		{ x: 2, y: 2 },
		{ x: 1, y: 2 },
		{ x: 0, y: 2 },
	];
	state.apple = { x: 6, y: 4 };
	return state;
}

test("all candidate collision kinds are exact and do not produce a witness", () => {
	const state = smallBoard();
	state.snake = [
		{ x: 1, y: 0 },
		{ x: 0, y: 0 },
		{ x: 0, y: 1 },
		{ x: 1, y: 1 },
		{ x: 2, y: 1 },
	];
	state.obstacles = [{ x: 2, y: 0 }];
	for (const direction of directions)
		expect(analyzePositiveEvidence(publicState(state), direction)).toEqual({
			status: "initial_collision",
			collision: inspectMove(state, direction).immediateCollision,
		});
});

test("direct and static food witnesses replay growth without changing the source or RNG", () => {
	const state = smallBoard();
	state.apple = { x: 5, y: 2 };
	state.obstacles = [{ x: 4, y: 2 }];
	const before = structuredClone(state);
	const evidence = analyzePositiveEvidence(publicState(state), "right");
	expect(evidence).toMatchObject({
		status: "apple_route_found",
		source: "static_candidate",
		terminal: "none",
	});
	verifyWitness(state, evidence);
	expect(state).toEqual(before);
	state.apple = { x: 3, y: 2 };
	const direct = analyzePositiveEvidence(publicState(state), "right");
	expect(direct).toMatchObject({
		status: "apple_eaten_now",
		source: "direct",
		witness: { directions: ["right"] },
	});
	verifyWitness(state, direct);
});

test("a growth endpoint does not claim continued survival or invent the next apple", () => {
	const state = smallBoard();
	state.apple = { x: 4, y: 2 };
	state.obstacles = [
		{ x: 4, y: 1 },
		{ x: 4, y: 3 },
		{ x: 5, y: 2 },
	];
	const evidence = analyzePositiveEvidence(publicState(state), "right");
	expect(evidence).toMatchObject({
		status: "apple_route_found",
		terminal: "none",
		witness: { directions: ["right", "right"], end: { apple: null } },
	});
	verifyWitness(state, evidence);
	const actual = replayWithEngine(state, ["right", "right"]);
	expect(
		directions.every(
			(direction) => inspectMove(actual, direction).immediateCollision !== null,
		),
	).toBe(true);
});

test("board completion is a terminal apple witness", () => {
	const state = nearComplete();
	const evidence = analyzePositiveEvidence(publicState(state), "right");
	expect(evidence).toMatchObject({
		status: "apple_eaten_now",
		terminal: "board_complete",
	});
	verifyWitness(state, evidence);
});

test("a complete moving-tail cycle includes repeatable ordered-body evidence and true release steps", () => {
	const state = smallBoard();
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
	const before = structuredClone(state);
	const evidence = analyzePositiveEvidence(publicState(state), "down");
	expect(evidence).toMatchObject({
		status: "non_growth_cycle",
		witness: {
			prefixDirections: ["down"],
			cycleDirections: ["right", "up", "left", "down"],
		},
	});
	verifyWitness(state, evidence);
	if (evidence.status !== "non_growth_cycle")
		throw new Error("Expected a cycle witness");
	expect(evidence.witness.releasePassages[0]).toEqual({
		point: { x: 0, y: 1 },
		originalBodyIndex: 3,
		earliestReleaseStep: 1,
		enteredAtStep: 1,
	});
	expect(state).toEqual(before);
});

test("cycle equality requires the whole body and heading, and stops before any unknown food", () => {
	const state = smallBoard();
	state.apple = null;
	const evidence = analyzePositiveEvidence(publicState(state), "right");
	expect(evidence.status).toBe("non_growth_cycle");
	verifyWitness(state, evidence);
});

test("the actual 529dd release trap produces an apple route through the body gate", () => {
	const state = Object.assign(
		baseState(),
		structuredClone(releaseReplay.geometry),
	) as MatchState;
	state.tick = releaseReplay.source.tick;
	state.seq = releaseReplay.source.seq;
	const before = structuredClone(state);
	expect(
		staticFoodPath(advanceGeometry(publicState(state), "up"), "apple"),
	).toBeNull();
	const evidence = analyzePositiveEvidence(publicState(state), "up");
	expect(evidence).toMatchObject({
		status: "apple_route_found",
		source: "dynamic_search",
		witness: { end: { apple: null } },
	});
	verifyWitness(state, evidence);
	if (evidence.status !== "apple_route_found")
		throw new Error("Expected the release route");
	expect(evidence.witness.directions[0]).toBe("up");
	expect(evidence.witness.directions.length).toBeLessThanOrEqual(39);
	expect(evidence.witness.releasePassages).toContainEqual({
		point: { x: 11, y: 6 },
		originalBodyIndex: 39,
		earliestReleaseStep: 11,
		enteredAtStep: 11,
	});
	expect(analyzePositiveEvidence(publicState(state), "right")).toMatchObject({
		status: "exhausted",
	});
	expect(analyzePositiveEvidence(publicState(state), "down")).toMatchObject({
		status: "exhausted",
	});
	expect(state).toEqual(before);
});

test("exhaustion traverses a long finite corridor without a depth or node cutoff", () => {
	const state = baseState();
	state.config.width = 2052;
	state.config.height = 1;
	state.snake = [
		{ x: 1, y: 0 },
		{ x: 0, y: 0 },
	];
	state.apple = null;
	expect(analyzePositiveEvidence(publicState(state), "right")).toEqual({
		status: "exhausted",
		searchedStates: 2050,
	});
});
