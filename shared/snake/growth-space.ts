import type {
	DecisionRequestV14,
	DynamicAnalysisLimits,
} from "./dynamic-space.js";
import type { Direction } from "./types.js";

export type GrowthAnalysisLimits = DynamicAnalysisLimits & {
	postAppleDepth: number;
};

export type GrowthTrapFacts = {
	status:
		| "proven_trap"
		| "horizon_reached"
		| "optimistic_horizon_reached"
		| "unknown_near_win"
		| "node_limit"
		| "board_complete";
	moves: number | null;
	exploredNodes: number;
};

export type PostAppleCheck = {
	status:
		| "proven_trap"
		| "optimistic_horizon_reached"
		| "unknown_near_win"
		| "node_limit";
	/** Subsequent moves after eating; excludes the apple move itself. */
	moves: number | null;
	exploredNodes: number;
};

export type GrowthMoveFacts = {
	trap: GrowthTrapFacts;
	apple: {
		status:
			| "route_with_optimistic_continuation"
			| "route_postcheck_unknown"
			| "route_wins"
			| "no_qualifying_route_found"
			| "no_apple";
		moves: number | null;
		nextLegalMoveCount: number | null;
		canReachTail: boolean | null;
		exploredNodes: number;
		termination:
			| "found"
			| "exhausted"
			| "depth_limit"
			| "node_limit"
			| "postcheck_node_limit"
			| "not_applicable";
		postApple: PostAppleCheck | null;
		/** Shared across every apple-arrival check for this first direction. */
		postAppleNodes: number;
		rejectedTrapArrivals: number;
	};
};

export type GrowthSpaceAnalysis = {
	analysisLimits: GrowthAnalysisLimits;
	dynamicFacts: Partial<Record<Direction, GrowthMoveFacts>>;
};

export type DecisionRequestV15 = {
	model: string;
	state: Omit<
		DecisionRequestV14["state"],
		"contextVersion" | "analysisLimits" | "dynamicFacts" | "dynamicSemantics"
	> &
		GrowthSpaceAnalysis & {
			contextVersion: "growth-space-v15";
			dynamicSemantics: string;
		};
	questions: DecisionRequestV14["questions"];
};
