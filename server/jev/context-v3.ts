import {
	type ActionFact,
	type ActionSummary,
	type AppleRoute,
	type DecisionContext,
	type Direction,
	directions,
	type PairSummary,
	type Point,
	type PostEatFacts,
	type PublicState,
	type SpaceFacts,
	type StarRoute,
	type UnavailableRouteStatus,
} from "../../shared/snake/types.js";
import { inspectMove } from "../game/engine.js";
import { createDeathAnalyzer, type DeathAnalyzer } from "./branch-death.js";
import { forcedPath } from "./context.js";
import { frozenSearch } from "./geometry-search.js";
import { trappedRegion } from "./trap-geometry.js";

export type ContextTiming = Pick<
	DecisionContext,
	"elapsedGameTimeMs" | "deadlineInMs"
>;
const equal = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const complete = (s: PublicState) =>
	s.snake.length === s.config.width * s.config.height - s.obstacles.length;

// Geometry only: never advances clocks, generates rewards, or changes the source.
export function advanceGeometry(
	state: PublicState,
	direction: Direction,
): PublicState {
	const next = inspectMove(state, direction);
	if (next.immediateCollision)
		throw new Error(`Cannot simulate ${direction}: ${next.immediateCollision}`);
	return {
		...state,
		direction,
		snake: [
			next.target,
			...(next.eatsApple ? state.snake : state.snake.slice(0, -1)),
		],
		apple: next.eatsApple ? null : state.apple,
		star:
			state.star && equal(next.target, state.star.point) ? null : state.star,
	};
}

