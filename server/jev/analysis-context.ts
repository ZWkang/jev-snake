import type {
	ActionAssessment,
	DecisionRequestV5,
} from "../../shared/snake/outcome-context.js";
import {
	type DecisionContext,
	type DecisionProgress,
	type DecisionRequestV3,
	type Direction,
	directions,
	type PublicState,
} from "../../shared/snake/types.js";
import type {
	DecisionRequestV4,
	WitnessArchive,
} from "../../shared/snake/witness-context.js";
import { actionOutcome } from "./action-outcomes.js";
import { analyzeAppleAlternatives } from "./apple-alternatives.js";
import { createDeathAnalyzer } from "./branch-death.js";
import { JEV_PROVIDERS } from "./config.js";
import { analyzeActions } from "./context-v3.js";
import { trapInstructions } from "./trap-evidence.js";
import {
	archiveOpportunity,
	opportunityFacts,
	witnessContinuity,
} from "./witness-context.js";

// Historical/offline analysis only. Production requests use board-state-v6.
export const JEV_MODEL = JEV_PROVIDERS.typesafe.model;
export const JEV_ENDPOINT = JEV_PROVIDERS.typesafe.endpoint;
export type DecisionTiming = Pick<
	DecisionContext,
	"elapsedGameTimeMs" | "deadlineInMs"
>;
export const decisionObjective =
	"Play to complete the board by growing the snake, collecting rewards along the way. Decide your strategy from the observed position, candidate consequences and recorded history.";
const factsSemantics =
	"danger=immediate_collision marks an immediately blocked move; danger=proven_fatal marks a forced collision, a proven trapped region, a fork whose every legal exit has a death certificate, or unavoidable post-apple death even with no further growth; danger=null means neither is proven, not guaranteed safety. branch stops at a choice, cycle repeats the full body and direction, unknown_after_apple stops at unknown new food when a next move exists. Frozen space blocks body including tail; tailConnection only opens the tail endpoint. Routes are one static shortest candidate, then dynamically verified, not an exhaustive strategy; no_static_path does not prove that a route with a moving body is impossible. Distances and forcedPath.steps include the analyzed move (and a fatal attempt); postEat describes only that candidate's growth. Star arrival is conditional on schedule; response timing is unknown.";
