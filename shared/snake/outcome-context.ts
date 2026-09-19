import type { ActionOutcome } from "./action-outcomes.js";
import type { ReleasePassage } from "./positive-evidence.js";
import type {
	DecisionRequestV3,
	Direction,
	SpaceFacts,
	StarRoute,
} from "./types.js";

export type ActionAssessment = ActionOutcome & {
	meaning: string;
	space: SpaceFacts | null;
	starRoute: StarRoute;
	noGrowthCycle: { prefixMoves: number; period: number } | null;
	bodyReleasePassages: Omit<ReleasePassage, "originalBodyIndex">[];
	// Absent in earlier saved v5 requests. This is search provenance, not a rank.
	appleAlternativeSearch?: {
		status: "endpoint_found" | "exhausted";
		initialRouteMoves: number;
		expandedStates: number;
		fatalAppleEndpoints: number;
	};
};
export type DecisionRequestV5 = {
	model: string;
	state: Omit<DecisionRequestV3["state"], "contextVersion"> & {
		contextVersion: "action-outcomes-v5";
	};
	questions: {
		direction: {
			type: "choice";
			instructions: string;
			criteria: Record<Direction, ActionAssessment>;
		};
	};
};
