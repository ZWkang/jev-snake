import { expect, test } from "vitest";
import { inspectMove, move } from "../server/game/engine.js";
import { actionOutcome } from "../server/jev/action-outcomes.js";
import { createDeathAnalyzer } from "../server/jev/branch-death.js";
import { analyzeActions } from "../server/jev/context-v3.js";
import { opportunityFacts } from "../server/jev/witness-context.js";
import {
	type Direction,
	directions,
	type MatchState,
	publicState,
} from "../shared/snake/types.js";
import type {
	WitnessArchive,
	WitnessRecord,
} from "../shared/snake/witness-context.js";
import { baseState, nearComplete } from "./context-fixture.js";
import largeReplay from "./fixtures/action-outcome-2e220.json" with { type: "json" };
import smallReplay from "./fixtures/action-outcome-7x5.json" with { type: "json" };
import edgeReplay from "./fixtures/edge-branch-trap.json" with { type: "json" };

function replayState(fixture: typeof largeReplay) {
	return Object.assign(baseState(), structuredClone(fixture.geometry), {
		tick: fixture.source.tick,
		seq: fixture.source.seq,
	}) as MatchState;
}

function outcomes(state: MatchState) {
	const observed = publicState(state);
	const archive: WitnessArchive = {
		version: "positive-v1",
		observedTick: observed.tick,
		records: {},
	};
	const analyzer = createDeathAnalyzer();
	const facts = analyzeActions(observed, undefined, 0, analyzer);
	const opportunities = opportunityFacts(observed, archive);
	const result = Object.fromEntries(
		directions.map((direction) => {
			const opportunity = opportunities[direction];
			return [
				direction,
				actionOutcome(
					observed,
					direction,
					facts[direction],
					opportunity,
					opportunity.witnessId
						? archive.records[opportunity.witnessId]
						: undefined,
					analyzer,
				),
			];
		}),
	) as Record<Direction, ReturnType<typeof actionOutcome>>;
	return { result, archive, opportunities, facts };
}

function replayAppleWitness(state: MatchState, record: WitnessRecord) {
	expect(record.evidence.status).not.toBe("non_growth_cycle");
	if (record.evidence.status === "non_growth_cycle")
		throw new Error("Expected apple witness");
	const actual = structuredClone(state);
	const route = record.evidence.witness.directions;
	for (const [index, direction] of route.entries()) {
		expect(inspectMove(actual, direction).immediateCollision).toBeNull();
		const event = move(actual, direction);
		if (index === route.length - 1)
			expect(["apple", "won"]).toContain(event.type);
		else expect(event.type).not.toBe("apple");
	}
	expect(actual.snake).toEqual(record.evidence.witness.end.snake);
	expect(actual.direction).toEqual(record.evidence.witness.end.direction);
	return actual;
}

// Exhaust every possible food respawn using the real engine for movement and
// growth. This independently verifies finite collision bounds instead of
// assuming the analyzer's no-further-growth projection is already correct.
function successors(state: MatchState, direction: Direction): MatchState[] {
	if (inspectMove(state, direction).immediateCollision === "reverse") return [];
	const next = structuredClone(state);
	const event = move(next, direction);
	if (event.type === "gameover") return [];
	expect(event.type).not.toBe("won");
	if (event.type !== "apple") return [next];
	const blocked = new Set(
		[...next.snake, ...next.obstacles].map((p) => `${p.x},${p.y}`),
	);
	const result: MatchState[] = [];
	for (let y = 0; y < next.config.height; y++) {
		for (let x = 0; x < next.config.width; x++) {
			if (!blocked.has(`${x},${y}`)) result.push({ ...next, apple: { x, y } });
		}
	}
	return result;
}

function verifyEveryContinuationDies(
	state: MatchState,
	first: Direction,
	bound: number,
) {
	let frontier = successors(state, first);
	for (let count = 1; count < bound; count++) {
		const seen = new Map<string, MatchState>();
		for (const current of frontier) {
			for (const direction of directions) {
				for (const next of successors(current, direction)) {
					seen.set(
						JSON.stringify([next.direction, next.snake, next.apple]),
						next,
					);
				}
			}
		}
		frontier = [...seen.values()];
	}
	expect(frontier).toEqual([]);
}