export function progressInstructions(progress?: DecisionProgress): string {
	if (!progress) return "";
	return " state.progress records committed movement, not a forecast. It counts visits to this full body, heading and food configuration since the last apple. actions counts actual departures and how often each was followed by returning here without an apple; rejected or merely proposed actions do not count. A historical return describes what happened, not which direction to choose or whether an alternative is safe.";
}
export function contextState(
	state: PublicState,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): DecisionRequestV3["state"] {
	if (progress && progress.throughTick !== state.tick)
		throw new Error("Progress must describe the actual observed tick");
	if (state.config.stepMode !== "response" && timing?.deadlineInMs === null)
		throw new Error("A fixed decision requires a numeric deadline");
	return {
		contextVersion: "action-facts-v3",
		...(progress ? { progress } : {}),
		rules: {
			objective:
				state.config.stepMode === "response"
					? "Eat apples and stars while staying alive. The snake waits for your response, then moves exactly one cell. No direct reversal. Coordinates: x increases right, y increases down."
					: "Eat apples and stars while staying alive. The snake keeps moving. No direct reversal. Coordinates: x increases right, y increases down.",
			applePoints: 10,
			starPoints: 30,
			factsSemantics,
		},
		board: {
			width: state.config.width,
			height: state.config.height,
			obstacleCount: state.obstacles.length,
		},
		player: {
			head: state.snake[0],
			direction: state.direction,
			length: state.snake.length,
			score: state.score,
		},
		food: { apple: state.apple, star: state.star },
		timing: {
			stateIsProjected: false,
			observedTick: state.tick,
			targetTick: state.tick + 1,
			gameTimeMs: timing?.elapsedGameTimeMs ?? state.gameTimeMs,
			...(state.config.stepMode === "response"
				? {
						stepMode: "response" as const,
						tickIntervalMs: null,
						deadlineInMs: null,
					}
				: {
						stepMode: "fixed" as const,
						tickIntervalMs: state.config.tickIntervalMs,
						...(typeof timing?.deadlineInMs === "number"
							? { deadlineInMs: timing.deadlineInMs }
							: {}),
					}),
		},
	};
}
export function decisionBodyV3(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): DecisionRequestV3 {
	const analyzer = createDeathAnalyzer();
	const facts = analyzeActions(state, timing, 0, analyzer);
	return {
		model,
		state: contextState(state, timing, progress),
		questions: {
			direction: {
				type: "choice",
				instructions:
					"Choose one absolute direction for the immediately upcoming move. " +
					decisionObjective +
					trapInstructions(state, false, analyzer) +
					progressInstructions(progress) +
					" Return your own choice from the four options.",
				criteria: {
					up: { meaning: "Move one cell toward y-1.", ...facts.up },
					right: { meaning: "Move one cell toward x+1.", ...facts.right },
					down: { meaning: "Move one cell toward y+1.", ...facts.down },
					left: { meaning: "Move one cell toward x-1.", ...facts.left },
				},
			},
		},
	};
}
export const positiveSemantics =
	"opportunity is an existence witness, not a recommendation or survival probability. Its moves include the candidate. Apple witnesses stop at the known apple; the respawn is unknown. A cycle restores the ordered body and heading without growth and does not prove that the apple is unreachable. Release passages were replayed against the moving body. opportunity.postEat belongs to that exact witness endpoint and describes geometry before unknown food respawns. witnessContinuity describes current geometry compatible with a previous witness at the stated step; it does not assert that those prior moves were taken, a model commitment, or an instruction to follow it.";
const positiveObjective =
	"Choose the next direction to work toward completing the board. Decide your strategy using the current action consequences, verified opportunities, their assumptions and the recorded movement history. The evidence describes what is known and what remains unresolved. Choose one of the four directions.";

export function buildDecisionContextV4(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): { request: DecisionRequestV4; evidence: WitnessArchive } {
	const base = decisionBodyV3(state, model, timing, progress);
	const evidence: WitnessArchive = {
		version: "positive-v1",
		observedTick: state.tick,
		records: {},
	};
	const opportunities = opportunityFacts(state, evidence);
	const criteria = Object.fromEntries(
		directions.map((d) => [
			d,
			{
				...base.questions.direction.criteria[d],
				opportunity: opportunities[d],
			},
		]),
	) as DecisionRequestV4["questions"]["direction"]["criteria"];
	return {
		evidence,
		request: {
			model,
			state: {
				...base.state,
				contextVersion: "action-facts-v4",
				rules: {
					...base.state.rules,
					factsSemantics:
						base.state.rules.factsSemantics + " " + positiveSemantics,
				},
				witnessContinuity: witnessContinuity(state, evidence),
			},
			questions: {
				direction: {
					type: "choice",
					instructions: positiveObjective + progressInstructions(progress),
					criteria,
				},
			},
		},
	};
}
export function decisionBodyV4(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): DecisionRequestV4 {
	return buildDecisionContextV4(state, model, timing, progress).request;
}
const outcomeSemantics =
	"Each option describes one first move, its overall survival consequence, and one conditional route to the observed apple. survival.proven_fatal applies to every continuation from the first move; appleRoute.postApple applies only after following that particular route. Collision bounds include the fatal attempt; route moves include the first move. not_proven_fatal means unresolved, not guaranteed survival. A no-growth cycle is not food progress. starRoute is a frozen known-star candidate, not an exhaustive dynamic search. Historical progress records actual behavior, not an intended next direction.";
