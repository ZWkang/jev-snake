import type { DecisionRequestV15 } from "./growth-space.js";
import type { Direction } from "./types.js";

export type DecisionRequestV16 = {
	model: string;
	state: Omit<
		DecisionRequestV15["state"],
		"contextVersion" | "rules" | "factsSemantics" | "dynamicSemantics" | "board"
	> & {
		contextVersion: "compact-growth-v16";
		board: Omit<DecisionRequestV15["state"]["board"], "ascii"> & {
			ascii: NonNullable<DecisionRequestV15["state"]["board"]["ascii"]>;
		};
	};
	questions: {
		direction: {
			type: "choice";
			instructions: string;
			criteria: Partial<Record<Direction, string>>;
		};
	};
};

export function compactGrowthInstructions(
	state: DecisionRequestV16["state"],
): string {
	return (
		"This is a Snake game. Eat apples to grow and fill every non-obstacle cell. Choose one offered absolute direction for the next move.\n\n" +
		`Observed tick ${state.timing.observedTick}; choose move ${state.timing.targetTick}:\n` +
		state.board.ascii.map +
		"\n\nLegend: " +
		state.board.ascii.legend +
		"\n\nCoordinates: up=y-1, right=x+1, down=y+1, left=x-1. bodyHeadToTail is ordered. Apples grow the body and keep the tail; otherwise the tail moves. Stars do not grow the snake.\n\n" +
		"Directions are legal for one move. Prefer board_complete or route_wins. Avoid proven_trap or nextLegalMoveCount=0 when alternatives are not proved trapped. Static area/distance cannot override proof. Check postApple; exits alone are insufficient. With equally strong postApple checks, prefer fewer apple.moves over immediate space/exits or Manhattan distance. Candidate lengths are not shortest-path guarantees. Body-rearranging detours can help; retained candidates are revalidated each turn, including growth and postApple. Optimistic checks assume no later growth. horizon_reached, optimistic_horizon_reached, node_limit and unknown_near_win never guarantee safety. route_postcheck_unknown is unresolved. no_qualifying_route_found does not prove food unreachable. Route moves include this action; postApple.moves excludes eating. Prefer checked food progress over repetition; stagnation does not prove another route safe. Reassess the whole board each turn."
	);
}

/** Remove repeated explanations only; never recalculate or replace observed facts. */
export function compactGrowthRequest(
	request: DecisionRequestV15,
): DecisionRequestV16 {
	const {
		rules: _rules,
		factsSemantics: _factsSemantics,
		dynamicSemantics: _dynamicSemantics,
		...observed
	} = structuredClone(request.state);
	const ascii = observed.board.ascii;
	if (!ascii)
		throw new Error("Compact growth input requires its observed character map");
	const state: DecisionRequestV16["state"] = {
		...observed,
		contextVersion: "compact-growth-v16",
		board: { ...observed.board, ascii },
	};
	return {
		model: request.model,
		state,
		questions: {
			direction: {
				type: "choice",
				instructions: compactGrowthInstructions(state),
				criteria: Object.fromEntries(
					Object.keys(request.questions.direction.criteria).map((direction) => [
						direction,
						direction,
					]),
				),
			},
		},
	};
}