test("the real 2e220 decision states the fatal first-move bound alongside its misleading short apple route", () => {
	const state = replayState(largeReplay);
	const before = structuredClone(state);
	const { result, archive, opportunities } = outcomes(state);
	expect(result.up).toMatchObject({
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
	expect(result.up.summary).toContain(
		"every continuation collides within 13 moves",
	);
	expect(result.up.summary).toContain(
		"Reaching that apple does not remove the fatal conclusion",
	);
	expect(result.down).toMatchObject({
		survival: { status: "not_proven_fatal", collisionWithinMoves: null },
		appleRoute: {
			moves: 23,
			postApple: { status: "not_proven_fatal", postEat: { legalNextMoves: 2 } },
		},
	});
	for (const direction of ["up", "down"] as const) {
		const witness = archive.records[opportunities[direction].witnessId!];
		replayAppleWitness(state, witness);
	}
	verifyEveryContinuationDies(
		state,
		"up",
		result.up.survival.collisionWithinMoves!,
	);
	expect(state).toEqual(before);
});

test("the 7x5 first move and a particular apple route have different proof scopes", () => {
	const state = replayState(smallReplay);
	const { result, archive, opportunities } = outcomes(state);
	expect(result.left).toMatchObject({
		survival: { status: "proven_fatal", collisionWithinMoves: 3 },
		appleRoute: {
			moves: 1,
			postApple: { status: "proven_fatal", collisionWithinMoves: 2 },
		},
	});
	verifyEveryContinuationDies(state, "left", 3);
	for (const direction of ["right", "down"] as const) {
		expect(result[direction].survival.status).toBe("not_proven_fatal");
		expect(result[direction].appleRoute.postApple?.status).toBe("proven_fatal");
		expect(result[direction].summary).toContain(
			"This endpoint proof applies to this route, not to different routes",
		);
		const witness = archive.records[opportunities[direction].witnessId!];
		const grown = replayAppleWitness(state, witness);
		// Whichever random apple was spawned by the actual engine, all legal
		// choices from the grown endpoint die within the two-move certificate.
		for (const next of directions) {
			if (inspectMove(grown, next).immediateCollision !== "reverse")
				verifyEveryContinuationDies(grown, next, 2);
		}
	}
});

test("an all-branch continuation bound includes the candidate move before the fork", () => {
	const state = Object.assign(
		baseState(),
		structuredClone(edgeReplay.state),
	) as MatchState;
	const { result } = outcomes(state);
	expect(result.right.survival).toMatchObject({
		status: "proven_fatal",
		collisionWithinMoves: 7,
		proof: "all_continuations",
	});
	expect(result.right.appleRoute.status).toBe("exhausted");
	verifyEveryContinuationDies(state, "right", 7);
});

test("rejected reversal, collision, and immediate board completion keep their actual engine semantics", () => {
	const state = nearComplete();
	const { result } = outcomes(state);
	expect(result.right).toMatchObject({
		survival: { status: "board_complete", collisionWithinMoves: null },
		appleRoute: { postApple: { status: "board_complete" } },
	});
	expect(move(structuredClone(state), "right").type).toBe("won");
	expect(result.up.survival).toMatchObject({
		status: "immediate_collision",
		collisionWithinMoves: 1,
	});
	expect(move(structuredClone(state), "up").type).toBe("gameover");
	expect(result.left.survival).toMatchObject({
		status: "illegal_reverse",
		collisionWithinMoves: null,
	});
	expect(() => move(state, "left")).toThrow("Direct reversal");
	expect(state.tick).toBe(0);
});

test("a no-growth cycle is unresolved apple progress, not apple absence or a completion guarantee", () => {
	const state = baseState();
	state.config.width = 7;
	state.config.height = 5;
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
	state.apple = { x: 6, y: 4 };
	const { result } = outcomes(state);
	expect(result.down).toMatchObject({
		survival: { status: "not_proven_fatal" },
		appleRoute: { status: "unresolved", moves: null, postApple: null },
	});
	expect(result.down.summary).toContain(
		"Other apple routes were not exhausted",
	);
	expect(result.down.summary).toContain(
		"does not establish food progress or board completion",
	);
});

test("a missing or differently observed witness fails explicitly instead of borrowing another endpoint", () => {
	const state = replayState(smallReplay);
	const observed = publicState(state);
	const { archive, opportunities, facts } = outcomes(state);
	const witness = archive.records[opportunities.left.witnessId!];
	expect(() =>
		actionOutcome(observed, "left", facts.left, opportunities.left, undefined),
	).toThrow("missing its referenced witness");
	const unrelated = structuredClone(witness);
	unrelated.origin.tick--;
	expect(() =>
		actionOutcome(observed, "left", facts.left, opportunities.left, unrelated),
	).toThrow("different observation");
	const wrongFirstMove = structuredClone(witness);
	if (wrongFirstMove.evidence.status === "non_growth_cycle")
		throw new Error("Expected apple witness");
	wrongFirstMove.evidence.witness.directions[0] = "right";
	expect(() =>
		actionOutcome(
			observed,
			"left",
			facts.left,
			opportunities.left,
			wrongFirstMove,
		),
	).toThrow("different direction");
});
