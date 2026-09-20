import type { DecisionRequestV6 } from "./board-context.js";
import type { DecisionRequestV9 } from "./bounded-search.js";
import type { DecisionRequestV16 } from "./compact-growth.js";
import type { DecisionRequestV14 } from "./dynamic-space.js";
import type { DecisionRequestV8 } from "./global-view.js";
import type { DecisionRequestV15 } from "./growth-space.js";
import type { DecisionRequestV13 } from "./legal-space.js";
import type { DecisionRequestV7 } from "./local-moves.js";
import type { DecisionRequestV11 } from "./model-planning.js";
import type { DecisionRequestV12 } from "./non-reverse.js";
import type { DecisionRequestV5 } from "./outcome-context.js";
import type { DecisionRequestV10 } from "./post-apple-search.js";
import type {
	DecisionRequestV4,
	PlanRequestV4,
	WitnessArchive,
} from "./witness-context.js";
export type { DecisionRequestV6 } from "./board-context.js";
export type { DecisionRequestV9 } from "./bounded-search.js";
export type { DecisionRequestV10 } from "./post-apple-search.js";
export type {
	DecisionRequestV8,
	ImmediateMoveObservation,
} from "./global-view.js";
export type { DecisionRequestV7, ImmediateMoveFacts } from "./local-moves.js";
export type { DecisionRequestV13 } from "./legal-space.js";
export type { DecisionRequestV14 } from "./dynamic-space.js";
export type { DecisionRequestV15 } from "./growth-space.js";
export type { DecisionRequestV16 } from "./compact-growth.js";
export type { DecisionRequestV11 } from "./model-planning.js";
export type { DecisionRequestV12 } from "./non-reverse.js";
export type { DecisionRequestV5 } from "./outcome-context.js";
export type { DecisionRequestV4, PlanRequestV4 } from "./witness-context.js";
export const directions = ["up", "right", "down", "left"] as const;
export type Direction = (typeof directions)[number];
export const stepModes = ["fixed", "response"] as const;
export type StepMode = (typeof stepModes)[number];
export const decisionModes = ["single_step", "two_step_fallback"] as const;
export type DecisionMode = (typeof decisionModes)[number];
export type PlanChoice = `${Direction}_${Direction}`;
export const planChoices: PlanChoice[] = directions.flatMap((first) =>
	directions.map((second) => `${first}_${second}` as PlanChoice),
);
export function planDirections(choice: PlanChoice): [Direction, Direction] {
	return choice.split("_") as [Direction, Direction];
}
export type Status = "ready" | "running" | "gameover" | "won" | "interrupted";
export type Point = { x: number; y: number };
export type ForcedPath = {
	outcome:
		| "forced_collision"
		| "branch"
		| "cycle"
		| "unknown_after_apple"
		| "board_complete";
	// Moves from the observation to this outcome, including a fatal move.
	steps: number;
};
export type ActionFact = {
	target: Point;
	immediateCollision: "reverse" | "wall" | "obstacle" | "body" | null;
	appleDistance: number | null;
	eatsApple: boolean;
	// Absent in historical v1 contexts; null when the first move is blocked.
	forcedPath?: ForcedPath | null;
};
// Retired providers remain valid in saved decisions and historical replays.
export type JevProvider = "typesafe" | "openrouter" | "laya";
export function isJevModel(model: string | null | undefined) {
	return (
		!!model && (model.startsWith("jev-") || model.startsWith("typesafe/jev-"))
	);
}
export type LegacyDecisionRequest = {
	model: string;
	state: {
		contextVersion?: "action-facts-v1" | "action-facts-v2";
		actionFacts?: Record<Direction, ActionFact>;
		rules: { objective: string; applePoints: number; starPoints: number };
		board: { width: number; height: number; obstacles: Point[] };
		player: {
			head: Point;
			bodyHeadToTail: Point[];
			direction: Direction;
			score: number;
		};
		food: {
			apple: Point | null;
			star: { point: Point; expiresAt: number } | null;
		};
		timing: (
			| {
					stateIsProjected: false;
					observedTick: number;
					targetTick: number;
					stepMode?: StepMode;
					deadlineInMs?: number | null;
			  }
			| {
					stateIsProjected: true;
					projectedBeforeTick: number;
			  }
		) & {
			gameTimeMs: number;
			tickIntervalMs: number | null;
		};
	};
	questions: {
		direction: {
			type: "choice";
			instructions: string;
			criteria: Record<Direction, string | (ActionFact & { meaning: string })>;
		};
	};
};
export type LegacyPlanRequest = Omit<
	LegacyDecisionRequest,
	"state" | "questions"