const outcomeObjective =
	"Choose the next direction toward completing the board. Read each option's complete consequence and conditional food route together, including what follows apple growth. Use the actual movement history as context. Decide your strategy from these facts and make your own choice from all four directions.";

export function buildDecisionContextV5(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): { request: DecisionRequestV5; evidence: WitnessArchive } {
	const base = contextState(state, timing, progress);
	const analyzer = createDeathAnalyzer();
	const facts = analyzeActions(state, timing, 0, analyzer);
	const evidence: WitnessArchive = {
		version: "positive-v1",
		observedTick: state.tick,
		records: {},
	};
	const opportunities = opportunityFacts(state, evidence);
	const meanings: Record<Direction, string> = {
		up: "Move one cell toward y-1.",
		right: "Move one cell toward x+1.",
		down: "Move one cell toward y+1.",
		left: "Move one cell toward x-1.",
	};
	const criteria = Object.fromEntries(
		directions.map((direction) => {
			let opportunity = opportunities[direction];
			let record = opportunity.witnessId
				? evidence.records[opportunity.witnessId]
				: undefined;
			let outcome = actionOutcome(
				state,
				direction,
				facts[direction],
				opportunity,
				record,
				analyzer,
			);
			let appleAlternativeSearch: ActionAssessment["appleAlternativeSearch"];
			if (
				outcome.survival.status === "not_proven_fatal" &&
				outcome.appleRoute.postApple?.status === "proven_fatal"
			) {
				const initialRouteMoves = outcome.appleRoute.moves!;
				const alternatives = analyzeAppleAlternatives(
					state,
					direction,
					analyzer,
				);
				appleAlternativeSearch = {
					status: alternatives.evidence ? "endpoint_found" : "exhausted",
					initialRouteMoves,
					expandedStates: alternatives.expandedStates,
					fatalAppleEndpoints: alternatives.fatalAppleEndpoints,
				};
				if (alternatives.evidence) {
					opportunity = archiveOpportunity(
						state,
						alternatives.evidence,
						evidence,
					);
					record = evidence.records[opportunity.witnessId!];
					outcome = actionOutcome(
						state,
						direction,
						facts[direction],
						opportunity,
						record,
						analyzer,
					);
					outcome.summary += ` The initial ${initialRouteMoves}-move apple route had a proven-fatal growth endpoint. Searching other arrival geometries found the different route described here; its endpoint is not a guarantee of long-term survival.`;
				} else {
					outcome.summary +=
						" The complete moving-body graph before eating this observed apple was exhausted: every reachable apple-arrival geometry has a post-growth death proof. This is a food-progress limitation; it does not assert that every no-growth continuation collides.";
				}
			}
			return [
				direction,
				{
					meaning: meanings[direction],
					...outcome,
					...(appleAlternativeSearch ? { appleAlternativeSearch } : {}),
					space: facts[direction].space,
					starRoute: facts[direction].starRoute,
					noGrowthCycle: opportunity.cycle,
					bodyReleasePassages: opportunity.releasePassages.map(
						({ point, earliestReleaseStep, enteredAtStep }) => ({
							point,
							earliestReleaseStep,
							enteredAtStep,
						}),
					),
				} satisfies ActionAssessment,
			];
		}),
	) as Record<Direction, ActionAssessment>;
	return {
		evidence,
		request: {
			model,
			state: {
				...base,
				contextVersion: "action-outcomes-v5",
				rules: {
					...base.rules,
					objective:
						"Fill every traversable cell with the snake. Apples grow the body by one cell; stars add points without growth. No direct reversal. The snake waits for your response, then moves exactly one cell. Coordinates: x increases right, y increases down.",
					factsSemantics: outcomeSemantics,
				},
			},
			questions: {
				direction: {
					type: "choice",
					instructions: outcomeObjective + progressInstructions(progress),
					criteria,
				},
			},
		},
	};
}
export function decisionBodyV5(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): DecisionRequestV5 {
	return buildDecisionContextV5(state, model, timing, progress).request;
}
