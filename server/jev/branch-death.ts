import {
	type Direction,
	directions,
	type Point,
	type PublicState,
	vectors,
} from "../../shared/snake/types.js";
import { inspectMove } from "../game/engine.js";
import { forcedPath } from "./context.js";
import { frozenSearch } from "./geometry-search.js";
import {
	postAppleForcedDeath,
	type PostAppleForcedDeath,
	trappedRegion,
	type TrappedRegion,
} from "./trap-geometry.js";

type BranchProof =
	| { kind: "forced_path"; steps: number }
	| ({ kind: "trapped_region" } & TrappedRegion)
	| ({ kind: "post_apple_forced_death" } & PostAppleForcedDeath)
	| ({ kind: "continuation" } & ContinuationDeathProof);
type ProvenBranch = {
	direction: Direction;
	// From the junction, including this direction and the collision attempt.
	collisionWithinMoves: number;
	proof: BranchProof;
};
export type ContinuationDeathProof = {
	// From the supplied state, including the eventual collision attempt.
	collisionWithinMoves: number;
	forcedPrefixMoves: number;
	branchHead: Point;
	// All legal exits at branchHead. Empty means there are no legal exits;
	// one exit is possible when a forced prefix reaches the observed apple.
	branches: ProvenBranch[];
};

const complete = (state: PublicState) =>
	state.snake.length ===
	state.config.width * state.config.height - state.obstacles.length;

// Pure geometry; inspectMove is also the live engine's collision/growth rule.
// Eating the observed apple clears it, without generating future food or RNG.
function advance(state: PublicState, direction: Direction): PublicState {
	const next = inspectMove(state, direction);
	if (next.immediateCollision)
		throw new Error(`Cannot prove ${direction}: ${next.immediateCollision}`);
	return {
		...state,
		direction,
		snake: [
			next.target,
			...(next.eatsApple ? state.snake : state.snake.slice(0, -1)),
		],
		apple: next.eatsApple ? null : state.apple,
	};
}

// After the observed apple, future food is unknown. Removing all later growth
// releases body cells as early as possible: every real legal head path is also
// legal in this optimistic geometry. Its finite death proof therefore applies
// to every respawn, unless enough successful moves remain to fill the board.
function findPostAppleDeathProof(
	afterGrowth: PublicState,
	analyzer: DeathAnalyzer,
): PostAppleForcedDeath | null {
	const forced = postAppleForcedDeath(afterGrowth);
	if (forced) return forced;
	const freeCellsAfterGrowth =
		afterGrowth.config.width * afterGrowth.config.height -
		afterGrowth.obstacles.length -
		afterGrowth.snake.length;
	if (freeCellsAfterGrowth === 0) return null;
	const proof = analyzer.continuation({ ...afterGrowth, apple: null });
	// The bound includes the collision, so there can be at most B-1 apples
	// before it. F >= B excludes winning first, including the F = B boundary.
	return proof && freeCellsAfterGrowth >= proof.collisionWithinMoves
		? { collisionWithinMoves: proof.collisionWithinMoves, freeCellsAfterGrowth }
		: null;
}

function proveBranch(
	state: PublicState,
	direction: Direction,
	analyzer: DeathAnalyzer,
): ProvenBranch | null {
	const next = inspectMove(state, direction);
	const after = advance(state, direction);
	if (complete(after)) return null;
	const path = forcedPath(state, direction);
	if (path.outcome === "board_complete") return null;
	if (path.outcome === "forced_collision")
		return {
			direction,
			collisionWithinMoves: path.steps,
			proof: { kind: "forced_path", steps: path.steps },
		};
	const region = trappedRegion(after);
	if (region)
		return {
			direction,
			collisionWithinMoves: 1 + region.regionCells,
			proof: { kind: "trapped_region", ...region },
		};
	const postApple = next.eatsApple ? analyzer.postApple(after) : null;
	if (postApple)
		return {
			direction,
			collisionWithinMoves: 1 + postApple.collisionWithinMoves,
			proof: { kind: "post_apple_forced_death", ...postApple },
		};
	return null;
}

