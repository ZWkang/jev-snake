import type {
	GrowthAnalysisLimits,
	GrowthMoveFacts,
	GrowthSpaceAnalysis,
	GrowthTrapFacts,
	PostAppleCheck,
} from "./growth-space.js";
import { describeLegalSpaceMove } from "./legal-space-analysis.js";
import type { LegalSpaceInput, LegalSpaceMoveFacts } from "./legal-space.js";
import { inspectMove, type MoveGeometry } from "./move-rules.js";
import { directions, vectors, type Direction, type Point } from "./types.js";

export const defaultGrowthLimits: Readonly<GrowthAnalysisLimits> =
	Object.freeze({
		trapDepth: 8,
		appleDepth: 32,
		postAppleDepth: 8,
		maxNodesPerSearch: 2048,
	});
export const liveGrowthLimits: Readonly<GrowthAnalysisLimits> = Object.freeze({
	...defaultGrowthLimits,
	appleDepth: 128,
});

/** Internal search witnesses; neither paths nor automatic actions are emitted. */
export type GrowthRouteWitnesses = Partial<Record<Direction, Direction[]>>;
export type GrowthSearchOptions = {
	retainedRoutes?: GrowthRouteWitnesses;
	onRouteFound?: (direction: Direction, route: Direction[]) => void;
};
export const growthSpaceSemantics =
	"Every legal first direction is retained and analyzed independently with identical explicit limits. Trap moves includes the first action as move 1. The full ordered body moves and grows at the currently observed apple. After that apple, ateApple remains true and no future food or RNG is sampled: further growth is omitted as an optimistic relaxation. Failure of every optimistic continuation proves a trap only after excluding a possible earlier board-completion win from additional growth. If the remaining free cells could be filled within the longest remaining continuation, unknown_near_win with null moves is reported instead of death. horizon_reached witnesses the checked window before any apple; optimistic_horizon_reached witnesses only a no-further-growth continuation, not survival under real future food. node_limit is unresolved and has null moves. board_complete is a found winning continuation, not necessarily this first move. Apple search is bounded best-first using g+16*Manhattan, and a found route is not shortest or optimal. Each apple arrival is checked for up to postAppleDepth subsequent moves; its postApple.moves excludes the eating move and starts at 0. A proven-trapped arrival is rejected and other body arrangements are still searched. route_with_optimistic_continuation requires a full postAppleDepth optimistic continuation; it is not a safe route. route_postcheck_unknown retains only an unresolved postcheck, never a safety certificate. route_wins fills all traversable cells. Unknown arrivals do not stop the search for a stronger arrival while budgets remain. Apple exploredNodes counts expanded states, excluding stale worse arrivals. Total enqueued and visited states are also bounded by maxNodesPerSearch. All post-apple checks for one first direction share a separate cumulative maxNodesPerSearch node budget; postAppleNodes includes every such check, including rejectedTrapArrivals. Each postcheck exploredNodes counts its root at depth0 when budget is available, and may be0 if the shared budget is already exhausted. Search exhaustion, depth limits, node limits and postcheck node limits are explicit; no_qualifying_route_found is not proof that no useful route exists. Paths and recommendations are never supplied. Static tail connection and immediate exits are supporting facts, not long-term safety.";

type Position = {
	snake: readonly Point[];
	direction: Direction;
	depth: number;
	ateApple: boolean;
};

function geometry(input: LegalSpaceInput, position: Position): MoveGeometry {
	return {
		config: { width: input.width, height: input.height },
		snake: position.snake,
		direction: position.direction,
		obstacles: input.obstacles,
		apple: position.ateApple ? null : input.apple,
	};
}

function advance(
	input: LegalSpaceInput,
	position: Position,
	direction: Direction,
): Position | null {
	const fact = inspectMove(geometry(input, position), direction);
	if (fact.immediateCollision) return null;
	return {
		snake: [
			fact.target,
			...(fact.eatsApple ? position.snake : position.snake.slice(0, -1)),
		],
		direction,
		depth: position.depth + 1,
		ateApple: position.ateApple || fact.eatsApple,
	};
}

function legalNext(input: LegalSpaceInput, position: Position): Direction[] {
	const board = geometry(input, position);
	return directions.filter(
		(direction) => inspectMove(board, direction).immediateCollision === null,
	);
}

function wins(input: LegalSpaceInput, position: Position): boolean {
	return (
		position.ateApple &&
		position.snake.length ===
			input.width * input.height - input.obstacles.length
	);
}

