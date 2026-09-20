import type {
	DynamicAnalysisLimits,
	DynamicMoveFacts,
	DynamicSpaceAnalysis,
} from "./dynamic-space.js";
import {
	describeLegalSpaceMove,
	legalSpaceSemantics,
} from "./legal-space-analysis.js";
import type { LegalSpaceInput, LegalSpaceMoveFacts } from "./legal-space.js";
import { inspectMove, type MoveGeometry } from "./move-rules.js";
import { directions, vectors, type Direction, type Point } from "./types.js";

export const defaultDynamicLimits: Readonly<DynamicAnalysisLimits> =
	Object.freeze({
		trapDepth: 8,
		appleDepth: 32,
		maxNodesPerSearch: 2048,
	});

export const dynamicStaticSemantics = legalSpaceSemantics
	.replace(
		"BOARD_COMPLETE is an immediate win, so tail reachability and next moves are not applicable.",
		"Within moveFacts only, terminal=board_complete means this first move wins immediately, so its tail reachability and next moves are not applicable; a separate dynamic winning continuation may require more moves.",
	)
	.replace(
		"No multi-step routes or future food locations are computed.",
		"These moveFacts are one-move static measurements; separate bounded dynamic facts are in dynamicFacts. Future food locations are not computed.",
	);

export const dynamicSpaceSemantics =
	"Each legal first direction is analyzed independently with the same explicit depth and node limits; no direction is removed or selected by these searches. Every moves count includes that first direction as move 1. Searches update the complete ordered snake body and its vacating tail, including growth when eating the currently observed apple. No future apple or random number is sampled. Trap status proven_trap requires every continuation to end with no legal move within trapDepth; its moves is the longest legal continuation. horizon_reached is only one continuation through trapDepth, not long-term safety. unknown_after_apple stops at the first apple when at least one immediate exit remains; future food is unknown. board_complete reports a found winning continuation in moves steps; only moves=1 wins on the current action. node_limit is unresolved, never safe or proven dead, and has null moves. Trap exploredNodes counts inspected resulting positions, including the first-move position. Apple search is bounded best-first for each first direction, ordered by moves so far + 16 times Manhattan distance, with smaller Manhattan distance breaking ties. It stops a branch at the current apple. A found route is not claimed to be shortest or optimal. It accepts only an apple arrival that wins or still has a legal next move after growth, and continues other branches when an arrival has no exit. route_with_exit reports a found route length and the arrival's immediate exits and static tail connection, not a safe future route. route_wins reports an immediate board-completion arrival. No path is supplied. no_route_with_exit_found means no qualifying route was found within this search; exhausted, depth_limit and node_limit describe why it stopped and do not establish that no route exists. Apple exploredNodes counts expanded positions, skipping stale entries superseded by a shorter arrival; the cumulative queued positions and visited set are also bounded by maxNodesPerSearch, so the frontier cannot grow beyond the limit. Each search has its own budget; budgets are not shared between options. Tail connection is static adjacency through currently free cells, not proof of moving-body safety.";

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
		ateApple: fact.eatsApple,
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

function trapSearch(
	input: LegalSpaceInput,
	first: Position,
	limits: DynamicAnalysisLimits,
): DynamicMoveFacts["trap"] {
	let exploredNodes = 0;
	type Result = Omit<DynamicMoveFacts["trap"], "exploredNodes">;
	function visit(position: Position): Result {
		if (exploredNodes === limits.maxNodesPerSearch)
			return { status: "node_limit", moves: null };
		exploredNodes++;
		if (wins(input, position))
			return { status: "board_complete", moves: position.depth };
		const next = legalNext(input, position);
		if (next.length === 0)
			return { status: "proven_trap", moves: position.depth };
		if (position.ateApple)
			return { status: "unknown_after_apple", moves: position.depth };
		if (position.depth === limits.trapDepth)
			return { status: "horizon_reached", moves: position.depth };
		let longest = position.depth;
		for (const direction of next) {
			const result = visit(advance(input, position, direction)!);
			// One unresolved or continuing branch prevents an exhaustive death proof.
			if (result.status !== "proven_trap") return result;
			longest = Math.max(longest, result.moves!);
		}
		return { status: "proven_trap", moves: longest };
	}
	const result = visit(first);
	return { ...result, exploredNodes };
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
	return `${position.direction}:${position.snake.map((point) => `${point.x},${point.y}`).join(";")}`;
}

