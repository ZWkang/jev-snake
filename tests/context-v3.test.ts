import { expect, test } from "vitest";
import { inspectMove, move } from "../server/game/engine.js";
import {
	advanceGeometry,
	analyzeAction,
	analyzeActions,
	analyzeSecondActions,
	staticFoodPath,
	staticSpace,
} from "../server/jev/context-v3.js";
import { directions, publicState } from "../shared/snake/types.js";
import {
	baseState,
	contextFixtures,
	deadEndReplay,
	nearComplete,
} from "./context-fixture.js";

function smallBoard() {
	const s = baseState();
	s.config.width = 7;
	s.config.height = 5;
	s.snake = [
		{ x: 2, y: 2 },
		{ x: 1, y: 2 },
		{ x: 0, y: 2 },
	];
	s.direction = "right";
	s.apple = { x: 6, y: 4 };
	return s;
}

test("v3 uses exact moves and never mutates observed state or RNG", () => {
	for (const factory of Object.values(contextFixtures)) {
		const s = factory(),
			before = structuredClone(s),
			facts = analyzeActions(publicState(s));
		for (const d of directions) {
			const actual = structuredClone(s),
				expected = inspectMove(actual, d);
			expect(facts[d].immediateCollision).toBe(expected.immediateCollision);
			if (expected.immediateCollision) {
				expect(facts[d]).toMatchObject({
					space: null,
					forcedPath: null,
					appleRoute: { status: "not_applicable" },
					starRoute: { status: "not_applicable" },
				});
				continue;
			}
			const geometric = advanceGeometry(publicState(s), d);
			move(actual, d);
			expect(geometric.snake).toEqual(actual.snake);
			expect(geometric.direction).toEqual(actual.direction);
			if (actual.status !== "won")
				expect(facts[d].space).toEqual(staticSpace(publicState(actual)));
		}
		expect(s).toEqual(before);
	}
	const corridor = analyzeActions(publicState(deadEndReplay()));
	expect(corridor.left.forcedPath).toEqual({
		outcome: "forced_collision",
		steps: 7,
	});
	expect(corridor.right.forcedPath).toEqual({ outcome: "branch", steps: 1 });
});

test("a branch in a small frozen pocket remains heuristic evidence", () => {
	const s = smallBoard();
	s.direction = "left";
	s.snake = [
		[1, 0],
		[2, 0],
		[3, 0],
		[4, 0],
		[4, 1],
		[4, 2],
	].map(([x, y]) => ({ x, y }));
	s.obstacles = [
		[0, 1],
		[0, 2],
		[3, 1],
		[3, 2],
		[1, 3],
		[2, 3],
	].map(([x, y]) => ({ x, y }));
	const f = analyzeAction(publicState(s), "down");
	expect(f.forcedPath).toEqual({ outcome: "branch", steps: 1 });
	expect(f.space).toMatchObject({
		staticReachableCells: 4,
		bodyLength: 6,
		relativeToBody: "less",
		legalNextMoves: 2,
		tailConnection: "disconnected",
	});
	expect(f.appleRoute.status).toBe("no_static_path");
});

test("frozen no path does not negate a moving-tail cycle", () => {
	const s = smallBoard();
	s.direction = "left";
	s.snake = [
		[0, 0],
		[1, 0],
		[1, 1],
		[0, 1],
	].map(([x, y]) => ({ x, y }));
	s.obstacles = [
		[0, 2],
		[1, 2],
		[2, 0],
		[2, 1],
	].map(([x, y]) => ({ x, y }));
	const f = analyzeAction(publicState(s), "down");
	expect(f.space).toMatchObject({
		staticReachableCells: 1,
		relativeToBody: "less",
		tailConnection: "connected",
	});
	expect(f.appleRoute.status).toBe("no_static_path");
	expect(f.forcedPath?.outcome).toBe("cycle");
	for (const d of ["down", "right", "up", "left"] as const)
		expect(move(s, d).type).toBe("move");
});

test("BFS chooses one deterministic detour and validates growth against the engine", () => {
	const s = smallBoard();
	s.apple = { x: 5, y: 2 };
	s.obstacles = [{ x: 4, y: 2 }];
	const after = advanceGeometry(publicState(s), "right");
	const route = staticFoodPath(after, "apple");
	expect(route).toEqual(["up", "right", "right", "down"]);
	const f = analyzeAction(publicState(s), "right");
	expect(f.appleRoute).toMatchObject({
		status: "path_found",
		distance: 5,
		verified: true,
	});
	for (const d of ["right", ...(route ?? [])] as const)
		expect(move(s, d).type).not.toBe("gameover");
	expect(s.applesEaten).toBe(1);
	expect(f.appleRoute.postEat).toEqual({
		terminal: "none",
		...staticSpace(publicState(s)),
	});
});

