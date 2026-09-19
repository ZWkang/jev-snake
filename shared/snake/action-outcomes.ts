import type { ActionFact, PostEatFacts } from "./types.js";

export type SurvivalOutcome = {
	status:
		| "illegal_reverse"
		| "immediate_collision"
		| "board_complete"
		| "proven_fatal"
		| "not_proven_fatal";
	collision: ActionFact["immediateCollision"];
	// From the observation, including the candidate move and collision attempt.
	// A rejected reversal does not execute a move and has no collision bound.
	collisionWithinMoves: number | null;
	proof:
		| "forced_path"
		| "trapped_region"
		| "all_continuations"
		| "post_apple_all_continuations"
		| null;
};

export type AppleRouteOutcome = {
	status: "verified_route" | "unresolved" | "exhausted" | "not_applicable";
	// From the observation, including the candidate move and apple arrival.
	moves: number | null;
	// Applies only to this witness's exact grown endpoint. It is not a proof
	// about the endpoints of other apple routes beginning in the same direction.
	postApple: {
		status: "board_complete" | "proven_fatal" | "not_proven_fatal";
		postEat: PostEatFacts;
		// Additional moves AFTER the apple arrival, including collision attempt.
		collisionWithinMoves: number | null;
		// The same certificate measured from the original observation.
		collisionWithinMovesFromObservation: number | null;
	} | null;
};

export type ActionOutcome = {
	survival: SurvivalOutcome;
	appleRoute: AppleRouteOutcome;
	// A factual causal summary, not a recommended direction or a ranking.
	summary: string;
};