type QueuedPosition = {
	position: Position;
	key: string;
	estimate: number;
	distance: number;
	order: number;
};
const priority = (a: QueuedPosition, b: QueuedPosition) =>
	a.estimate - b.estimate || a.distance - b.distance || a.order - b.order;

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
	limits: DynamicAnalysisLimits,
): DynamicMoveFacts["apple"] {
	const empty = { moves: null, nextLegalMoveCount: null, canReachTail: null };
	if (!input.apple)
		return {
			status: "no_apple",
			...empty,
			exploredNodes: 0,
			termination: "not_applicable",
		};
	// Only lightweight geometry is retained. Total enqueues, not just expansions,
	// are capped, so an exponential frontier cannot accumulate behind the budget.
	const queue = new PositionHeap();
	const visited = new Map<string, number>();
	let queuedNodes = 0;
	function enqueue(position: Position, key: string) {
		const head = position.snake[0];
		const distance =
			Math.abs(head.x - input.apple!.x) + Math.abs(head.y - input.apple!.y);
		queue.push({
			position,
			key,
			distance,
			estimate: position.depth + 16 * distance,
			order: queuedNodes++,
		});
		visited.set(key, position.depth);
	}
	enqueue(first, positionKey(first));
	let exploredNodes = 0;
	let depthLimited = false;
	let nodeLimited = false;
	while (queue.length) {
		const { position, key } = queue.pop();
		if (visited.get(key) !== position.depth) continue;
		exploredNodes++;
		if (wins(input, position))
			return {
				status: "route_wins",
				moves: position.depth,
				nextLegalMoveCount: null,
				canReachTail: null,
				exploredNodes,
				termination: "found",
			};
		const next = legalNext(input, position);
		if (position.ateApple) {
			if (next.length)
				return {
					status: "route_with_exit",
					moves: position.depth,
					nextLegalMoveCount: next.length,
					canReachTail: staticTailConnection(input, position.snake),
					exploredNodes,
					termination: "found",
				};
			// A bad arrival does not invalidate all other ways to reach this apple.
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
			enqueue(child, key);
		}
	}
	return {
		status: "no_route_with_exit_found",
		...empty,
		exploredNodes,
		termination: nodeLimited
			? "node_limit"
			: depthLimited
				? "depth_limit"
				: "exhausted",
	};
}

export function analyzeDynamicSpace(
	input: LegalSpaceInput,
	limits: DynamicAnalysisLimits = defaultDynamicLimits,
): DynamicSpaceAnalysis {
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < 1)
			throw new Error(
				`Invalid dynamic analysis limit ${name}: expected a positive safe integer`,
			);
	}
	const initial: Position = {
		snake: input.bodyHeadToTail,
		direction: input.direction,
		depth: 0,
		ateApple: false,
	};
	const dynamicFacts: DynamicSpaceAnalysis["dynamicFacts"] = {};
	for (const direction of directions) {
		const first = advance(input, initial, direction);
		if (!first) continue;
		dynamicFacts[direction] = {
			trap: trapSearch(input, first, limits),
			apple: appleSearch(input, first, limits),
		};
	}
	return { analysisLimits: { ...limits }, dynamicFacts };
}

export function describeDynamicSpaceMove(
	direction: Direction,
	staticFacts: LegalSpaceMoveFacts,
	dynamicFacts: DynamicMoveFacts,
): string {
	const { trap, apple } = dynamicFacts;
	const trapText = {
		proven_trap: `PROVEN_TRAP: every continuation runs out of legal moves within ${trap.moves} moves, including this first move.`,
		horizon_reached: `HORIZON_REACHED: a continuation through ${trap.moves} moves exists; this is not long-term safety.`,
		unknown_after_apple: `UNKNOWN_AFTER_APPLE: the current apple can be reached after ${trap.moves} moves, then future food is unknown.`,
		node_limit:
			"TRAP_NODE_LIMIT: unresolved within the node budget; neither safe nor proven dead.",
		board_complete: `BOARD_COMPLETE: a continuation wins after ${trap.moves} moves.`,
	}[trap.status];
	const appleText =
		apple.status === "route_with_exit"
			? `CURRENT_APPLE_ROUTE_WITH_EXIT: a route was found in ${apple.moves} moves under this first direction; after growth, ${apple.nextLegalMoveCount} legal next moves remain and static tail connection is ${apple.canReachTail ? "yes" : "no"}. This is not long-term safety.`
			: apple.status === "route_wins"
				? `CURRENT_APPLE_ROUTE_WINS: a route in ${apple.moves} moves fills the board.`
				: apple.status === "no_apple"
					? "No current apple to search for."
					: `CURRENT_APPLE_ROUTE_UNKNOWN: no route with an immediate exit after eating was found; termination=${apple.termination}. This does not establish that no such route exists.`;
	return `${direction}: ${trapText} ${appleText} ${describeLegalSpaceMove(direction, staticFacts)}`;
}
