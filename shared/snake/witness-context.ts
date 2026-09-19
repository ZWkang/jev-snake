import type {
	PositiveEvidence,
	PositiveGeometry,
	ReleasePassage,
} from "./positive-evidence.js";
import type {
	ActionSummary,
	DecisionRequestV3,
	Direction,
	PairSummary,
	PlanRequestV3,
	Point,
	PostEatFacts,
} from "./types.js";

export type WitnessOrigin = PositiveGeometry & {
	width: number;
	height: number;
	obstacles: Point[];
	rulesVersion: number;
	tick: number;
};
export type WitnessRecord = {
	basis: "observed" | "conditional_second";
	origin: WitnessOrigin;
	evidence: Extract<PositiveEvidence, { witness: unknown }>;
};
export type WitnessArchive = {
	version: "positive-v1";
	observedTick: number;
	records: Record<string, WitnessRecord>;
};
export type OpportunitySummary = {
	status: PositiveEvidence["status"];
	witnessId: string | null;
	moves: number | null;
	appleTarget: Point | null;
	endEvent: "apple_eaten" | "board_complete" | "cycle_completed" | "none";
	cycle: { prefixMoves: number; period: number } | null;
	releasePassages: ReleasePassage[];
	scope: "observed_apple_only" | "no_growth_cycle" | "none";
	// Computed from this witness's growth endpoint, not another static route.
	postEat?: PostEatFacts | null; // Older stored v4 bodies predate this field.
};
export type WitnessContinuity = {
	witnessId: string;
	originTick: number;
	// Different executed routes may converge here: this asserts equal geometry
	// after N moves, never that the actual actions followed the witness prefix.
	stateCompatibleAfterMoves: number;
	remainingMoves: number;
	nextDirection: Direction;
	opportunityStatus: WitnessRecord["evidence"]["status"];
	appleTarget: Point | null;
	scope: "observed_apple_only" | "no_growth_cycle";
	endEvent: "apple_eaten" | "board_complete" | "cycle_completed";
};
export type StoredWitnessContinuity =
	| WitnessContinuity
	| {
			witnessId: string;
			originTick: number;
			matchedMoves: number;
			remainingMoves: number;
			nextDirection: Direction;
	  };
export type ActionSummaryV4 = ActionSummary & {
	opportunity: OpportunitySummary;
};
export type PairSummaryV4 =
	| Exclude<PairSummary, { secondStatus: "known" }>
	| {
			first: Direction;
			second: Direction;
			secondStatus: "known";
			secondFacts: ActionSummaryV4;
	  };
export type DecisionRequestV4 = Omit<
	DecisionRequestV3,
	"state" | "questions"
> & {
	state: Omit<DecisionRequestV3["state"], "contextVersion"> & {
		contextVersion: "action-facts-v4";
		witnessContinuity: StoredWitnessContinuity[];
	};
	questions: {
		direction: Omit<DecisionRequestV3["questions"]["direction"], "criteria"> & {
			criteria: Record<Direction, ActionSummaryV4 & { meaning: string }>;
		};
	};
};
export type PlanRequestV4 = Omit<PlanRequestV3, "state" | "questions"> & {
	state: Omit<PlanRequestV3["state"], "contextVersion" | "firstActions"> & {
		contextVersion: "two-step-plan-v4";
		firstActions: Record<Direction, ActionSummaryV4>;
		witnessContinuity: StoredWitnessContinuity[];
	};
	questions: {
		plan: Omit<PlanRequestV3["questions"]["plan"], "criteria"> & {
			criteria: Record<string, PairSummaryV4>;
		};
	};
};