> & {
	state: Omit<LegacyDecisionRequest["state"], "contextVersion" | "timing"> & {
		contextVersion: "two-step-plan-v1" | "two-step-plan-v2";
		planningHorizon: 2;
		targetTicks: [number, number];
		timing: {
			stateIsProjected: false;
			observedTick: number;
			targetTick: number;
			gameTimeMs: number;
			tickIntervalMs: number;
			stepMode?: "fixed";
			deadlineInMs?: number;
		};
	};
	questions: {
		plan: {
			type: "choice";
			instructions: string;
			criteria: Record<PlanChoice, string>;
		};
	};
};
export type SpaceFacts = {
	staticReachableCells: number;
	bodyLength: number;
	relativeToBody: "less" | "equal" | "greater";
	legalNextMoves: number;
	tailConnection: "connected" | "disconnected";
};
export type PostEatFacts =
	| ({ terminal: "none" } & SpaceFacts)
	| {
			terminal: "board_complete";
			bodyLength: number;
			staticReachableCells: null;
			relativeToBody: null;
			legalNextMoves: null;
			tailConnection: null;
	  };
export type UnavailableRouteStatus =
	| "absent"
	| "no_static_path"
	| "not_applicable"
	| "unknown_after_growth";
export type RouteEvidence<Reached extends string> =
	| { status: UnavailableRouteStatus; distance: null; verified: null }
	| { status: "path_found" | Reached; distance: number; verified: true }
	| {
			status: "candidate_invalid";
			distance: number;
			verified: false;
			failure: {
				step: number;
				collision: NonNullable<ActionFact["immediateCollision"]>;
			};
	  };
export type AppleRoute =
	| (Extract<RouteEvidence<"eaten_now">, { verified: true }> & {
			postEat: PostEatFacts;
	  })
	| (Exclude<RouteEvidence<"eaten_now">, { verified: true }> & {
			postEat: null;
	  });
export type StarRoute = RouteEvidence<"reached_now"> & {
	remainingMs: number | null;
	nominalArrivalMs: number | null;
	timingStatus:
		| "unknown"
		| "not_applicable"
		| "deadline_passed"
		| "before_expiry_if_on_schedule"
		| "not_before_expiry";
};
export type ActionSummary = {
	immediateCollision: ActionFact["immediateCollision"];
	// Absent in historical v3 requests. Null means no proven danger, not safe.
	danger?: "immediate_collision" | "proven_fatal" | null;
	eatsApple: boolean;
	forcedPath: ForcedPath | null;
	terminal: "none" | "board_complete";
	space: SpaceFacts | null;
	appleRoute: AppleRoute;
	starRoute: StarRoute;
};
export type PairSummary = { first: Direction; second: Direction } & (
	| { secondStatus: "known"; secondFacts: ActionSummary }
	| {
			secondStatus:
				| "not_executed_first_blocked"
				| "not_executed_board_complete";
			secondFacts: null;
	  }
	| {
			secondStatus: "unknown_after_growth";
			secondFacts: {
				immediateCollision: ActionFact["immediateCollision"];
				reason: "new_apple_position_unknown";
			};
	  }
);
type ObservedDecisionTiming = {
	stateIsProjected: false;
	observedTick: number;
	targetTick: number;
	gameTimeMs: number;
};
export type FixedDecisionTiming = ObservedDecisionTiming & {
	stepMode: "fixed";
	deadlineInMs?: number;
	tickIntervalMs: number;
};
export type ActualDecisionTiming =
	| FixedDecisionTiming
	| (ObservedDecisionTiming & {
			stepMode: "response";
			deadlineInMs?: null;
			tickIntervalMs: null;
	  });