type SearchBudget = { used: number; max: number };

function optimisticSearch(
	input: LegalSpaceInput,
	first: Position,
	depthLimit: number,
	budget: SearchBudget,
): GrowthTrapFacts {
	const started = budget.used;
	type Result = Omit<GrowthTrapFacts, "exploredNodes">;
	function visit(position: Position): Result {
		if (budget.used === budget.max)
			return { status: "node_limit", moves: null };
		budget.used++;
		if (wins(input, position))
			return { status: "board_complete", moves: position.depth };
		const next = legalNext(input, position);
		if (!next.length) return { status: "proven_trap", moves: position.depth };
		if (position.depth === depthLimit)
			return {
				status: position.ateApple
					? "optimistic_horizon_reached"
					: "horizon_reached",
				moves: position.depth,
			};
		let longest = position.depth;
		for (const direction of next) {
			const result = visit(advance(input, position, direction)!);
			if (result.status !== "proven_trap") return result;
			longest = Math.max(longest, result.moves!);
		}
		// More future growth cannot add a legal route, but it could win before the
		// optimistic body runs out of moves. Do not misclassify that exception.
		const free =
			input.width * input.height -
			input.obstacles.length -
			position.snake.length;
		if (position.ateApple && free <= longest - position.depth)
			return { status: "unknown_near_win", moves: null };
		return { status: "proven_trap", moves: longest };
	}
	const result = visit(first);
	return { ...result, exploredNodes: budget.used - started };
}

function postAppleCheck(
	input: LegalSpaceInput,
	arrival: Position,
	limits: GrowthAnalysisLimits,
	budget: SearchBudget,
): PostAppleCheck {
	const result = optimisticSearch(
		input,
		{ ...arrival, depth: 0, ateApple: true },
		limits.postAppleDepth,
		budget,
	);
	if (result.status === "horizon_reached" || result.status === "board_complete")
		throw new Error(
			"Invalid post-apple check: expected a non-winning, already-grown arrival",
		);
	return {
		status: result.status,
		moves: result.moves,
		exploredNodes: result.exploredNodes,
	};
}

function staticTailConnection(
	input: LegalSpaceInput,
	snake: readonly Point[],
): boolean {
	const index = (point: Point) => point.y * input.width + point.x;
	const blocked = new Set([...input.obstacles, ...snake].map(index));
	const tail = snake[snake.length - 1];
	const touchesTail = (point: Point) =>
		Math.abs(point.x - tail.x) + Math.abs(point.y - tail.y) === 1;
	const queue: Point[] = [snake[0]];
	const visited = new Set([index(snake[0])]);
	for (let cursor = 0; cursor < queue.length; cursor++) {
		const point = queue[cursor];
		if (touchesTail(point)) return true;
		for (const direction of directions) {
			const v = vectors[direction];
			const target = { x: point.x + v.x, y: point.y + v.y };
			if (
				target.x < 0 ||
				target.y < 0 ||
				target.x >= input.width ||
				target.y >= input.height
			)
				continue;
			const key = index(target);
			if (blocked.has(key) || visited.has(key)) continue;
			visited.add(key);
			queue.push(target);
		}
	}
	return false;
}

function positionKey(position: Position): string {
	return `${position.ateApple ? 1 : 0}:${position.direction}:${position.snake.map((point) => `${point.x},${point.y}`).join(";")}`;
}

type RouteLink = { direction: Direction; previous: RouteLink | null };
function routeDirections(link: RouteLink): Direction[] {
	const route: Direction[] = [];
	for (
		let current: RouteLink | null = link;
		current;
		current = current.previous
	)
		route.push(current.direction);
	return route.reverse();
}

type QueuedPosition = {
	position: Position;
	key: string;
	estimate: number;
	distance: number;
	order: number;
	route: RouteLink;
	followsRetainedRoute: boolean;
};
const priority = (a: QueuedPosition, b: QueuedPosition) =>
	Number(b.followsRetainedRoute) - Number(a.followsRetainedRoute) ||
	a.estimate - b.estimate ||
	a.distance - b.distance ||
	a.order - b.order;

