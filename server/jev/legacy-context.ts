// Offline historical context fixtures only. No provider or execution entry point.
import {
	type DecisionProgress,
	type Direction,
	type PlanRequestV3,
	type PublicState,
	directions,
	planChoices,
	planDirections,
} from "../../shared/snake/types.js";
import type {
	PlanRequestV4,
	WitnessArchive,
	ActionSummaryV4,
	PairSummaryV4,
} from "../../shared/snake/witness-context.js";
import { createDeathAnalyzer } from "./branch-death.js";
import {
	JEV_MODEL,
	type DecisionTiming,
	decisionObjective,
	contextState,
	progressInstructions,
	positiveSemantics,
} from "./client.js";
import {
	analyzeActions,
	analyzeSecondActions,
	advanceGeometry,
} from "./context-v3.js";
import { trapInstructions } from "./trap-evidence.js";
import { opportunityFacts, witnessContinuity } from "./witness-context.js";

export function planBodyV3(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): PlanRequestV3 {
	if (state.config.stepMode === "response")
		throw new Error("response step-mode cannot use two_step_fallback");
	if (timing?.deadlineInMs === null)
		throw new Error("A fixed two-step plan requires a numeric deadline");
	const analyzer = createDeathAnalyzer();
	const firstActions = analyzeActions(state, timing, 0, analyzer);
	const secondFacts = Object.fromEntries(
		directions.map((first) => [
			first,
			analyzeSecondActions(state, first, timing, analyzer),
		]),
	) as Record<Direction, ReturnType<typeof analyzeSecondActions>>;
	return {
		model,
		state: {
			...contextState(state, timing, progress),
			contextVersion: "two-step-plan-v3",
			firstActions,
			planningHorizon: 2,
			targetTicks: [state.tick + 1, state.tick + 2],
			timing: {
				stateIsProjected: false,
				observedTick: state.tick,
				targetTick: state.tick + 1,
				gameTimeMs: timing?.elapsedGameTimeMs ?? state.gameTimeMs,
				stepMode: "fixed",
				tickIntervalMs: state.config.tickIntervalMs,
				...(timing ? { deadlineInMs: timing.deadlineInMs } : {}),
			},
		},
		questions: {
			plan: {
				type: "choice",
				instructions:
					"Choose one ordered two-move plan. First is the immediately upcoming move; second is backup only if first executes and no fresh decision is available. Each pair's first direction refers to state.firstActions; secondFacts is conditional on that first move. Second-move distances and steps start after the first move. When secondStatus=known, its facts describe the second move; after unknown growth only second immediateCollision is known. A completed board needs no second move. " +
					decisionObjective +
					trapInstructions(state, true, analyzer) +
					(progress
						? progressInstructions(progress) +
							" Historical actions describe only the first direction, not the unexecuted backup."
						: "") +
					" If first grows, only second-move collision is known; new rewards and continuation remain unknown. Choose one of the provided pairs.",
				criteria: Object.fromEntries(
					planChoices.map((choice) => {
						const [first, second] = planDirections(choice);
						return [choice, secondFacts[first][second]];
					}),
				) as PlanRequestV3["questions"]["plan"]["criteria"],
			},
		},
	};
}
export function buildPlanContext(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): { request: PlanRequestV4; evidence: WitnessArchive } {
	const base = planBodyV3(state, model, timing, progress);
	const evidence: WitnessArchive = {
		version: "positive-v1",
		observedTick: state.tick,
		records: {},
	};
	const opportunities = opportunityFacts(state, evidence);
	const firstActions = Object.fromEntries(
		directions.map((d) => [
			d,
			{ ...base.state.firstActions[d], opportunity: opportunities[d] },
		]),
	) as Record<Direction, ActionSummaryV4>;
	const criteria: Record<string, PairSummaryV4> = {};
	for (const first of directions) {
		const known =
			base.questions.plan.criteria[`${first}_up`].secondStatus === "known";
		const after = known
			? { ...advanceGeometry(state, first), tick: state.tick + 1 }
			: null;
		const second = after
			? opportunityFacts(after, evidence, "conditional_second")
			: null;
		for (const direction of directions) {
			const key = `${first}_${direction}` as const;
			const pair = base.questions.plan.criteria[key];
			criteria[key] =
				pair.secondStatus === "known" && second
					? {
							...pair,
							secondFacts: {
								...pair.secondFacts,
								opportunity: second[direction],
							},
						}
					: (pair as PairSummaryV4);
		}
	}
	return {
		evidence,
		request: {
			model,
			state: {
				...base.state,
				contextVersion: "two-step-plan-v4",
				firstActions,
				rules: {
					...base.state.rules,
					factsSemantics:
						base.state.rules.factsSemantics + " " + positiveSemantics,
				},
				witnessContinuity: witnessContinuity(state),
			},
			questions: {
				plan: {
					type: "choice",
					instructions:
						"Choose one ordered two-move plan toward completing the board. The first move is the immediately upcoming move. The second is backup only if the first executes and no fresh decision is available. Read state.firstActions for the first direction and the conditional secondFacts for the second. Second-move counts start after the first move. After growth, future food is unknown. Use the consequences, verified opportunities and recorded history; choose one of the provided pairs. Historical actions describe only the first direction, not the unexecuted backup. " +
						progressInstructions(progress),
					criteria,
				},
			},
		},
	};
}
export function planBody(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): PlanRequestV4 {
	return buildPlanContext(state, model, timing, progress).request;
}
