import { expect, test } from "vitest";
import { inspectMove, move } from "../server/game/engine.js";
import {
	advanceGeometry,
	analyzeAction,
	analyzeActions,
	analyzeSecondActions,
} from "../server/jev/context-v3.js";
import {
	trappedRegion as legacyTrappedRegion,
	trapInstructions,
} from "../server/jev/trap-evidence.js";
import {
	postAppleForcedDeath,
	trappedRegion,
} from "../server/jev/trap-geometry.js";
import {
	directions,
	type PublicState,
	publicState,
	vectors,
} from "../shared/snake/types.js";
import {
	branchedTrapReplay,
	baseState,
	deadEndReplay,
	nearComplete,
} from "./context-fixture.js";
import deathReplay from "./fixtures/loop-regression-death.json" with { type: "json" };
import loopReplay from "./fixtures/loop-replay.json" with { type: "json" };
import postGrowthReplay from "./fixtures/post-growth-loop-regression.json" with { type: "json" };

test("the real tick-70 apple trap marks right as proven fatal on the option itself", () => {
	const state = deathReplay.states[0] as PublicState;
	const before = structuredClone(state);
	const facts = analyzeActions(state);
	expect(trappedRegion(advanceGeometry(state, "right"))).toEqual({
		regionCells: 5,
		bodyLength: 19,
		boundaryReleaseLowerBound: 10,
	});
	expect(facts.right).toMatchObject({
		eatsApple: true,
		immediateCollision: null,
		danger: "proven_fatal",
	});
	expect(facts.left).toMatchObject({ immediateCollision: null, danger: null });
	expect(state).toEqual(before);
});

test("the real tick-71 body collision is marked separately from eventual certain death", () => {
	const state = deathReplay.states[1] as PublicState;
	const facts = analyzeActions(state);
	expect(facts.up).toMatchObject({
		immediateCollision: "body",
		danger: "immediate_collision",
	});
	expect(facts.right).toMatchObject({
		immediateCollision: null,
		danger: "proven_fatal",
	});
});

test.each([119, 143])(
	"the original loop's apple exit at tick %i stays unproven instead of being called safe or fatal",
	(tick) => {
		const state = loopReplay.states[tick] as PublicState;
		expect(analyzeAction(state, "up")).toMatchObject({
			eatsApple: true,
			immediateCollision: null,
			danger: null,
		});
	},
);

test("existing branch and forced-corridor proofs produce the same per-option danger", () => {
	const branch = publicState(branchedTrapReplay());
	expect(legacyTrappedRegion).toBe(trappedRegion);
	expect(analyzeAction(branch, "left")).toMatchObject({
		forcedPath: { outcome: "branch" },
		danger: "proven_fatal",
	});
	expect(analyzeAction(branch, "right").danger).toBeNull();
	const corridor = publicState(deadEndReplay());
	expect(analyzeAction(corridor, "left")).toMatchObject({
		forcedPath: { outcome: "forced_collision" },
		danger: "proven_fatal",
	});
});

test("board completion remains a win and growth keeps second-step facts explicitly unknown", () => {
	const winning = publicState(nearComplete());
	expect(analyzeAction(winning, "right")).toMatchObject({
		terminal: "board_complete",
		danger: null,
	});
	const state = deathReplay.states[0] as PublicState;
	const second = analyzeSecondActions(state, "right");
	for (const pair of Object.values(second)) {
		expect(pair.secondStatus).toBe("unknown_after_growth");
		expect(Object.keys(pair.secondFacts ?? {}).sort()).toEqual([
			"immediateCollision",
			"reason",
		]);
	}
	const known = analyzeSecondActions(publicState(branchedTrapReplay()), "left");
	expect(known.left).toMatchObject({
		secondStatus: "known",
		secondFacts: { danger: "proven_fatal" },
	});
});

