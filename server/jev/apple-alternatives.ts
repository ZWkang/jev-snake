import type { PositiveEvidence } from "../../shared/snake/positive-evidence.js";
import {
	type Direction,
	directions,
	type PublicState,
} from "../../shared/snake/types.js";
import { inspectMove } from "../game/engine.js";
import { createDeathAnalyzer, type DeathAnalyzer } from "./branch-death.js";
import { advanceGeometry } from "./context-v3.js";
import { appleEvidence } from "./positive-evidence.js";

export type AppleAlternatives = {
	evidence: Extract<
		PositiveEvidence,
		{ status: "apple_eaten_now" | "apple_route_found" }
	> | null;
	// Expanded non-growing geometries and inspected proven-fatal growth leaves.
	expandedStates: number;
	fatalAppleEndpoints: number;
};

type SearchNode = {
	state: PublicState;
	parent: number;
	direction: Direction;
};
const positionKey = (state: PublicState) =>
	JSON.stringify([state.direction, state.snake]);
const complete = (state: PublicState) =>
	state.snake.length ===
	state.config.width * state.config.height - state.obstacles.length;

// Search is conditional on this one candidate, not a ranking of candidates.
// Unlike the first-witness search, a fatal apple arrival or an on-path cycle
// does not terminate the entire search. Equal complete non-growing geometries
// share their future possibilities, so a visited set merges them. A successful
// endpoint is either a win or NOT PROVEN fatal; it is not a safety guarantee.
// No path goes beyond the observed apple, and no future spawn/RNG is inspected.
export function analyzeAppleAlternatives(
	state: PublicState,
	candidate: Direction,
	analyzer: DeathAnalyzer = createDeathAnalyzer(),
): AppleAlternatives {
	const first = inspectMove(state, candidate);
	if (first.immediateCollision)
		return { evidence: null, expandedStates: 0, fatalAppleEndpoints: 0 };
	const after = advanceGeometry(state, candidate);
	if (first.eatsApple) {
		const fatal = !complete(after) && analyzer.postApple(after) !== null;
		return {
			evidence: fatal ? null : appleEvidence(state, [candidate], "direct"),
			expandedStates: 0,
			fatalAppleEndpoints: fatal ? 1 : 0,
		};
	}
	const nodes: SearchNode[] = [
		{ state: after, parent: -1, direction: candidate },
	];
	// The observation is deliberately not pre-marked: a route that starts with
	// this candidate can return there and then depart in a different direction.
	const visited = new Set([positionKey(after)]);
	let expandedStates = 0;
	let fatalAppleEndpoints = 0;
	for (let index = 0; index < nodes.length; index++) {
		const current = nodes[index];
		expandedStates++;
		for (const direction of directions) {
			const next = inspectMove(current.state, direction);
			if (next.immediateCollision) continue;
			const nextState = advanceGeometry(current.state, direction);
			if (next.eatsApple) {
				if (!complete(nextState) && analyzer.postApple(nextState) !== null) {
					fatalAppleEndpoints++;
					continue;
				}
				const route: Direction[] = [direction];
				for (let cursor = index; cursor !== -1; cursor = nodes[cursor].parent)
					route.push(nodes[cursor].direction);
				return {
					evidence: appleEvidence(state, route.reverse(), "dynamic_search"),
					expandedStates,
					fatalAppleEndpoints,
				};
			}
			const key = positionKey(nextState);
			if (visited.has(key)) continue;
			visited.add(key);
			nodes.push({ state: nextState, parent: index, direction });
		}
	}
	return { evidence: null, expandedStates, fatalAppleEndpoints };
}