export type DecisionProgress = {
	historyVersion: "progress-v1";
	historyStartTick: number;
	throughTick: number;
	lastAppleTick: number;
	movesSinceApple: number;
	positionVisits: number;
	previousVisitTick: number | null;
	repeatAfterMoves: number | null;
	actions: Record<
		Direction,
		{
			timesTaken: number;
			returnsWithoutApple: number;
			lastTakenTick: number | null;
		}
	>;
};
export type DecisionRequestV3 = {
	model: string;
	state: {
		contextVersion: "action-facts-v3";
		rules: LegacyDecisionRequest["state"]["rules"] & { factsSemantics: string };
		board: { width: number; height: number; obstacleCount: number };
		player: {
			head: Point;
			direction: Direction;
			length: number;
			score: number;
		};
		food: LegacyDecisionRequest["state"]["food"];
		timing: ActualDecisionTiming;
		// Historical v3 requests may predate recorded progress evidence.
		progress?: DecisionProgress;
	};
	questions: {
		direction: {
			type: "choice";
			instructions: string;
			criteria: Record<Direction, ActionSummary & { meaning: string }>;
		};
	};
};
export type PlanRequestV3 = {
	model: string;
	state: Omit<DecisionRequestV3["state"], "contextVersion" | "timing"> & {
		contextVersion: "two-step-plan-v3";
		planningHorizon: 2;
		targetTicks: [number, number];
		timing: FixedDecisionTiming;
		firstActions: Record<Direction, ActionSummary>;
	};
	questions: {
		plan: {
			type: "choice";
			instructions: string;
			criteria: Record<PlanChoice, PairSummary>;
		};
	};
};
export type DecisionRequest =
	| LegacyDecisionRequest
	| DecisionRequestV3
	| DecisionRequestV4
	| DecisionRequestV5
	| DecisionRequestV6
	| DecisionRequestV7
	| DecisionRequestV8
	| DecisionRequestV9
	| DecisionRequestV10
	| DecisionRequestV11
	| DecisionRequestV12
	| DecisionRequestV13
	| DecisionRequestV14
	| DecisionRequestV15
	| DecisionRequestV16;
export type PlanRequest = LegacyPlanRequest | PlanRequestV3 | PlanRequestV4;
type BoardConfig = {
	// Missing means the original fixed-spawn generator, including its RNG order.
	layoutVersion?: 2 | 3;
	width: number;
	height: number;
	obstacleCount: number;
	seed: string;
};
export type FixedGameConfig = BoardConfig & {
	stepMode?: "fixed";
	decisionMode?: DecisionMode;
	tickIntervalMs: number;
};
export type ResponseGameConfig = BoardConfig & {
	stepMode: "response";
	decisionMode?: "single_step";
	tickIntervalMs: null;
};
export type GameConfig = FixedGameConfig | ResponseGameConfig;
export function isResponseMode(
	config: GameConfig,
): config is ResponseGameConfig {
	return config.stepMode === "response";
}
export type Decision = {
	kind?: "single";
	provider?: JevProvider;
	model: string;
	choice: Direction;
	probabilities: Partial<Record<Direction, number>>;
	confidence: number;
	requestMs: number;
	inferenceMs?: number;
	contextBuildMs?: number;
	requestBytes?: number;
	inputTokens?: number;
	// Full counterfactual witnesses are archived, never sent as model decisions.
	evidence?: WitnessArchive;
	request?: DecisionRequest;
};
export type PlanDecision = Omit<
	Decision,
	"kind" | "choice" | "probabilities" | "request"
> & {
	kind: "plan";
	choice: PlanChoice;
	probabilities: Record<PlanChoice, number>;
	request: PlanRequest;
};
export type ModelDecision = Decision | PlanDecision;
export type PlanStep = {
	targetTick: number;
	direction: Direction;
	status:
		| "queued"
		| "standby"
		| "applied"
		| "superseded"
		| "cancelled"
		| "expired"
		| "rejected";
	seq: number;
	reason?: string;
	replacementRequestId?: string;
};
export type PlanIntent = {
	requestId: string;
	observedSeq: number;
	observedTick: number;
	targetTick: number;
	expectedStateHash: string;
	directions: [Direction, Direction];
	decision: PlanDecision;
	receipt: Receipt & { steps: [PlanStep, PlanStep] };
};
export type AppliedAction = {
	source: "primary" | "fallback" | "coast";
	direction: Direction;
	tick: number;
	targetTick: number;
	requestId?: string;
	stepIndex?: 0 | 1;
	observedTick?: number;
	reason?: string;
};
export type ScheduledAction = Pick<
	AppliedAction,
	"requestId" | "stepIndex" | "direction" | "targetTick"
