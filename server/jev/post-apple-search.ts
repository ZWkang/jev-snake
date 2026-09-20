import { type LocalSearchOptions } from "../../shared/snake/bounded-search.js";
import {
	DEFAULT_POST_APPLE_SEARCH_OPTIONS,
	type PostAppleCheck,
	type PostAppleSearchEvidence,
	type PostAppleSearchMove,
} from "../../shared/snake/post-apple-search.js";
import {
	type Direction,
	directions,
	type PublicState,
} from "../../shared/snake/types.js";
import { inspectMove } from "../game/engine.js";

/** Bounded geometric evidence only. Never chooses a move or predicts new food. */
export function searchPostAppleMoves(
	state: PublicState,
	options: LocalSearchOptions = DEFAULT_POST_APPLE_SEARCH_OPTIONS,
): PostAppleSearchEvidence {
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

	function searchCandidate(first: number): PostAppleSearchMove {
		const base: PostAppleSearchMove = {
			status: "blocked",
			expandedNodes: 0,
			nodeBudget: legalFirst[first] ? nodeBudget : 0,
			maxDepthReached: 0,
			cutoff: "none",
			witness: null,
			appleExitDirections: null,
			postApple: null,
			rejectedAppleEndpoints: 0,
			postAppleExpandedNodes: 0,
		};
		if (!legalFirst[first]) return base;
		if (nodeBudget === 0)
			return { ...base, status: "unknown", cutoff: "nodes" };

		// One ring handles the real prefix before the current apple. A second,
		// reusable ring checks the grown endpoint without predicting later food.
		const body = originalBody.slice();
		const occupied = originalOccupied.slice();
		const stackSize = Math.min(maxDepth, nodeBudget);
		const path = new Uint8Array(stackSize);
		const remaining = new Uint8Array(stackSize);
		const removedTails = new Int32Array(stackSize);
		const grownLength = bodyLength + 1;
		const postBody = new Int32Array(grownLength);
		const postOccupied = new Uint8Array(cellCount);
		const postPath = new Uint8Array(stackSize);
		const postRemaining = new Uint8Array(stackSize + 1);
		const postTails = new Int32Array(stackSize);
		let headIndex = 0;
		let heading = initialHeading;
		let bestWitness: Direction[] | null = null;
		const witness = (depth: number) =>
			Array.from(path.subarray(0, depth), (direction) => directions[direction]);
		const result = (
			status: PostAppleSearchMove["status"],
			cutoff: PostAppleSearchMove["cutoff"],
			route: Direction[] | null,
			appleExitDirections: Direction[] | null = null,
			postApple: PostAppleCheck | null = null,
		): PostAppleSearchMove => ({
			...base,
			status,
			cutoff,
			witness: route,
			appleExitDirections,
			postApple,
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

		/** Null is a complete death proof; cutoffs are explicitly unproven. */
		function checkAfterApple(
			appleHead: number,
			incoming: number,
			prefixDepth: number,
			exits: Direction[],
		): PostAppleCheck | null {
			const postLimit = maxDepth - prefixDepth;
			const remainingGrowth = cellCount - state.obstacles.length - grownLength;
			let expandedNodes = 0;
			let maxDepthReached = 0;
			const check = (
				result: PostAppleCheck["result"],
				cutoff: PostAppleCheck["cutoff"],
			): PostAppleCheck => ({
				assumption: "no_further_growth",
				result,
				cutoff,
				maxDepth: postLimit,
				maxDepthReached,
				expandedNodes,
			});
			if (postLimit === 0) return check("unknown", "depth");
			postBody[0] = appleHead;
			for (let index = 0; index < bodyLength; index++)
				postBody[index + 1] = body[(headIndex + index) % bodyLength];
			postOccupied.set(occupied);
			postOccupied[appleHead] = 1;
			let postHeadIndex = 0;
			let postHeading = incoming;
			let depth = 0;
			postRemaining[0] = exits.reduce(
				(mask, direction) => mask | (1 << directions.indexOf(direction)),
				0,
			);
			const targetAfterApple = (direction: number) => {
				if (direction === (postHeading + 2) % 4) return -1;
				const target = adjacentCell(postBody[postHeadIndex], direction);
				if (target < 0) return -1;
				const tail = postBody[(postHeadIndex + grownLength - 1) % grownLength];
				return postOccupied[target] && target !== tail ? -1 : target;
			};
			for (;;) {
				if (postRemaining[depth] === 0) {
					if (depth === 0) return null;
					postOccupied[postBody[postHeadIndex]] = 0;
					postBody[postHeadIndex] = postTails[depth - 1];
					postOccupied[postBody[postHeadIndex]] = 1;
					postHeadIndex = (postHeadIndex + 1) % grownLength;
					postHeading = depth === 1 ? incoming : postPath[depth - 2];
					depth--;
					continue;
				}
				if (base.expandedNodes === nodeBudget) return check("unknown", "nodes");
				let direction = 0;
				while (!(postRemaining[depth] & (1 << direction))) direction++;
				postRemaining[depth] &= ~(1 << direction);
				const target = targetAfterApple(direction);
				if (target < 0)
					throw new Error("Post-apple search entered a blocked move");
				postPath[depth] = direction;
				const tailIndex = (postHeadIndex + grownLength - 1) % grownLength;
				postTails[depth] = postBody[tailIndex];
				postOccupied[postBody[tailIndex]] = 0;
				postBody[tailIndex] = target;
				postOccupied[target] = 1;
				postHeadIndex = tailIndex;
				postHeading = direction;
				depth++;
				expandedNodes++;
				base.expandedNodes++;
				base.postAppleExpandedNodes++;
				maxDepthReached = Math.max(maxDepthReached, depth);
				base.maxDepthReached = Math.max(
					base.maxDepthReached,
					prefixDepth + depth,
				);
				// An actual future apple on every step might finish the board first.
				// This possibility takes precedence over a later no-growth dead end.
				if (depth >= remainingGrowth) return check("unknown", "possible_win");
				let nextExits = 0;
				for (let next = 0; next < directions.length; next++)
					if (targetAfterApple(next) >= 0) nextExits |= 1 << next;
				if (nextExits && depth === postLimit)
					return check("survival_possible", "depth");
				postRemaining[depth] = nextExits;
			}
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
					if (appleExits.length) {
						const postApple = checkAfterApple(
							target,
							nextDirection,
							depth,
							appleExits,
						);
						if (postApple)
							return result(
								"apple_reachable",
								"apple",
								witness(depth),
								appleExits,
								postApple,
							);
					}
					// Only a complete optimistic death proof rejects this endpoint.
					// Other pre-apple routes retain the same remaining candidate budget.
					base.rejectedAppleEndpoints++;
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
	) as Record<Direction, PostAppleSearchMove>;
	return {
		algorithm: "iterative_deepening_with_post_apple",
		foodBoundary: "optimistic_no_growth_after_apple",
		maxDepth,
		maxNodes,
		expandedNodes: Object.values(moves).reduce(
			(sum, move) => sum + move.expandedNodes,
			0,
		),
		moves,
	};
}