class PositionHeap {
	private items: QueuedPosition[] = [];
	get length() {
		return this.items.length;
	}
	push(item: QueuedPosition) {
		let index = this.items.length;
		this.items.push(item);
		while (index > 0) {
			const parent = (index - 1) >> 1;
			if (priority(this.items[parent], item) <= 0) break;
			this.items[index] = this.items[parent];
			index = parent;
		}
		this.items[index] = item;
	}
	pop(): QueuedPosition {
		const first = this.items[0];
		const last = this.items.pop()!;
		if (this.items.length) {
			let index = 0;
			while (index * 2 + 1 < this.items.length) {
				let child = index * 2 + 1;
				if (
					child + 1 < this.items.length &&
					priority(this.items[child + 1], this.items[child]) < 0
				)
					child++;
				if (priority(last, this.items[child]) <= 0) break;
				this.items[index] = this.items[child];
				index = child;
			}
			this.items[index] = last;
		}
		return first;
	}
}

function appleSearch(
	input: LegalSpaceInput,
	first: Position,
	limits: GrowthAnalysisLimits,
	options: GrowthSearchOptions,
): GrowthMoveFacts["apple"] {
	const empty = {
		moves: null,
		nextLegalMoveCount: null,
		canReachTail: null,
		postApple: null,
	};
	if (!input.apple)
		return {
			status: "no_apple",
			...empty,
			exploredNodes: 0,
			termination: "not_applicable",
			postAppleNodes: 0,
			rejectedTrapArrivals: 0,
		};
	const queue = new PositionHeap();
	const visited = new Map<string, number>();
	let queuedNodes = 0,
		exploredNodes = 0,
		rejectedTrapArrivals = 0;
	const postBudget: SearchBudget = { used: 0, max: limits.maxNodesPerSearch };
	let unknown: Pick<
		GrowthMoveFacts["apple"],
		"moves" | "nextLegalMoveCount" | "canReachTail" | "postApple"
	> | null = null;
	let depthLimited = false,
		nodeLimited = false,
		postLimited = false;
	const retainedRoute = options.retainedRoutes?.[first.direction];
	function enqueue(
		position: Position,
		key: string,
		route: RouteLink,
		followsRetainedRoute: boolean,
	) {
		const head = position.snake[0];
		const distance =
			Math.abs(head.x - input.apple!.x) + Math.abs(head.y - input.apple!.y);
		queue.push({
			position,
			key,
			distance,
			estimate: position.depth + 16 * distance,
			order: queuedNodes++,
			route,
			followsRetainedRoute,
		});
		visited.set(key, position.depth);
	}
	enqueue(
		first,
		positionKey(first),
		{ direction: first.direction, previous: null },
		retainedRoute?.[0] === first.direction,
	);
	while (queue.length) {
		const { position, key, route, followsRetainedRoute } = queue.pop();
		if (visited.get(key) !== position.depth) continue;
		exploredNodes++;
		if (wins(input, position)) {
			options.onRouteFound?.(first.direction, routeDirections(route));
			return {
				status: "route_wins",
				...empty,
				moves: position.depth,
				exploredNodes,
				termination: "found",
				postAppleNodes: postBudget.used,
				rejectedTrapArrivals,
			};
		}
		const next = legalNext(input, position);
		if (position.ateApple) {
			const postApple = postAppleCheck(input, position, limits, postBudget);
			if (postApple.status === "proven_trap") rejectedTrapArrivals++;
			else {
				const arrival = {
					moves: position.depth,
					nextLegalMoveCount: next.length,
					canReachTail: staticTailConnection(input, position.snake),
					postApple,
				};
				if (postApple.status === "optimistic_horizon_reached") {
					options.onRouteFound?.(first.direction, routeDirections(route));
					return {
						status: "route_with_optimistic_continuation",
						...arrival,
						exploredNodes,
						termination: "found",
						postAppleNodes: postBudget.used,
						rejectedTrapArrivals,
					};
				}
				if (
					!unknown ||
					(unknown.postApple!.status === "node_limit" &&
						postApple.status === "unknown_near_win")
				)
					unknown = arrival;
			}
			if (
				postApple.status === "node_limit" ||
				(postBudget.used === postBudget.max && queue.length > 0)
			) {
				postLimited = true;
				break;
			}
			continue;
		}
		if (position.depth === limits.appleDepth) {
			if (next.length) depthLimited = true;
			continue;
		}
		for (const direction of next) {
			const child = advance(input, position, direction)!;
			const key = positionKey(child);
			const previousDepth = visited.get(key);
			if (previousDepth !== undefined && previousDepth <= child.depth) continue;
			if (queuedNodes === limits.maxNodesPerSearch) {
				nodeLimited = true;
				continue;
			}
			enqueue(
				child,
				key,
				{ direction, previous: route },
				followsRetainedRoute && retainedRoute?.[child.depth - 1] === direction,
			);
		}
	}
	const termination = postLimited
		? "postcheck_node_limit"
		: nodeLimited
			? "node_limit"
			: depthLimited
				? "depth_limit"
				: "exhausted";
	return {
		status: unknown ? "route_postcheck_unknown" : "no_qualifying_route_found",
		...(unknown ?? empty),
		exploredNodes,
		termination,
		postAppleNodes: postBudget.used,
		rejectedTrapArrivals,
	};
}

