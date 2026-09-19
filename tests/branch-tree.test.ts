import { expect, test } from "vitest";
import { inspectMove, move } from "../server/game/engine.js";
import {
	continuationDeathProof,
	type ContinuationDeathProof,
	postAppleDeathProof,
} from "../server/jev/branch-death.js";
import { advanceGeometry, analyzeAction } from "../server/jev/context-v3.js";
import { forcedPath } from "../server/jev/context.js";
import {
	postAppleForcedDeath,
	trappedRegion,
} from "../server/jev/trap-geometry.js";
import {
	type Direction,
	directions,
	type PublicState,
	publicState,
} from "../shared/snake/types.js";
import { baseState, nearComplete } from "./context-fixture.js";
import replay from "./fixtures/multi-exit-branch-trap.json" with { type: "json" };

function legalDirections(state: PublicState) {
	return directions.filter(
		(direction) => inspectMove(state, direction).immediateCollision === null,
	);
}

// Audit every conjunction against the engine's collision rule, including the
// leaves. A parent is not a proof if it omits even one legal continuation.
function auditProof(state: PublicState, proof: ContinuationDeathProof): void {
	let position = state;
	for (let i = 0; i < proof.forcedPrefixMoves; i++) {
		const exits = legalDirections(position);
		expect(exits).toHaveLength(1);
		expect(inspectMove(position, exits[0]).eatsApple).toBe(false);
		position = advanceGeometry(position, exits[0]);
	}
	expect(proof.branchHead).toEqual(position.snake[0]);
	expect(proof.branches.map((branch) => branch.direction).sort()).toEqual(
		legalDirections(position).sort(),
	);
	expect(proof.collisionWithinMoves).toBe(
		proof.forcedPrefixMoves +
			Math.max(
				1,
				...proof.branches.map((branch) => branch.collisionWithinMoves),
			),
	);
	for (const branch of proof.branches) {
		const after = advanceGeometry(position, branch.direction);
		const leaf = branch.proof;
		if (leaf.kind === "continuation") {
			expect(inspectMove(position, branch.direction).eatsApple).toBe(false);
			expect(branch.collisionWithinMoves).toBe(1 + leaf.collisionWithinMoves);
			auditProof(after, leaf);
		} else if (leaf.kind === "forced_path") {
			expect(forcedPath(position, branch.direction)).toEqual({
				outcome: "forced_collision",
				steps: leaf.steps,
			});
			expect(branch.collisionWithinMoves).toBe(leaf.steps);
		} else if (leaf.kind === "trapped_region") {
			const { kind: _kind, ...region } = leaf;
			expect(trappedRegion(after)).toEqual(region);
			expect(branch.collisionWithinMoves).toBe(1 + region.regionCells);
		} else {
			expect(inspectMove(position, branch.direction).eatsApple).toBe(true);
			const { kind: _kind, ...postApple } = leaf;
			expect(postAppleDeathProof(after)).toEqual(postApple);
			expect(branch.collisionWithinMoves).toBe(
				1 + postApple.collisionWithinMoves,
			);
			const withoutFutureFood = { ...after, apple: null };
			const noGrowthProof = continuationDeathProof(withoutFutureFood);
			expect(noGrowthProof).not.toBeNull();
			if (!noGrowthProof) throw new Error("Missing post-growth death proof");
			auditProof(withoutFutureFood, noGrowthProof);
			expect(postApple.freeCellsAfterGrowth).toBeGreaterThanOrEqual(
				postApple.collisionWithinMoves,
			);
		}
	}
}

test.each(replay.cases)(
	"proves the real multi-exit entrance at observed tick $state.tick",
	(fixture) => {
		const state = structuredClone(fixture.state) as PublicState;
		const before = structuredClone(state);
		const candidate = fixture.candidate as Direction;
		const after = advanceGeometry(state, candidate);
		expect(legalDirections(after)).toEqual(fixture.expectedExits);
		// These child facts already existed before the fix; the regression is
		// their missing conjunction at the entrance one movement earlier.
		for (const direction of legalDirections(after))
			expect(analyzeAction(after, direction).danger).toBe("proven_fatal");
		expect(analyzeAction(state, candidate).danger).toBe("proven_fatal");
		const proof = continuationDeathProof(after);
		expect(proof).not.toBeNull();
		if (!proof) throw new Error("Missing multi-exit entrance certificate");
		expect(proof.forcedPrefixMoves).toBe(0);
		expect(proof.collisionWithinMoves).toBeLessThanOrEqual(
			fixture.collisionWithinMovesAfterCandidate,
		);
		auditProof(after, proof);
		expect(state).toEqual(before);
	},
);