> & { eligible: boolean };
export type Intent = {
	requestId: string;
	observedSeq: number;
	targetTick: number;
	expectedStateHash: string;
	direction: Direction;
	receivedGameTimeMs: number;
	decision?: Decision;
};
export type Receipt = {
	protocolVersion?: 2;
	steps?: [PlanStep, PlanStep];
	requestId: string;
	status: "accepted" | "rejected" | "applied" | "cancelled";
	code?: string;
	targetTick?: number;
	seq: number;
};
export type MatchState = {
	id: string;
	forkedFrom?: {
		matchId: string;
		seq: number;
		tick: number;
		gameTimeMs: number;
	};
	agentName: string;
	model: string | null;
	config: GameConfig;
	recordVersion: 1 | 2 | 3;
	rulesVersion: 1 | 2 | 3;
	status: Status;
	createdAt: string;
	startedAt: string | null;
	endedAt: string | null;
	seq: number;
	tick: number;
	gameTimeMs: number;
	lastMoveGameTimeMs?: number;
	lastStepDurationMs?: number;
	score: number;
	applesEaten: number;
	snake: Point[];
	direction: Direction;
	obstacles: Point[];
	apple: Point | null;
	star: { point: Point; expiresAt: number } | null;
	rngState: number;
	pending: Intent[];
	plans?: PlanIntent[];
	lastAppliedAction?: AppliedAction;
	lastPlanOutcome?: "consumed" | "invalid" | "superseded";
	endReason: string | null;
	lastDecision:
		| (ModelDecision & {
				requestId: string;
				outcome: string;
				targetTick: number;
				steps?: [PlanStep, PlanStep];
		  })
		| null;
};
export type PublicState = Omit<
	MatchState,
	"rngState" | "pending" | "plans" | "lastPlanOutcome" | "lastMoveGameTimeMs"
> & { scheduledActions?: ScheduledAction[] };
export type MatchEvent = {
	matchId: string;
	seq: number;
	tick: number;
	gameTimeMs: number;
	createdAt: string;
	type: string;
	data: Record<string, unknown>;
	state: PublicState;
};
export type MatchSummary = Pick<
	PublicState,
	| "id"
	| "agentName"
	| "model"
	| "config"
	| "status"
	| "createdAt"
	| "startedAt"
	| "endedAt"
	| "tick"
	| "gameTimeMs"
	| "score"
	| "endReason"
> & { length: number; seq: number };
export type DecisionContext = {
	observedSeq: number;
	targetTick: number;
	expectedStateHash: string;
	state: PublicState;
	deadlineInMs: number | null;
	elapsedGameTimeMs: number;
	progress: DecisionProgress;
};
export type EventPage = {
	events: MatchEvent[];
	nextSeq: number;
	hasMore: boolean;
	latestSeq: number;
};
export const vectors: Record<Direction, Point> = {
	up: { x: 0, y: -1 },
	right: { x: 1, y: 0 },
	down: { x: 0, y: 1 },
	left: { x: -1, y: 0 },
};
export const opposite: Record<Direction, Direction> = {
	up: "down",
	down: "up",
	left: "right",
	right: "left",
};
export function publicState(state: MatchState): PublicState {
	const {
		rngState: _rng,
		pending: _pending,
		plans,
		lastPlanOutcome: _outcome,
		lastMoveGameTimeMs: _lastMoveTime,
		...result
	} = state;
	const scheduledActions = plans?.flatMap((p) =>
		p.receipt.steps.flatMap((step, i) =>
			step.status === "queued" || step.status === "standby"
				? [
						{
							requestId: p.requestId,
							stepIndex: i as 0 | 1,
							targetTick: step.targetTick,
							direction: step.direction,
							eligible: i === 0 || p.receipt.steps[0].status === "applied",
						},
					]
				: [],
		),
	);
	return structuredClone({
		...result,
		...(scheduledActions ? { scheduledActions } : {}),
	});
}
export function summary(state: MatchState): MatchSummary {
	const {
		id,
		agentName,
		model,
		config,
		status,
		createdAt,
		startedAt,
		endedAt,
		tick,
		gameTimeMs,
		score,
		endReason,
		seq,
	} = state;
	return {
		id,
		agentName,
		model,
		config,
		status,
		createdAt,
		startedAt,
		endedAt,
		tick,
		gameTimeMs,
		score,
		endReason,
		seq,
		length: state.snake.length,
	};
}

export function supportedRecord(
	state: Pick<MatchState, "recordVersion" | "rulesVersion"> & {
		config?: GameConfig;
	},
) {
	const versionSupported =
		state.recordVersion === state.rulesVersion &&
		[1, 2, 3].includes(state.recordVersion);
	if (!versionSupported) return false;
	if (!state.config) return state.recordVersion !== 3;
	const mode = state.config.stepMode;
	if (mode !== undefined && mode !== "fixed" && mode !== "response")
		return false;
	if (state.recordVersion === 3)
		return (
			mode === "response" &&
			state.config.tickIntervalMs === null &&
			(!state.config.decisionMode ||
				state.config.decisionMode === "single_step")
		);
	return (
		mode !== "response" &&
		typeof state.config.tickIntervalMs === "number" &&
		state.config.tickIntervalMs > 0
	);
}