test("direct and routed apples expose a zero-exit post-growth pocket", () => {
	const s = smallBoard();
	s.apple = { x: 4, y: 2 };
	s.obstacles = [
		{ x: 4, y: 1 },
		{ x: 4, y: 3 },
		{ x: 5, y: 2 },
	];
	const f = analyzeAction(publicState(s), "right");
	expect(f.appleRoute).toMatchObject({
		status: "path_found",
		distance: 2,
		verified: true,
		postEat: {
			terminal: "none",
			bodyLength: 4,
			legalNextMoves: 0,
			staticReachableCells: 1,
		},
	});
	move(s, "right");
	expect(analyzeAction(publicState(s), "right").appleRoute).toMatchObject({
		status: "eaten_now",
		distance: 1,
		postEat: { legalNextMoves: 0 },
	});
	expect(move(s, "right").type).toBe("apple");
	expect(
		directions.every((d) => inspectMove(s, d).immediateCollision !== null),
	).toBe(true);
});

test("filling the board ends analysis without treating lack of exits as failure", () => {
	const s = nearComplete(),
		f = analyzeAction(publicState(s), "right");
	expect(f).toMatchObject({
		terminal: "board_complete",
		space: null,
		appleRoute: {
			status: "eaten_now",
			distance: 1,
			verified: true,
			postEat: {
				terminal: "board_complete",
				bodyLength: 7,
				legalNextMoves: null,
			},
		},
		starRoute: { status: "not_applicable" },
	});
	expect(analyzeSecondActions(publicState(s), "right").up).toMatchObject({
		secondStatus: "not_executed_board_complete",
		secondFacts: null,
	});
	expect(move(s, "right").type).toBe("won");
});

test("star routes cannot silently pass through an apple", () => {
	const s = smallBoard();
	s.config.height = 1;
	s.snake = [
		{ x: 2, y: 0 },
		{ x: 1, y: 0 },
		{ x: 0, y: 0 },
	];
	s.apple = { x: 4, y: 0 };
	s.star = { point: { x: 5, y: 0 }, expiresAt: 8000 };
	expect(analyzeAction(publicState(s), "right").starRoute.status).toBe(
		"no_static_path",
	);
	move(s, "right");
	expect(analyzeAction(publicState(s), "right").starRoute.status).toBe(
		"unknown_after_growth",
	);
});

test("star nominal arrival includes partial deadline, equality expiry and second-step offset", () => {
	const s = smallBoard();
	s.star = { point: { x: 4, y: 2 }, expiresAt: 1700 };
	const timing = { elapsedGameTimeMs: 1000, deadlineInMs: 200 };
	const first = analyzeAction(publicState(s), "right", timing);
	expect(first.starRoute).toMatchObject({
		distance: 2,
		remainingMs: 700,
		nominalArrivalMs: 700,
		timingStatus: "not_before_expiry",
	});
	const second = analyzeSecondActions(publicState(s), "right", timing).right;
	expect(second).toMatchObject({
		secondStatus: "known",
		secondFacts: {
			starRoute: {
				status: "reached_now",
				distance: 1,
				remainingMs: 700,
				nominalArrivalMs: 700,
				timingStatus: "not_before_expiry",
			},
		},
	});
	s.star.expiresAt = 1701;
	expect(
		analyzeAction(publicState(s), "right", timing).starRoute.timingStatus,
	).toBe("before_expiry_if_on_schedule");
	expect(
		analyzeAction(publicState(s), "right", { ...timing, deadlineInMs: -1 })
			.starRoute.timingStatus,
	).toBe("deadline_passed");
	expect(analyzeAction(publicState(s), "right").starRoute).toMatchObject({
		nominalArrivalMs: null,
		timingStatus: "unknown",
	});
	s.config = {
		...s.config,
		stepMode: "response",
		decisionMode: "single_step",
		tickIntervalMs: null,
	};
	expect(
		analyzeAction(publicState(s), "right", { ...timing, deadlineInMs: null })
			.starRoute,
	).toMatchObject({
		remainingMs: 701,
		nominalArrivalMs: null,
		timingStatus: "unknown",
	});
});

test("conditional second moves use moved bodies, omit unknown growth, and consume stars once", () => {
	const s = deadEndReplay(),
		before = structuredClone(s);
	expect(analyzeSecondActions(publicState(s), "right").up).toMatchObject({
		secondStatus: "known",
		secondFacts: { immediateCollision: "body" },
	});
	expect(analyzeSecondActions(publicState(s), "up").down).toMatchObject({
		secondStatus: "not_executed_first_blocked",
		secondFacts: null,
	});
	expect(s).toEqual(before);
	const apple = smallBoard();
	apple.apple = { x: 3, y: 2 };
	const unknown = analyzeSecondActions(publicState(apple), "right").right;
	expect(unknown).toEqual({
		first: "right",
		second: "right",
		secondStatus: "unknown_after_growth",
		secondFacts: {
			immediateCollision: null,
			reason: "new_apple_position_unknown",
		},
	});
	expect(
		analyzeSecondActions(publicState(apple), "right").left.secondFacts
			?.immediateCollision,
	).toBe("reverse");
	const star = smallBoard();
	star.star = { point: { x: 3, y: 2 }, expiresAt: 8000 };
	expect(analyzeSecondActions(publicState(star), "right").right).toMatchObject({
		secondStatus: "known",
		secondFacts: { starRoute: { status: "absent" } },
	});
});
