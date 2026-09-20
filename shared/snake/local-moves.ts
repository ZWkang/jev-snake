import type { DecisionRequestV6 } from "./board-context.js";
import type { Direction, Point } from "./types.js";

/** Facts about one adjacent cell and recorded departures, never future routes. */
export type ImmediateMoveFacts = {
	target: Point;
	legal: boolean;
	blockedBy: "none" | "reverse" | "wall" | "obstacle" | "body";
	destination:
		| "outside_board"
		| "obstacle"
		| "snake_body"
		| "vacating_tail"
		| "apple"
		| "star"
		| "empty";
	appleProgress:
		| "eats_now"
		| "closer"
		| "farther"
		| "same_distance"
		| "no_apple"
		| "not_applicable";
	departureHistory:
		| "not_taken_here"
		| "taken_without_recorded_return"
		| "returned_without_apple"
		| "not_recorded";
	description: string;
};

export type DecisionRequestV7 = {
	model: string;
	state: Omit<DecisionRequestV6["state"], "contextVersion"> & {
		contextVersion: "local-moves-v7";
		immediateMoves: Record<Direction, ImmediateMoveFacts>;
	};
	questions: {
		direction: {
			type: "choice";
			instructions: {
				question: string;
				inspect: string;
				constraint: string;
				objective: string;
				uncertainty: string;
				history: string;
			};
			criteria: Record<
				Direction,
				{ meaning: string; chooseWhen: string; excludeWhen: string }
			>;
		};
	};
};
