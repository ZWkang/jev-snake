import type { DecisionRequestV13, LegalSpaceMoveFacts } from "./legal-space.js";
import type { Direction } from "./types.js";

export type DynamicAnalysisLimits = {
	trapDepth: number;
	appleDepth: number;
	maxNodesPerSearch: number;
};

export type DynamicMoveFacts = {
	trap: {
		status:
			| "proven_trap"
			| "horizon_reached"
			| "unknown_after_apple"
			| "node_limit"
			| "board_complete";
		moves: number | null;
		exploredNodes: number;
	};
	apple: {
		status:
			| "route_with_exit"
			| "route_wins"
			| "no_route_with_exit_found"
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
			| "not_applicable";
	};
};

export type DynamicSpaceAnalysis = {
	analysisLimits: DynamicAnalysisLimits;
	dynamicFacts: Partial<Record<Direction, DynamicMoveFacts>>;
};

export type DecisionRequestV14 = {
	model: string;
	state: Omit<DecisionRequestV13["state"], "contextVersion"> &
		DynamicSpaceAnalysis & {
			contextVersion: "dynamic-space-v14";
			dynamicSemantics: string;
		};
	questions: DecisionRequestV13["questions"];
};

export type DynamicMoveDescription = (
	direction: Direction,
	staticFacts: LegalSpaceMoveFacts,
	dynamicFacts: DynamicMoveFacts,
) => string;