test("the earlier 1630-left entrance exhausts all 57 legal states without unknown food", () => {
	const fixture = replay.cases[1];
	let frontier = [
		advanceGeometry(structuredClone(fixture.state) as PublicState, "left"),
	];
	const counts = [frontier.length];
	for (
		let step = 1;
		step <= fixture.collisionWithinMovesAfterCandidate;
		step++
	) {
		frontier = frontier.flatMap((state) =>
			legalDirections(state).map((direction) => {
				expect(inspectMove(state, direction).eatsApple).toBe(false);
				return advanceGeometry(state, direction);
			}),
		);
		counts.push(frontier.length);
		if (!frontier.length) break;
	}
	expect(frontier).toEqual([]);
	expect(counts).toEqual(fixture.frontierCountsAfterCandidate);
	expect(counts.reduce((sum, count) => sum + count, 0)).toBe(
		fixture.totalStatesIncludingAfterCandidate,
	);
});

test("the earlier 1630-down escape stays unknown and reaches the observed apple", () => {
	const fixture = replay.cases[1];
	const state = structuredClone(fixture.state) as PublicState;
	expect(analyzeAction(state, "down").danger).toBeNull();
	expect(continuationDeathProof(advanceGeometry(state, "down"))).toBeNull();
	const route = [
		...(fixture.escapePath as Direction[]),
		...(fixture.foodContinuation as Direction[]),
	];
	expect(route).toHaveLength(51);
	let position = state;
	for (const [index, direction] of route.entries()) {
		const step = inspectMove(position, direction);
		expect(step.immediateCollision).toBeNull();
		expect(step.eatsApple).toBe(index === route.length - 1);
		position = advanceGeometry(position, direction);
	}
	expect(position.snake[0]).toEqual(state.apple);
	expect(position.snake).toHaveLength(state.snake.length + 1);
});

test("the real 1144 apple entrance proves post-growth death before entering the trap", () => {
	const fixture = replay.growthCase;
	const state = structuredClone(fixture.state) as PublicState;
	const before = structuredClone(state);
	const candidate = fixture.candidate as Direction;
	expect(inspectMove(state, candidate).eatsApple).toBe(true);
	const after = advanceGeometry(state, candidate);
	expect(after.apple).toBeNull();
	expect(after.snake).toHaveLength(state.snake.length + 1);
	// The original unique-corridor proof cannot certify this branching trap.
	expect(postAppleForcedDeath(after)).toBeNull();
	expect(analyzeAction(state, candidate).danger).toBe("proven_fatal");
	const proof = continuationDeathProof(after);
	expect(proof).not.toBeNull();
	if (!proof) throw new Error("Missing no-growth continuation certificate");
	auditProof(after, proof);
	expect(proof.collisionWithinMoves).toBeLessThanOrEqual(
		fixture.collisionWithinMovesAfterGrowth,
	);
	const freeCells =
		after.config.width * after.config.height -
		after.obstacles.length -
		after.snake.length;
	expect(freeCells).toBe(fixture.freeCellsAfterGrowth);
	expect(freeCells).toBeGreaterThanOrEqual(proof.collisionWithinMoves);
	expect(postAppleDeathProof(after)).toEqual({
		collisionWithinMoves: proof.collisionWithinMoves,
		freeCellsAfterGrowth: fixture.freeCellsAfterGrowth,
	});
	// The richer growth certificate also proves the other available exit;
	// its previous null result was not an escape witness.
	const other = fixture.otherFatalCandidate as Direction;
	expect(analyzeAction(state, other).danger).toBe("proven_fatal");
	const otherProof = continuationDeathProof(advanceGeometry(state, other));
	expect(otherProof).not.toBeNull();
	if (!otherProof) throw new Error("Missing other exit certificate");
	auditProof(advanceGeometry(state, other), otherProof);
	expect(state).toEqual(before);
});

