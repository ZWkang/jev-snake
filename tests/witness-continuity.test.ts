import { expect, test } from "vitest";
import { inspectMove, move } from "../server/game/engine.js";
import {
	staticFoodPath,
	advanceGeometry,
	staticSpace,
} from "../server/jev/context-v3.js";
import {
	opportunityFacts,
	witnessContinuity,
	witnessDirections,
} from "../server/jev/witness-context.js";
import type { Direction, MatchState } from "../shared/snake/types.js";
import type { WitnessArchive } from "../shared/snake/witness-context.js";
import { baseState, nearComplete } from "./context-fixture.js";
import releaseReplay from "./fixtures/positive-release-replay.json" with { type: "json" };

function emptyArchive(tick: number): WitnessArchive {
	return { version: "positive-v1", observedTick: tick, records: {} };
}
function attachArchive(state: MatchState, evidence: WitnessArchive) {
	state.lastDecision = {
		model: "geometry-fixture",
		choice: "right",
		probabilities: { up: 0, right: 1, down: 0, left: 0 },
		confidence: 1,
		requestMs: 0,
		evidence,
	};
}
function execute(state: MatchState, route: Direction[]) {
	for (const direction of route) {
		expect(inspectMove(state, direction).immediateCollision).toBeNull();
		expect(move(state, direction).type).not.toBe("gameover");
	}
}

test("different actual actions can converge on a witness state without having followed its prefix", () => {
	const state = baseState();
	const original = emptyArchive(state.tick);
	const facts = opportunityFacts(state, original);
	const id = facts.up.witnessId;
	if (!id) throw new Error("Expected the up witness");
	const route = witnessDirections(original.records[id]);
	const prefix = route.slice(0, 6);
	expect(prefix.slice(0, 2)).toEqual(["up", "right"]);
	const actual = [...prefix];
	[actual[0], actual[1]] = [actual[1], actual[0]];
	expect(actual).not.toEqual(prefix);
	const previous = { ...original, records: { [id]: original.records[id] } };
	attachArchive(state, previous);
	execute(state, actual);
	const target = emptyArchive(state.tick);
	const continuity = witnessContinuity(state, target);
	expect(continuity).toEqual([
		{
			witnessId: id,
			originTick: 0,
			stateCompatibleAfterMoves: 6,
			remainingMoves: route.length - 6,
			nextDirection: route[6],
			opportunityStatus: "apple_route_found",
			appleTarget: state.apple,
			scope: "observed_apple_only",
			endEvent: "apple_eaten",
		},
	]);
	expect(continuity[0]).not.toHaveProperty("matchedMoves");
	expect(target.records[id]).toEqual(previous.records[id]);
	expect(target.records[id]).not.toBe(previous.records[id]);
	target.records[id].origin.snake[0].x++;
	expect(target.records[id].origin.snake).not.toEqual(
		previous.records[id].origin.snake,
	);
});

test("equivalent remaining routes from different observations are deduplicated without selecting a direction", () => {
	const start = baseState();
	const old = emptyArchive(start.tick);
	const firstFacts = opportunityFacts(start, old);
	const oldId = firstFacts.up.witnessId;
	if (!oldId) throw new Error("Expected initial witness");
	const originalRoute = witnessDirections(old.records[oldId]);
	const later = structuredClone(start);
	execute(later, originalRoute.slice(0, 2));
	const fresh = emptyArchive(later.tick);
	const newFacts = opportunityFacts(later, fresh);
	const newId = newFacts[originalRoute[2]].witnessId;
	if (!newId) throw new Error("Expected a later witness");
	expect(oldId).not.toBe(newId);
	expect(witnessDirections(fresh.records[newId])).toEqual(
		originalRoute.slice(2),
	);
	execute(later, originalRoute.slice(2, 6));
	attachArchive(later, {
		...fresh,
		records: { [oldId]: old.records[oldId], [newId]: fresh.records[newId] },
	});
	const target = emptyArchive(later.tick);
	const compatible = witnessContinuity(later, target);
	expect(compatible).toHaveLength(1);
	expect(compatible[0].remainingMoves).toBe(originalRoute.length - 6);
	expect(Object.keys(target.records)).toEqual([compatible[0].witnessId]);
});