export function staticSpace(state: PublicState): SpaceFacts {
	const count = frozenSearch(state).count;
	return {
		staticReachableCells: count,
		bodyLength: state.snake.length,
		relativeToBody:
			count < state.snake.length
				? "less"
				: count === state.snake.length
					? "equal"
					: "greater",
		legalNextMoves: directions.filter(
			(d) => inspectMove(state, d).immediateCollision === null,
		).length,
		tailConnection:
			frozenSearch(state, {
				goal: state.snake[state.snake.length - 1],
				tailTerminal: true,
			}).route === null
				? "disconnected"
				: "connected",
	};
}
function postEat(state: PublicState): PostEatFacts {
	return complete(state)
		? {
				terminal: "board_complete",
				bodyLength: state.snake.length,
				staticReachableCells: null,
				relativeToBody: null,
				legalNextMoves: null,
				tailConnection: null,
			}
		: { terminal: "none", ...staticSpace(state) };
}
const unavailable = (status: UnavailableRouteStatus) => ({
	status,
	distance: null,
	verified: null,
});
function missingApple(status: UnavailableRouteStatus): AppleRoute {
	return { ...unavailable(status), postEat: null };
}
function missingStar(
	status: UnavailableRouteStatus,
	remainingMs: number | null,
): StarRoute {
	return {
		...unavailable(status),
		remainingMs,
		nominalArrivalMs: null,
		timingStatus:
			status === "unknown_after_growth" ? "unknown" : "not_applicable",
	};
}
// Exposed for fixture verification; never used as an automatic controller.
export function staticFoodPath(
	state: PublicState,
	kind: "apple" | "star",
): Direction[] | null {
	const goal = kind === "apple" ? state.apple : state.star?.point;
	if (!goal) return null;
	return frozenSearch(state, {
		goal,
		avoidApple: kind === "star",
		firstDirection: true,
	}).route;
}
function verifyPath(state: PublicState, path: Direction[]) {
	let position = state;
	for (const [i, direction] of path.entries()) {
		const collision = inspectMove(position, direction).immediateCollision;
		if (collision) return { position, failure: { step: i + 2, collision } };
		position = advanceGeometry(position, direction);
	}
	return { position, failure: null };
}
function appleRoute(
	state: PublicState,
	after: PublicState,
	ate: boolean,
): AppleRoute {
	if (ate)
		return {
			status: "eaten_now",
			distance: 1,
			verified: true,
			postEat: postEat(after),
		};
	if (!state.apple) return missingApple("absent");
	const path = staticFoodPath(after, "apple");
	if (path === null) return missingApple("no_static_path");
	const checked = verifyPath(after, path);
	if (checked.failure)
		return {
			status: "candidate_invalid",
			distance: path.length + 1,
			verified: false,
			failure: checked.failure,
			postEat: null,
		};
	return {
		status: "path_found",
		distance: path.length + 1,
		verified: true,
		postEat: postEat(checked.position),
	};
}
function starTiming(
	state: PublicState,
	distance: number,
	timing: ContextTiming | undefined,
	offset: number,
): Pick<StarRoute, "remainingMs" | "nominalArrivalMs" | "timingStatus"> {
	if (!state.star) throw new Error("Star timing requires an observed star");
	const remainingMs = Math.max(
		0,
		state.star.expiresAt - (timing?.elapsedGameTimeMs ?? state.gameTimeMs),
	);
	if (
		state.config.stepMode === "response" ||
		timing?.deadlineInMs === undefined ||
		timing.deadlineInMs === null
	)
		return { remainingMs, nominalArrivalMs: null, timingStatus: "unknown" };
	const nominalArrivalMs =
		timing.deadlineInMs + (offset + distance - 1) * state.config.tickIntervalMs;
	return {
		remainingMs,
		nominalArrivalMs,
		timingStatus:
			timing.deadlineInMs < 0
				? "deadline_passed"
				: nominalArrivalMs < remainingMs
					? "before_expiry_if_on_schedule"
					: "not_before_expiry",
	};
}
function starRoute(
	state: PublicState,
	after: PublicState,
	ate: boolean,
	timing: ContextTiming | undefined,
	offset: number,
): StarRoute {
	const remaining = state.star
		? Math.max(
				0,
				state.star.expiresAt - (timing?.elapsedGameTimeMs ?? state.gameTimeMs),
			)
		: null;
	if (ate) return missingStar("unknown_after_growth", remaining);
	if (!state.star) return missingStar("absent", null);
	if (equal(after.snake[0], state.star.point))
		return {
			status: "reached_now",
			distance: 1,
			verified: true,
			...starTiming(state, 1, timing, offset),
		};
	const path = staticFoodPath(after, "star");
	if (path === null) return missingStar("no_static_path", remaining);
	const checked = verifyPath(after, path);
	if (checked.failure)
		return {
			status: "candidate_invalid",
			distance: path.length + 1,
			verified: false,
			failure: checked.failure,
			remainingMs: remaining,
			nominalArrivalMs: null,
			timingStatus: "not_applicable",
		};
	return {
		status: "path_found",
		distance: path.length + 1,
		verified: true,
		...starTiming(state, path.length + 1, timing, offset),
	};
}
export function analyzeAction(
	state: PublicState,
	direction: Direction,
	timing?: ContextTiming,
	analysisOffset = 0,
	analyzer: DeathAnalyzer = createDeathAnalyzer(),
): ActionSummary {
	const next = inspectMove(state, direction);
	if (next.immediateCollision)
		return {
			immediateCollision: next.immediateCollision,
			danger: "immediate_collision",
			eatsApple: next.eatsApple,
			forcedPath: null,
			terminal: "none",
			space: null,
			appleRoute: missingApple("not_applicable"),
			starRoute: missingStar("not_applicable", null),
		};
	const after = advanceGeometry(state, direction);
	const terminal = complete(after);
	const path = forcedPath(state, direction);
	return {
		immediateCollision: null,
		danger: terminal
			? null
			: path.outcome === "forced_collision" ||
				  trappedRegion(after) !== null ||
				  (!next.eatsApple && analyzer.continuation(after) !== null) ||
				  (next.eatsApple && analyzer.postApple(after) !== null)
				? "proven_fatal"
				: null,
		eatsApple: next.eatsApple,
		forcedPath: path,
		terminal: terminal ? "board_complete" : "none",
		space: terminal ? null : staticSpace(after),
		appleRoute: appleRoute(state, after, next.eatsApple),
		starRoute: terminal
			? missingStar("not_applicable", null)
			: starRoute(state, after, next.eatsApple, timing, analysisOffset),
	};
}
export function analyzeActions(
	state: PublicState,
	timing?: ContextTiming,
	analysisOffset = 0,
	analyzer: DeathAnalyzer = createDeathAnalyzer(),
): Record<Direction, ActionSummary> {
	return Object.fromEntries(
		directions.map((d) => [
			d,
			analyzeAction(state, d, timing, analysisOffset, analyzer),
		]),
	) as Record<Direction, ActionSummary>;
}
export function analyzeSecondActions(
	state: PublicState,
	first: Direction,
	timing?: ContextTiming,
	analyzer: DeathAnalyzer = createDeathAnalyzer(),
): Record<Direction, PairSummary> {
	const next = inspectMove(state, first);
	if (next.immediateCollision)
		return Object.fromEntries(
			directions.map((second) => [
				second,
				{
					first,
					second,
					secondStatus: "not_executed_first_blocked",
					secondFacts: null,
				},
			]),
		) as Record<Direction, PairSummary>;
	const after = advanceGeometry(state, first);
	if (complete(after))
		return Object.fromEntries(
			directions.map((second) => [
				second,
				{
					first,
					second,
					secondStatus: "not_executed_board_complete",
					secondFacts: null,
				},
			]),
		) as Record<Direction, PairSummary>;
	if (next.eatsApple)
		return Object.fromEntries(
			directions.map((second) => [
				second,
				{
					first,
					second,
					secondStatus: "unknown_after_growth",
					secondFacts: {
						immediateCollision: inspectMove(after, second)
							.immediateCollision as ActionFact["immediateCollision"],
						reason: "new_apple_position_unknown",
					},
				},
			]),
		) as Record<Direction, PairSummary>;
	const facts = analyzeActions(after, timing, 1, analyzer);
	return Object.fromEntries(
		directions.map((second) => [
			second,
			{ first, second, secondStatus: "known", secondFacts: facts[second] },
		]),
	) as Record<Direction, PairSummary>;
}
