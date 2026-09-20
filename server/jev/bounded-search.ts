import {
	DEFAULT_LOCAL_SEARCH_OPTIONS,
	type LocalSearchEvidence,
	type LocalSearchMove,
	type LocalSearchOptions,
} from "../../shared/snake/bounded-search.js";
import {
	type Direction,
	directions,
	type PublicState,
} from "../../shared/snake/types.js";
import { inspectMove } from "../game/engine.js";

/** Bounded geometric evidence only. Never chooses a move or predicts new food. */
export function searchLocalMoves(
	state: PublicState,
	options: LocalSearchOptions = DEFAULT_LOCAL_SEARCH_OPTIONS,
): LocalSearchEvidence {
	const { maxDepth, maxNodes } = options;
	if (!Number.isSafeInteger(maxDepth) || maxDepth < 1)
		throw new RangeError(
			"Local search maxDepth must be a positive safe integer",
		);
	if (!Number.isSafeInteger(maxNodes) || maxNodes < 0)
		throw new RangeError(
			"Local search maxNodes must be a nonnegative safe integer",
		);
	const { width, height } = state.config;
	const cellCount = width * height;
	const obstacles = new Uint8Array(cellCount);
	for (const point of state.obstacles) obstacles[point.y * width + point.x] = 1;
	const originalBody = Int32Array.from(
		state.snake,
		(point) => point.y * width + point.x,
	);
	const originalOccupied = new Uint8Array(cellCount);
	for (const cell of originalBody) originalOccupied[cell] = 1;
	const bodyLength = originalBody.length;
	const apple = state.apple ? state.apple.y * width + state.apple.x : -1;
	const initialHeading = directions.indexOf(state.direction);
	const offsets = [-width, 1, width, -1];
	const legalFirst = directions.map(
		(direction) => inspectMove(state, direction).immediateCollision === null,
	);
	const legalCount = legalFirst.filter(Boolean).length;
	const nodeBudget = legalCount === 0 ? 0 : Math.floor(maxNodes / legalCount);

	function searchCandidate(first: number): LocalSearchMove {
		const base: LocalSearchMove = {
			status: "blocked",
			expandedNodes: 0,
			nodeBudget: legalFirst[first] ? nodeBudget : 0,
			maxDepthReached: 0,
			cutoff: "none",
			witness: null,
			appleExitDirections: null,
		};
		if (!legalFirst[first]) return base;
		if (nodeBudget === 0)
			return { ...base, status: "unknown", cutoff: "nodes" };

		// The fixed-length ring only handles non-growing moves. The first apple
		// ends this search, so no additional body or hypothetical food is created.
		const body = originalBody.slice();
		const occupied = originalOccupied.slice();
		const stackSize = Math.min(maxDepth, nodeBudget);
		const path = new Uint8Array(stackSize);
		const remaining = new Uint8Array(stackSize);
		const removedTails = new Int32Array(stackSize);
		let headIndex = 0;
		let heading = initialHeading;
		let bestWitness: Direction[] | null = null;
		const witness = (depth: number) =>
			Array.from(path.subarray(0, depth), (direction) => directions[direction]);
		const result = (
			status: LocalSearchMove["status"],
			cutoff: LocalSearchMove["cutoff"],
			route: Direction[] | null,
			appleExitDirections: Direction[] | null = null,
		): LocalSearchMove => ({
			...base,
			status,
			cutoff,
			witness: route,
			appleExitDirections,
		});

		function adjacentCell(head: number, direction: number): number {
			if (
				(direction === 0 && head < width) ||
				(direction === 1 && head % width === width - 1) ||
				(direction === 2 && head >= cellCount - width) ||
				(direction === 3 && head % width === 0)
			)
				return -1;
			const target = head + offsets[direction];
			if (obstacles[target]) return -1;
			return target;
		}

		function targetFor(direction: number): number {
			if (direction === (heading + 2) % 4) return -1;
			const target = adjacentCell(body[headIndex], direction);
			if (target < 0) return -1;
			const tail = body[(headIndex + bodyLength - 1) % bodyLength];
			if (occupied[target] && (target === apple || target !== tail)) return -1;
			return target;
		}

		function exitsAfterApple(head: number, incoming: number): Direction[] {
			// Growth adds this head while retaining the current body and tail.
			// On the next move that tail may vacate: a newly spawned apple cannot
			// occupy it. Every other occupied body cell still blocks that move.
			const tail = body[(headIndex + bodyLength - 1) % bodyLength];
			return directions.filter((_, direction) => {
				if (direction === (incoming + 2) % 4) return false;
				const target = adjacentCell(head, direction);
				return target >= 0 && (!occupied[target] || target === tail);
			});
		}

		function undo(depth: number) {
			occupied[body[headIndex]] = 0;
			body[headIndex] = removedTails[depth - 1];
			occupied[body[headIndex]] = 1;
			headIndex = (headIndex + 1) % bodyLength;
			heading = depth === 1 ? initialHeading : path[depth - 2];
		}

		for (let limit = 1; limit <= maxDepth; limit++) {
			let depth = 0;
			let nextDirection = first;
			let depthCutoff = false;
			for (;;) {
				if (base.expandedNodes === nodeBudget)
					return result(
						bestWitness ? "survival_found" : "unknown",
						"nodes",
						bestWitness,
					);
				const target = targetFor(nextDirection);
				// The first candidate and every selected edge were checked before entry.
				if (target < 0) throw new Error("Local search entered a blocked move");
				depth++;
				path[depth - 1] = nextDirection;
				base.expandedNodes++;
				base.maxDepthReached = Math.max(base.maxDepthReached, depth);
				if (target === apple) {
					const won = bodyLength + 1 === cellCount - state.obstacles.length;
					if (won) return result("win_reachable", "none", witness(depth));
					const appleExits = exitsAfterApple(target, nextDirection);
					if (appleExits.length)
						return result(
							"apple_reachable",
							"apple",
							witness(depth),
							appleExits,
						);
					// This growth endpoint has no legal next move for any respawn.
					// It is a dead leaf, not proof that other routes from this candidate die.
					// No ring mutation or food-after-growth tree expansion has occurred.
					depth--;
				} else {
					const tailIndex = (headIndex + bodyLength - 1) % bodyLength;
					removedTails[depth - 1] = body[tailIndex];
					occupied[body[tailIndex]] = 0;
					body[tailIndex] = target;
					occupied[target] = 1;
					headIndex = tailIndex;
					heading = nextDirection;
					let exits = 0;
					for (let direction = 0; direction < directions.length; direction++)
						if (targetFor(direction) >= 0) exits |= 1 << direction;
					if (exits && depth > (bestWitness?.length ?? 0))
						bestWitness = witness(depth);
					if (exits && depth === limit) depthCutoff = true;
					remaining[depth - 1] = depth === limit ? 0 : exits;
				}

				while (depth > 0 && remaining[depth - 1] === 0) {
					undo(depth);
					depth--;
				}
				if (depth === 0) break;
				const mask = remaining[depth - 1];
				nextDirection = 0;
				while (!(mask & (1 << nextDirection))) nextDirection++;
				remaining[depth - 1] &= ~(1 << nextDirection);
			}
			if (!depthCutoff) return result("proven_dead", "none", null);
		}
		return result("survival_found", "depth", bestWitness);
	}

	const moves = Object.fromEntries(
		directions.map((direction, index) => [direction, searchCandidate(index)]),
	) as Record<Direction, LocalSearchMove>;
	return {
		algorithm: "iterative_deepening_dfs",
		foodBoundary: "stop_at_current_apple",
		maxDepth,
		maxNodes,
		expandedNodes: Object.values(moves).reduce(
			(sum, move) => sum + move.expandedNodes,
			0,
		),
		moves,
	};
}
