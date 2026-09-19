import type {
	AppleWitness,
	PositiveEvidence,
	PositiveGeometry,
	ReleasePassage,
} from "../../shared/snake/positive-evidence.js";
import {
	type Direction,
	directions,
	type Point,
	type PublicState,
	vectors,
} from "../../shared/snake/types.js";
import { inspectMove } from "../game/engine.js";
import { frozenSearch } from "./geometry-search.js";

export type {
	AppleWitness,
	CycleWitness,
	PositiveEvidence,
	PositiveGeometry,
	ReleasePassage,
} from "../../shared/snake/positive-evidence.js";

const pointKey = (point: Point) => `${point.x},${point.y}`;
const positionKey = (state: PublicState) =>
	JSON.stringify([state.direction, state.snake, state.apple]);
const geometry = (state: PublicState): PositiveGeometry => ({
	snake: state.snake.map((point) => ({ ...point })),
	direction: state.direction,
	apple: state.apple ? { ...state.apple } : null,
});

// Shares the live collision/tail/growth rule. No clocks, RNG, or future food.
function advance(state: PublicState, direction: Direction): PublicState {
	const next = inspectMove(state, direction);
	if (next.immediateCollision)
		throw new Error(
			`Invalid witness move ${direction}: ${next.immediateCollision}`,
		);
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

function replay(state: PublicState, route: Direction[]) {
	let end = state;
	const releasePassages: ReleasePassage[] = [];
	const initialBody = new Map(
		state.snake.slice(1).map((point, index) => [pointKey(point), index + 1]),
	);
	for (const [index, direction] of route.entries()) {
		end = advance(end, direction);
		const originalBodyIndex = initialBody.get(pointKey(end.snake[0]));
		if (originalBodyIndex !== undefined)
			releasePassages.push({
				point: { ...end.snake[0] },
				originalBodyIndex,
				earliestReleaseStep: state.snake.length - originalBodyIndex,
				enteredAtStep: index + 1,
			});
	}
	return { end, releasePassages };
}

function appleEvidence(
	state: PublicState,
	route: Direction[],
	source: "direct" | "static_candidate" | "dynamic_search",
): PositiveEvidence {
	const checked = replay(state, route);
	if (!state.apple || checked.end.apple !== null)
		throw new Error("An apple witness must consume the observed apple");
	const witness: AppleWitness = {
		directions: [...route],
		end: geometry(checked.end),
		releasePassages: checked.releasePassages,
	};
	return {
		status: source === "direct" ? "apple_eaten_now" : "apple_route_found",
		source,
		witness,
		terminal:
			checked.end.snake.length ===
			state.config.width * state.config.height - state.obstacles.length
				? "board_complete"
				: "none",
	};
}

function staticAppleCandidate(state: PublicState): Direction[] | null {
	if (!state.apple) return null;
	const route = frozenSearch(state, {
		goal: state.apple,
		firstDirection: true,
	}).route;
	if (!route) return null;
	let position = state;
	for (const direction of route) {
		if (inspectMove(position, direction).immediateCollision) return null;
		position = advance(position, direction);
	}
	return position.apple === null ? route : null;
}

// An ordering heuristic only: ignores body occupancy because it changes with
// time. It never declares a move valid, unreachable, safe, or preferable.
function appleDistances(state: PublicState): Map<string, number> {
	if (!state.apple) return new Map();
	const blocked = new Set(state.obstacles.map(pointKey));
	const distance = new Map([[pointKey(state.apple), 0]]);
	const queue = [state.apple];
	for (let index = 0; index < queue.length; index++) {
		const point = queue[index];
		const currentDistance = distance.get(pointKey(point));
		if (currentDistance === undefined)
			throw new Error("Missing graph distance");
		for (const direction of directions) {
			const next = {
				x: point.x + vectors[direction].x,
				y: point.y + vectors[direction].y,
			};
			const key = pointKey(next);
			if (
				next.x < 0 ||
				next.x >= state.config.width ||
				next.y < 0 ||
				next.y >= state.config.height ||
				blocked.has(key) ||
				distance.has(key)
			)
				continue;
			distance.set(key, currentDistance + 1);
			queue.push(next);
		}
	}
	return distance;
}

type Frame = {
	state: PublicState;
	key: string;
	exits: Direction[];
	nextExit: number;
};

/**
 * Finds an executable witness beginning with the supplied candidate. Static
 * candidates are replayed first, then an iterative complete-state DFS searches
 * moving bodies, ordered toward the observed apple. There are no search caps.
 * Search stops on an apple endpoint or a complete on-path repeated geometry;
 * a cycle is positive existence evidence, not an apple-unreachability claim.
 * Apple endpoints stop before any unknown spawn. No witness controls the game.
 */
export function analyzePositiveEvidence(
	state: PublicState,
	candidate: Direction,
): PositiveEvidence {
	const first = inspectMove(state, candidate);
	if (first.immediateCollision)
		return { status: "initial_collision", collision: first.immediateCollision };
	if (first.eatsApple) return appleEvidence(state, [candidate], "direct");
	const after = advance(state, candidate);
	const staticRoute = staticAppleCandidate(after);
	if (staticRoute)
		return appleEvidence(
			state,
			[candidate, ...staticRoute],
			"static_candidate",
		);
	const distance = appleDistances(state);
	const frame = (position: PublicState): Frame => ({
		state: position,
		key: positionKey(position),
		exits: directions
			.filter(
				(direction) =>
					inspectMove(position, direction).immediateCollision === null,
			)
			.sort((left, right) => {
				const leftTarget = inspectMove(position, left).target;
				const rightTarget = inspectMove(position, right).target;
				return (
					(distance.get(pointKey(leftTarget)) ?? Infinity) -
					(distance.get(pointKey(rightTarget)) ?? Infinity)
				);
			}),
		nextExit: 0,
	});
	const frames = [frame(after)];
	const route: Direction[] = [candidate];
	const active = new Map([[frames[0].key, 1]]);
	const completed = new Set<string>();
	while (frames.length) {
		const current = frames[frames.length - 1];
		if (current.nextExit === current.exits.length) {
			active.delete(current.key);
			completed.add(current.key);
			frames.pop();
			route.pop();
			continue;
		}
		const direction = current.exits[current.nextExit++];
		const next = advance(current.state, direction);
		const nextRoute = [...route, direction];
		if (current.state.apple && next.apple === null)
			return appleEvidence(state, nextRoute, "dynamic_search");
		const key = positionKey(next);
		const repeatedAt = active.get(key);
		if (repeatedAt !== undefined) {
			const cycleStart = frames[repeatedAt - 1].state;
			const checked = replay(state, nextRoute);
			return {
				status: "non_growth_cycle",
				witness: {
					prefixDirections: nextRoute.slice(0, repeatedAt),
					cycleDirections: nextRoute.slice(repeatedAt),
					cycleStart: geometry(cycleStart),
					end: geometry(checked.end),
					releasePassages: checked.releasePassages,
				},
			};
		}
		if (completed.has(key)) continue;
		const candidateRoute = staticAppleCandidate(next);
		if (candidateRoute)
			return appleEvidence(
				state,
				[...nextRoute, ...candidateRoute],
				"dynamic_search",
			);
		route.push(direction);
		active.set(key, route.length);
		frames.push(frame(next));
	}
	return { status: "exhausted", searchedStates: completed.size };
}