type ContinuationFrame = {
	startKey: string;
	activeKeys: string[];
	position: PublicState;
	forcedPrefixMoves: number;
	branches: ProvenBranch[];
	unproven: { direction: Direction; index: number }[];
	pending: number;
};

const positionKey = (state: PublicState) =>
	JSON.stringify([state.direction, state.snake]);

// A simple head-to-tail path plus the original tail-to-head body chain is a
// closed route at least as long as the snake. Verify the complete lap using
// the live collision rule; the same ordered body and heading must return.
// This is an existence witness against unavoidable death, never a controller.
function hasTailCycle(state: PublicState): boolean {
	const route = frozenSearch(state, {
		goal: state.snake[state.snake.length - 1],
		tailTerminal: true,
		avoidApple: true,
		firstDirection: true,
	}).route;
	if (!route) return false;
	const lap = [...route];
	for (let i = state.snake.length - 1; i > 0; i--) {
		const from = state.snake[i],
			to = state.snake[i - 1];
		const direction = directions.find(
			(d) => from.x + vectors[d].x === to.x && from.y + vectors[d].y === to.y,
		);
		if (!direction) throw new Error("Snake body is not a contiguous path");
		lap.push(direction);
	}
	let position = state;
	for (const direction of lap) {
		const next = inspectMove(position, direction);
		if (next.immediateCollision || next.eatsApple) return false;
		position = advance(position, direction);
	}
	return positionKey(position) === positionKey(state);
}

function combine(
	forcedPrefixMoves: number,
	branchHead: Point,
	branches: ProvenBranch[],
): ContinuationDeathProof {
	return {
		collisionWithinMoves:
			forcedPrefixMoves +
			Math.max(1, ...branches.map((branch) => branch.collisionWithinMoves)),
		forcedPrefixMoves,
		branchHead,
		branches,
	};
}

// An exact unique corridor followed by one junction with leaf certificates.
// A growth leaf may separately analyze the optimistic no-further-growth board;
// it never predicts another food spawn or recursively crosses another apple.
function singleJunctionDeathProof(
	afterCandidate: PublicState,
	analyzer: DeathAnalyzer,
): ContinuationDeathProof | null {
	let position = afterCandidate;
	let forcedPrefixMoves = 0;
	const seen = new Set<string>();
	for (;;) {
		if (complete(position)) return null;
		const key = JSON.stringify([position.direction, position.snake]);
		if (seen.has(key)) return null;
		seen.add(key);
		const exits = directions.filter(
			(direction) =>
				inspectMove(position, direction).immediateCollision === null,
		);
		if (exits.length !== 1 || inspectMove(position, exits[0]).eatsApple) {
			const branches: ProvenBranch[] = [];
			for (const direction of exits) {
				const proof = proveBranch(position, direction, analyzer);
				if (!proof) return null;
				branches.push(proof);
			}
			return combine(forcedPrefixMoves, { ...position.snake[0] }, branches);
		}
		position = advance(position, exits[0]);
		forcedPrefixMoves++;
	}
}

function proveKnownBranch(
	state: PublicState,
	direction: Direction,
	analyzer: DeathAnalyzer,
): ProvenBranch | null {
	const primitive = proveBranch(state, direction, analyzer);
	if (primitive) return primitive;
	if (inspectMove(state, direction).eatsApple) return null;
	const continuation = singleJunctionDeathProof(
		advance(state, direction),
		analyzer,
	);
	return continuation
		? {
				direction,
				collisionWithinMoves: 1 + continuation.collisionWithinMoves,
				proof: { kind: "continuation", ...continuation },
			}
		: null;
}