test("changed geometry and conditional-only records do not become observed continuity", () => {
	const state = baseState();
	const archive = emptyArchive(state.tick);
	const facts = opportunityFacts(state, archive);
	const id = facts.up.witnessId;
	if (!id) throw new Error("Expected up witness");
	attachArchive(state, { ...archive, records: { [id]: archive.records[id] } });
	execute(state, ["right"]);
	expect(witnessContinuity(state)).toEqual([]);
	const conditional = baseState();
	const records = emptyArchive(conditional.tick);
	opportunityFacts(conditional, records, "conditional_second");
	attachArchive(conditional, records);
	execute(conditional, ["up"]);
	expect(witnessContinuity(conditional)).toEqual([]);
});

test("compatible cycles remain explicitly no-growth evidence with a complete archived source", () => {
	const state = baseState();
	state.config.width = 3;
	state.config.height = 3;
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
	state.apple = { x: 2, y: 2 };
	const archive = emptyArchive(state.tick);
	const facts = opportunityFacts(state, archive);
	expect(facts.down.postEat).toBeNull();
	attachArchive(state, archive);
	execute(state, ["down"]);
	const retained = emptyArchive(state.tick);
	const compatibility = witnessContinuity(state, retained);
	expect(compatibility).toHaveLength(1);
	expect(compatibility[0]).toMatchObject({
		opportunityStatus: "non_growth_cycle",
		stateCompatibleAfterMoves: 1,
		appleTarget: null,
		scope: "no_growth_cycle",
		endEvent: "cycle_completed",
	});
	expect(retained.records[compatibility[0].witnessId]).toBeDefined();
});

test("postEat is computed from the actual dynamic witness endpoint when no static route exists", () => {
	const state = Object.assign(
		baseState(),
		structuredClone(releaseReplay.geometry),
	) as MatchState;
	expect(staticFoodPath(advanceGeometry(state, "up"), "apple")).toBeNull();
	const archive = emptyArchive(state.tick);
	const facts = opportunityFacts(state, archive);
	const id = facts.up.witnessId;
	if (!id) throw new Error("Expected the dynamic release witness");
	expect(facts.up.status).toBe("apple_route_found");
	const actual = structuredClone(state);
	execute(actual, witnessDirections(archive.records[id]));
	expect(facts.up.postEat).toEqual({
		terminal: "none",
		...staticSpace(actual),
	});
	expect(facts.left.postEat).toBeNull();
	expect(facts.down.postEat).toBeNull();
});

test("postEat preserves zero-exit growth and terminal board completion without conflating them", () => {
	const pocket = baseState();
	pocket.config.width = 7;
	pocket.config.height = 5;
	pocket.snake = [
		{ x: 2, y: 2 },
		{ x: 1, y: 2 },
		{ x: 0, y: 2 },
	];
	pocket.apple = { x: 4, y: 2 };
	pocket.obstacles = [
		{ x: 4, y: 1 },
		{ x: 4, y: 3 },
		{ x: 5, y: 2 },
	];
	expect(
		opportunityFacts(pocket, emptyArchive(pocket.tick)).right.postEat,
	).toMatchObject({ terminal: "none", legalNextMoves: 0, bodyLength: 4 });
	const complete = nearComplete();
	expect(
		opportunityFacts(complete, emptyArchive(complete.tick)).right.postEat,
	).toEqual({
		terminal: "board_complete",
		bodyLength: 7,
		staticReachableCells: null,
		relativeToBody: null,
		legalNextMoves: null,
		tailConnection: null,
	});
});