export function analyzeGrowthSpace(
	input: LegalSpaceInput,
	limits: GrowthAnalysisLimits = defaultGrowthLimits,
	options: GrowthSearchOptions = {},
): GrowthSpaceAnalysis {
	for (const name of [
		"trapDepth",
		"appleDepth",
		"postAppleDepth",
		"maxNodesPerSearch",
	] as const) {
		const value = limits[name];
		if (!Number.isSafeInteger(value) || value < 1)
			throw new Error(
				`Invalid growth analysis limit ${name}: expected a positive safe integer`,
			);
	}
	const initial: Position = {
		snake: input.bodyHeadToTail,
		direction: input.direction,
		depth: 0,
		ateApple: false,
	};
	const dynamicFacts: GrowthSpaceAnalysis["dynamicFacts"] = {};
	for (const direction of directions) {
		const first = advance(input, initial, direction);
		if (!first) continue;
		dynamicFacts[direction] = {
			trap: optimisticSearch(input, first, limits.trapDepth, {
				used: 0,
				max: limits.maxNodesPerSearch,
			}),
			apple: appleSearch(input, first, limits, options),
		};
	}
	return { analysisLimits: { ...limits }, dynamicFacts };
}

export function describeGrowthSpaceMove(
	direction: Direction,
	staticFacts: LegalSpaceMoveFacts,
	facts: GrowthMoveFacts,
): string {
	const { trap, apple } = facts;
	const trapText = {
		proven_trap: `PROVEN_TRAP: all continuations run out of legal moves within ${trap.moves} moves, including the first move, even with no extra growth after the current apple; no earlier filling-the-board win is possible in that proof.`,
		horizon_reached: `HORIZON_REACHED: a continuation through ${trap.moves} moves exists before any apple; this is not long-term safety.`,
		optimistic_horizon_reached: `OPTIMISTIC_HORIZON_REACHED: a ${trap.moves}-move continuation exists only under the no-further-growth assumption after eating; real future food can change it.`,
		unknown_near_win:
			"UNKNOWN_NEAR_WIN: extra growth could fill the board before the optimistic continuation ends, so this is not a proved trap.",
		node_limit: "TRAP_NODE_LIMIT: unresolved, neither safe nor proved trapped.",
		board_complete: `BOARD_COMPLETE: a winning continuation was found in ${trap.moves} moves.`,
	}[trap.status];
	let appleText: string;
	if (apple.status === "route_wins")
		appleText = `CURRENT_APPLE_ROUTE_WINS: a found route in ${apple.moves} moves fills the board.`;
	else if (apple.status === "route_with_optimistic_continuation")
		appleText = `CURRENT_APPLE_ROUTE_WITH_OPTIMISTIC_CONTINUATION: a route was found in ${apple.moves} moves, then a ${apple.postApple!.moves}-move continuation after growth assuming no more growth. This is not long-term safety; actual future food is unknown. Immediate exits=${apple.nextLegalMoveCount}; static tail connection=${apple.canReachTail ? "yes" : "no"}.`;
	else if (apple.status === "route_postcheck_unknown")
		appleText = `CURRENT_APPLE_POSTCHECK_UNKNOWN: a ${apple.moves}-move arrival was found, but the post-apple check is ${apple.postApple!.status}; termination=${apple.termination}. It is not a safety certificate.`;
	else if (apple.status === "no_apple")
		appleText = "No current apple to search for.";
	else
		appleText = `CURRENT_APPLE_ROUTE_UNKNOWN: no qualifying arrival was found; termination=${apple.termination}. This does not prove useful food routes do not exist.`;
	return `${direction}: ${trapText} ${appleText} Rejected proven-trapped apple arrivals=${apple.rejectedTrapArrivals}; total post-apple checked nodes=${apple.postAppleNodes}. ${describeLegalSpaceMove(direction, staticFacts)}`;
}