// Prove the conjunction of ALL legal exits, including several exits that each
// require deeper certificates. An explicit DFS stack avoids recursion limits.
// Only states on the active path indicate a repeatable cycle; a completed
// proof may be reused after two branches converge. The memo belongs to this
// board/apple observation, and no branch crosses uncertified apple growth.
// A cycle, a win or an uncertified growth route is a concrete reason this
// all-continuations certificate cannot be established, not a search budget.
function findContinuationDeathProof(
	afterCandidate: PublicState,
	analyzer: DeathAnalyzer,
): ContinuationDeathProof | null {
	let position = afterCandidate;
	const active = new Set<string>();
	const completed = new Map<string, ContinuationDeathProof>();
	const frames: ContinuationFrame[] = [];
	for (;;) {
		const startKey = positionKey(position);
		let proof = completed.get(startKey);
		if (!proof) {
			const activeKeys: string[] = [];
			let forcedPrefixMoves = 0;
			for (;;) {
				if (complete(position)) return null;
				const key = positionKey(position);
				if (active.has(key)) return null;
				active.add(key);
				activeKeys.push(key);
				const exits = directions.filter(
					(direction) =>
						inspectMove(position, direction).immediateCollision === null,
				);
				if (exits.length === 1 && !inspectMove(position, exits[0]).eatsApple) {
					position = advance(position, exits[0]);
					forcedPrefixMoves++;
					continue;
				}
				const branches: ProvenBranch[] = [];
				const unproven: { direction: Direction; index: number }[] = [];
				for (const [index, direction] of exits.entries()) {
					const known = proveKnownBranch(position, direction, analyzer);
					if (known) branches[index] = known;
					else {
						if (inspectMove(position, direction).eatsApple) return null;
						unproven.push({ direction, index });
					}
				}
				if (unproven.length === 0) {
					proof = combine(
						forcedPrefixMoves,
						{ ...position.snake[0] },
						branches,
					);
					completed.set(startKey, proof);
					for (const pathKey of activeKeys) active.delete(pathKey);
				} else {
					if (hasTailCycle(position)) return null;
					frames.push({
						startKey,
						activeKeys,
						position,
						forcedPrefixMoves,
						branches,
						unproven,
						pending: 0,
					});
					position = advance(position, unproven[0].direction);
				}
				break;
			}
		}
		if (!proof) continue;
		while (proof) {
			const parent = frames.at(-1);
			if (!parent) return proof;
			const edge = parent.unproven[parent.pending];
			parent.branches[edge.index] = {
				direction: edge.direction,
				collisionWithinMoves: 1 + proof.collisionWithinMoves,
				proof: { kind: "continuation", ...proof },
			};
			parent.pending++;
			if (parent.pending < parent.unproven.length) {
				position = advance(
					parent.position,
					parent.unproven[parent.pending].direction,
				);
				break;
			}
			proof = combine(
				parent.forcedPrefixMoves,
				{ ...parent.position.snake[0] },
				parent.branches,
			);
			completed.set(parent.startKey, proof);
			for (const pathKey of parent.activeKeys) active.delete(pathKey);
			frames.pop();
		}
	}
}

export type DeathAnalyzer = {
	continuation(state: PublicState): ContinuationDeathProof | null;
	postApple(state: PublicState): PostAppleForcedDeath | null;
};

// One analyzer lives for one context build. Keys include all collision/growth
// geometry so reusing it across candidate boards or apples cannot reuse a
// conclusion for a different problem. Clocks, scores and stars do not affect
// these proofs. Never cache by object identity: game snapshots can be mutated.
export function createDeathAnalyzer(): DeathAnalyzer {
	const continuations = new Map<string, ContinuationDeathProof | null>();
	const growth = new Map<string, PostAppleForcedDeath | null>();
	const key = (state: PublicState, afterApple = false) =>
		JSON.stringify([
			state.config.width,
			state.config.height,
			state.obstacles,
			afterApple ? null : state.apple,
			state.direction,
			state.snake,
		]);
	const analyzer: DeathAnalyzer = {
		continuation(state) {
			const id = key(state);
			if (continuations.has(id)) return continuations.get(id)!;
			const proof = findContinuationDeathProof(state, analyzer);
			continuations.set(id, proof);
			return proof;
		},
		postApple(state) {
			const id = key(state, true);
			if (growth.has(id)) return growth.get(id)!;
			const proof = findPostAppleDeathProof(state, analyzer);
			growth.set(id, proof);
			return proof;
		},
	};
	return analyzer;
}

export function continuationDeathProof(
	state: PublicState,
): ContinuationDeathProof | null {
	return createDeathAnalyzer().continuation(state);
}

export function postAppleDeathProof(
	state: PublicState,
): PostAppleForcedDeath | null {
	return createDeathAnalyzer().postApple(state);
}