test("the earlier 1142 entrance includes post-growth certificates before any apple is eaten", () => {
	const fixture = replay.entryCase;
	const state = structuredClone(fixture.state) as PublicState;
	const candidate = fixture.candidate as Direction;
	expect(inspectMove(state, candidate).eatsApple).toBe(false);
	expect(analyzeAction(state, candidate).danger).toBe("proven_fatal");
	const after = advanceGeometry(state, candidate);
	const proof = continuationDeathProof(after);
	expect(proof).not.toBeNull();
	if (!proof) throw new Error("Missing early entrance certificate");
	expect(proof.branches.map((branch) => branch.direction)).toEqual(
		fixture.expectedExits,
	);
	expect(proof.collisionWithinMoves).toBeLessThanOrEqual(
		fixture.collisionWithinMovesAfterCandidate,
	);
	auditProof(after, proof);
	const pending = [proof];
	let growthLeaves = 0;
	while (pending.length) {
		for (const branch of pending.pop()!.branches) {
			if (branch.proof.kind === "continuation") pending.push(branch.proof);
			else if (branch.proof.kind === "post_apple_forced_death") growthLeaves++;
		}
	}
	expect(growthLeaves).toBeGreaterThan(0);
});

test.each([false, true])(
	"post-growth win exclusion respects F=B-1 versus F=B (extra cell=%s)",
	(extraCell) => {
		const runtime = baseState();
		runtime.config = { ...runtime.config, width: 5, height: 16 };
		runtime.snake = Array.from({ length: 13 }, (_, index) => ({
			x: 2,
			y: index + 2,
		}));
		runtime.direction = "up";
		runtime.apple = null;
		const free = [
			{ x: 2, y: 1 },
			{ x: 3, y: 1 },
			{ x: 3, y: 2 },
			...(extraCell ? [{ x: 2, y: 15 }] : []),
		];
		const open = new Set(
			[...runtime.snake, ...free].map((point) => `${point.x},${point.y}`),
		);
		runtime.obstacles = Array.from({ length: 80 }, (_, cell) => ({
			x: cell % 5,
			y: Math.floor(cell / 5),
		})).filter((point) => !open.has(`${point.x},${point.y}`));
		runtime.config.obstacleCount = runtime.obstacles.length;
		const state = publicState(runtime);
		expect(legalDirections(state)).toEqual(["up", "right"]);
		expect(postAppleForcedDeath(state)).toBeNull();
		const proof = continuationDeathProof(state);
		expect(proof?.collisionWithinMoves).toBe(4);
		if (!proof) throw new Error("Missing finite no-growth certificate");
		auditProof(state, proof);
		expect(free).toHaveLength(extraCell ? 4 : 3);
		expect(postAppleDeathProof(state)).toEqual(
			extraCell ? { collisionWithinMoves: 4, freeCellsAfterGrowth: 4 } : null,
		);
		if (!extraCell) {
			// One possible future reward placement fills the board in B-1 moves.
			// This controlled fixture does not predict the live game's next apple.
			const results = (["up", "right", "down"] as const).map((direction, i) => {
				runtime.apple = free[i];
				return move(runtime, direction).type;
			});
			expect(results).toEqual(["apple", "apple", "won"]);
			expect(runtime.status).toBe("won");
		}
	},
);

test("a finite fatal branch alongside a legal ordered-body cycle stays unknown", () => {
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
	expect(legalDirections(state)).toEqual(["up", "right"]);
	expect(analyzeAction(state, "up").danger).toBe("proven_fatal");
	expect(continuationDeathProof(state)).toBeNull();
	let position = state;
	for (const direction of ["right", "down", "left", "up"] as const) {
		expect(inspectMove(position, direction).immediateCollision).toBeNull();
		position = advanceGeometry(position, direction);
	}
	expect(position.snake).toEqual(state.snake);
	expect(position.direction).toBe(state.direction);
});

test("uncertified apple growth and a completed board are not death certificates", () => {
	const state = publicState(nearComplete());
	expect(continuationDeathProof(state)).toBeNull();
	expect(analyzeAction(state, "right")).toMatchObject({
		danger: null,
		terminal: "board_complete",
	});
	expect(continuationDeathProof(advanceGeometry(state, "right"))).toBeNull();
	state.snake = [3, 2, 1, 0].map((x) => ({ x, y: 0 }));
	state.apple = { x: 4, y: 0 };
	expect(forcedPath(state, "right").outcome).toBe("unknown_after_apple");
	expect(continuationDeathProof(state)).toBeNull();
	expect(analyzeAction(state, "right").danger).toBeNull();
});