test("the actual tick-183 growth has a fatal upper bound without inventing its next apple", () => {
	const state = postGrowthReplay.state as PublicState;
	const before = structuredClone(state);
	const after = advanceGeometry(state, "down");
	expect(postAppleForcedDeath(after)).toEqual({
		collisionWithinMoves: 3,
		freeCellsAfterGrowth: 11,
	});
	expect(analyzeAction(state, "down")).toMatchObject({
		eatsApple: true,
		forcedPath: { outcome: "unknown_after_apple", steps: 1 },
		danger: "proven_fatal",
	});
	expect(analyzeAction(state, "left").danger).toBeNull();
	expect(trapInstructions(state)).toContain(
		'"move":"down","collisionWithinMoves":3,"freeCellsAfterGrowth":11',
	);
	for (const pair of Object.values(analyzeSecondActions(state, "down")))
		expect(pair.secondStatus).toBe("unknown_after_growth");
	expect(state).toEqual(before);
	const hiddenRng = new Proxy(after, {
		get(target, name, receiver) {
			if (name === "rngState") throw new Error("Proof cannot read private RNG");
			return Reflect.get(target, name, receiver);
		},
	});
	expect(postAppleForcedDeath(hiddenRng)?.collisionWithinMoves).toBe(3);
});

test("growth that can win before the optimistic collision is not declared fatal", () => {
	const state = baseState();
	state.config.width = 7;
	state.config.height = 1;
	state.direction = "right";
	state.snake = [3, 2, 1, 0].map((x) => ({ x, y: 0 }));
	state.apple = { x: 4, y: 0 };
	const after = advanceGeometry(publicState(state), "right");
	expect(after.snake).toHaveLength(5);
	expect(postAppleForcedDeath(after)).toBeNull();
	expect(analyzeAction(publicState(state), "right").danger).toBeNull();
	expect(move(state, "right").type).toBe("apple");
	state.apple = { x: 5, y: 0 };
	expect(move(state, "right").type).toBe("apple");
	state.apple = { x: 6, y: 0 };
	expect(move(state, "right").type).toBe("won");
	expect(postAppleForcedDeath(publicState(state))).toBeNull();
});

test("known second-step growth carries the same death bound without relabeling the first step", () => {
	const observed = postGrowthReplay.state as PublicState;
	const before = {
		...observed,
		snake: [...observed.snake.slice(1), { x: 0, y: 0 }],
	};
	expect(advanceGeometry(before, "left").snake).toEqual(observed.snake);
	expect(analyzeSecondActions(before, "left").down).toMatchObject({
		secondStatus: "known",
		secondFacts: { eatsApple: true, danger: "proven_fatal" },
	});
	expect(trapInstructions(before, true)).toContain(
		'"move":"second:left_down","collisionWithinMoves":3,"freeCellsAfterGrowth":11',
	);
});

test("all future growth patterns still collide within the real fixture's three-move bound", () => {
	const after = advanceGeometry(postGrowthReplay.state as PublicState, "down");
	let positions = [after];
	for (let step = 1; step <= 3; step++) {
		positions = positions.flatMap((position) =>
			directions.flatMap((direction) => {
				const target = {
					x: position.snake[0].x + vectors[direction].x,
					y: position.snake[0].y + vectors[direction].y,
				};
				// This permits every combination of growing and not growing along
				// the path, a superset of actual randomly placed apple sequences.
				const choices = [null, target];
				return choices.flatMap((apple) => {
					const next = { ...position, apple };
					return inspectMove(next, direction).immediateCollision === null
						? [advanceGeometry(next, direction)]
						: [];
				});
			}),
		);
		if (step < 3) expect(positions.length).toBeGreaterThan(0);
	}
	expect(positions).toEqual([]);
});

test("optimistic branching and full ordered-body cycles produce no post-growth death proof", () => {
	expect(postAppleForcedDeath(publicState(baseState()))).toBeNull();
	const state = baseState();
	state.config.width = 4;
	state.config.height = 4;
	state.direction = "left";
	state.snake = [
		{ x: 0, y: 0 },
		{ x: 1, y: 0 },
		{ x: 1, y: 1 },
		{ x: 0, y: 1 },
	];
	state.obstacles = [
		{ x: 2, y: 0 },
		{ x: 2, y: 1 },
		{ x: 0, y: 2 },
		{ x: 1, y: 2 },
	];
	state.apple = null;
	expect(postAppleForcedDeath(publicState(state))).toBeNull();
});
