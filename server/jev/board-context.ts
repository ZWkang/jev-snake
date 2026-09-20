import { renderAsciiBoard } from "../../shared/snake/ascii-board.js";
import type { DecisionRequestV6 } from "../../shared/snake/board-context.js";
import {
	compactGrowthRequest,
	type DecisionRequestV16,
} from "../../shared/snake/compact-growth.js";
import {
	analyzeDynamicSpace,
	describeDynamicSpaceMove,
	dynamicSpaceSemantics,
	dynamicStaticSemantics,
} from "../../shared/snake/dynamic-space-analysis.js";
import type { DecisionRequestV14 } from "../../shared/snake/dynamic-space.js";
import {
	analyzeGrowthSpace,
	describeGrowthSpaceMove,
	growthSpaceSemantics,
	liveGrowthLimits,
} from "../../shared/snake/growth-space-analysis.js";
import type {
	DecisionRequestV15,
	GrowthAnalysisLimits,
} from "../../shared/snake/growth-space.js";
import {
	analyzeLegalSpace,
	describeLegalSpaceMove,
	legalSpaceSemantics,
} from "../../shared/snake/legal-space-analysis.js";
import type { DecisionRequestV13 } from "../../shared/snake/legal-space.js";
import type { DecisionRequestV11 } from "../../shared/snake/model-planning.js";
import { snakeStrategyGuide } from "../../shared/snake/model-strategies.js";
import { renderNeighborCells } from "../../shared/snake/neighbor-cells.js";
import type { DecisionRequestV12 } from "../../shared/snake/non-reverse.js";
import { repositoryDecisionGuide } from "../../shared/snake/repository-strategies.js";
import {
	type DecisionContext,
	type DecisionProgress,
	type PublicState,
	directions,
	isResponseMode,
	opposite,
} from "../../shared/snake/types.js";
import { JEV_PROVIDERS } from "./config.js";
import type { GrowthRouteMemory } from "./growth-route-memory.js";
const JEV_MODEL = JEV_PROVIDERS.typesafe.model;
export type DecisionTiming = Pick<
	DecisionContext,
	"elapsedGameTimeMs" | "deadlineInMs"
>;

/** Copy observed facts only. No simulated moves, path search or future rewards. */
export function buildBoardContextV6(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): { request: DecisionRequestV6 } {
	if (!isResponseMode(state.config))
		throw new Error(
			"Only response single-step matches can request a live decision",
		);
	if (progress && progress.throughTick !== state.tick)
		throw new Error("Progress must describe the actual observed tick");
	if (timing && timing.deadlineInMs !== null)
		throw new Error("Response decisions have no fixed deadline");
	const request: DecisionRequestV6 = {
		model,
		state: {
			contextVersion: "board-state-v6",
			rules: {
				objective:
					"Grow the snake to fill every traversable cell while collecting rewards. Decide your own route and strategy from the complete observed board and actual history.",
				applePoints: 10,
				starPoints: 30,
				coordinates:
					"Coordinates are zero-based: x increases right, y increases down. The board spans x=0..width-1 and y=0..height-1. bodyHeadToTail lists every occupied snake cell in order, with the head first and the tail last.",
				mechanics:
					"The snake waits for your response, then moves exactly one cell in the chosen absolute direction. Direct reversal is illegal. Hitting the boundary, an obstacle or the body ends the game. The tail vacates its current cell on a move that does not eat an apple, so that vacating tail cell may be entered. Eating an apple grows the body by one cell and gives 10 points; the tail does not vacate. A new apple then appears in an unoccupied cell; its position is unknown until the next observation. A star gives 30 points without growth and expires at food.star.expiresAt in the same game-time milliseconds as timing.gameTimeMs. Filling every non-obstacle cell wins. Past repetition records actual movement and does not prescribe your next move.",
			},
			board: {
				width: state.config.width,
				height: state.config.height,
				obstacles: state.obstacles.map((p) => ({ ...p })),
			},
			player: {
				bodyHeadToTail: state.snake.map((p) => ({ ...p })),
				direction: state.direction,
				score: state.score,
				applesEaten: state.applesEaten,
			},
			food: {
				apple: state.apple ? { ...state.apple } : null,
				star: state.star
					? { point: { ...state.star.point }, expiresAt: state.star.expiresAt }
					: null,
			},
			timing: {
				stateIsProjected: false,
				stepMode: "response",
				observedTick: state.tick,
				targetTick: state.tick + 1,
				gameTimeMs: timing?.elapsedGameTimeMs ?? state.gameTimeMs,
				tickIntervalMs: null,
				deadlineInMs: null,
			},
			...(progress ? { progress: structuredClone(progress) } : {}),
		},
		questions: {
			direction: {
				type: "choice",
				instructions:
					"Choose one absolute direction for the next move using the complete board, game rules and recorded history. Plan your own strategy toward completing the board. The options name directions only; no route, safety score or preferred action is supplied by the game server.",
				criteria: {
					up: { meaning: "Move one cell toward y-1." },
					right: { meaning: "Move one cell toward x+1." },
					down: { meaning: "Move one cell toward y+1." },
					left: { meaning: "Move one cell toward x-1." },
				},
			},
		},
	};
	return { request };
}
export function decisionBodyV6(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): DecisionRequestV6 {
	return buildBoardContextV6(state, model, timing, progress).request;
}

/** Live input contains observations and rules only. The model owns planning. */
export function buildModelContextV11(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): { request: DecisionRequestV11 } {
	const base = buildBoardContextV6(state, model, timing, progress).request;
	return {
		request: {
			...base,
			state: {
				...base.state,
				contextVersion: "model-planning-v11",
				strategyGuide: snakeStrategyGuide,
				board: {
					...base.state.board,
					ascii: renderAsciiBoard({
						...base.state.board,
						bodyHeadToTail: base.state.player.bodyHeadToTail,
						apple: base.state.food.apple,
						star: base.state.food.star?.point ?? null,
					}),
				},
				rules: {
					...base.state.rules,
					mechanics:
						base.state.rules.mechanics +
						" Apple spawning excludes the current star cell; if the star occupies the only free cell, it is removed to make room for the apple.",
				},
			},
			questions: {
				direction: {
					type: "choice",
					instructions:
						"This is a Snake game. You control the snake. Your objective is to fill every traversable cell. Read board.ascii.map for the complete current board and board.ascii.legend for its symbols; columns are x and rows are y. Use player.bodyHeadToTail for the ordered body. Decide your own route from the observed board, rules and actual history. Judge reversal and collision yourself. Apply the following general playing principles using your own judgment; they are not evaluated moves, supplied paths or safety certificates for this position. The same guide is included in state.strategyGuide.\n\n" +
						snakeStrategyGuide +
						"\n\nChoose exactly the next absolute direction from the four options.",
					criteria: base.questions.direction.criteria,
				},
			},
		},
	};
}
export function decisionBodyV11(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): DecisionRequestV11 {
	return buildModelContextV11(state, model, timing, progress).request;
}

/** Exclude only the mechanically forbidden reverse; do not assess any route. */
export function buildDecisionContextV12(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): { request: DecisionRequestV12 } {
	const base = buildModelContextV11(state, model, timing, progress).request;
	const reverse = opposite[state.direction];
	const ascii = base.state.board.ascii!;
	const neighboringCells = renderNeighborCells(
		{
			...base.state.board,
			bodyHeadToTail: base.state.player.bodyHeadToTail,
			apple: base.state.food.apple,
			star: base.state.food.star?.point ?? null,
		},
		directions.filter((direction) => direction !== reverse),
	);
	// Both model fields use the same complete procedure; observations stay raw.
	const instructions =
		"This is a Snake game. Choose the next absolute direction.\n\nCurrent board:\n" +
		ascii.map +
		"\n\nLegend: " +
		ascii.legend +
		"\n\nColumns are x and rows are y. Row labels, column labels and spaces are not cells. Directions do not rotate with the snake's heading. A move advances exactly one cell.\n\n" +
		"Crossing the boundary or entering # or B ends the game immediately. T vacates when the move does not eat an apple; it stays when the snake grows by eating A. An offered direction is not necessarily free of collisions.\n\n" +
		"Observed neighboring cells, copied from this same board before moving:\n" +
		neighboringCells +
		"\n\n" +
		"Locate H. Read the cells directly adjacent to H: left and right are the neighboring symbols in the same row; up and down are the symbols in the same column of the neighboring rows. Only these adjacent cells are destinations for this move. Food beyond an adjacent blocking cell cannot be reached by this move.\n\n" +
		repositoryDecisionGuide;
	return {
		request: {
			...base,
			state: {
				...base.state,
				contextVersion: "non-reverse-v12",
				strategyGuide: repositoryDecisionGuide,
			},
			questions: {
				direction: {
					...base.questions.direction,
					instructions,
					criteria: Object.fromEntries(
						Object.entries(base.questions.direction.criteria).filter(
							([direction]) => direction !== reverse,
						),
					),
				},
			},
		},
	};
}

export function decisionBodyV12(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): DecisionRequestV12 {
	return buildDecisionContextV12(state, model, timing, progress).request;
}

/** One-move rules and static space facts; JEV still chooses the actual direction. */
export function buildDecisionContextV13(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): { request: DecisionRequestV13 } {
	const base = buildModelContextV11(state, model, timing, progress).request;
	const {
		strategyGuide: _guide,
		contextVersion: _version,
		...observed
	} = base.state;
	const analysis = analyzeLegalSpace({
		width: observed.board.width,
		height: observed.board.height,
		bodyHeadToTail: observed.player.bodyHeadToTail,
		direction: observed.player.direction,
		obstacles: observed.board.obstacles,
		apple: observed.food.apple,
		star: observed.food.star?.point ?? null,
	});
	const criteria = Object.fromEntries(
		directions.flatMap((direction) => {
			const facts = analysis.moveFacts[direction];
			return facts
				? [[direction, describeLegalSpaceMove(direction, facts)]]
				: [];
		}),
	);
	if (Object.keys(criteria).length === 0)
		throw new Error(
			"No legal directions remain; there is no model decision to request",
		);
	const ascii = observed.board.ascii!;
	const instructions =
		"This is a Snake game. Choose one offered absolute direction to keep eating apples and fill every non-obstacle cell.\n\n" +
		`Current observed board (tick ${observed.timing.observedTick}; choose move ${observed.timing.targetTick}):\n` +
		ascii.map +
		"\n\nLegend: " +
		ascii.legend +
		"\n\nEvery offered option was checked by the game rules and is legal for this single move. The option descriptions contain program-computed one-move results and static space facts. BOARD_COMPLETE wins immediately and needs no further exit. Otherwise, avoid NO_NEXT_MOVE when another option has a continuation. Treat DEAD_END_RISK as a static warning, not proof of inevitable death. Prefer usable space and access toward the moving tail, then pursue the apple through a viable approach; do not circle indefinitely just to maximize empty space. Use the recorded food progress when comparing detours. Manhattan distance is not a verified route, and static space is not a long-term safety guarantee. Select exactly one offered direction.";
	return {
		request: {
			model,
			state: {
				...observed,
				contextVersion: "legal-space-v13",
				...analysis,
				factsSemantics: legalSpaceSemantics,
			},
			questions: {
				direction: { type: "choice", instructions, criteria },
			},
		},
	};
}

export function decisionBodyV13(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): DecisionRequestV13 {
	return buildDecisionContextV13(state, model, timing, progress).request;
}

/** Bounded dynamic evidence; the provider still chooses every submitted move. */
export function buildDecisionContextV14(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): { request: DecisionRequestV14 } {
	const base = buildDecisionContextV13(state, model, timing, progress).request;
	const observed = base.state;
	const analysis = analyzeDynamicSpace({
		...observed.board,
		bodyHeadToTail: observed.player.bodyHeadToTail,
		direction: observed.player.direction,
		apple: observed.food.apple,
		star: observed.food.star?.point ?? null,
	});
	const criteria = Object.fromEntries(
		directions.flatMap((direction) => {
			const facts = observed.moveFacts[direction];
			const dynamic = analysis.dynamicFacts[direction];
			return facts && dynamic
				? [[direction, describeDynamicSpaceMove(direction, facts, dynamic)]]
				: [];
		}),
	);
	const ascii = observed.board.ascii!;
	const history = observed.progress
		? `Food progress: ${observed.progress.movesSinceApple} moves since the last apple; this exact body/heading/food position has been visited ${observed.progress.positionVisits} times. Recorded departures followed by returning here without an apple: ` +
			directions
				.filter((direction) => observed.moveFacts[direction])
				.map(
					(direction) =>
						`${direction}=${observed.progress!.actions[direction].returnsWithoutApple}`,
				)
				.join(", ") +
			"."
		: "No prior progress history supplied.";
	const instructions =
		"This is a Snake game. Your goal is to keep eating apples and grow to fill all non-obstacle cells. Choose exactly one offered absolute direction.\n\n" +
		`Current observation: tick ${observed.timing.observedTick}; choosing move ${observed.timing.targetTick}.\n` +
		ascii.map +
		"\nLegend: " +
		ascii.legend +
		"\n\n" +
		"Compare consequences in this order: (1) BOARD_COMPLETE wins. Otherwise do not choose PROVEN_TRAP or NO_NEXT_MOVE when another offered move is not proved trapped. PROVEN_TRAP means every legal continuation in that branch ends with no legal move; it is stronger evidence than the static DEAD_END_RISK warning. (2) Seek food progress using the dynamic apple-route evidence: it moves the entire body and checks growth at the apple. A route with an exit can require moving away from the apple first so the tail has time to vacate. Compare the growth-end exits and tail connection; an immediate exit alone is not a long-term guarantee. (3) When no checked food route is available, preserve movement and change the body arrangement to open an approach, using tail connection and space as supporting evidence. A larger static area or smaller Manhattan distance must not override a proved trap or substitute for a checked food approach.\n\n" +
		history +
		" Repeated no-apple returns mean that the previous pattern made no progress. Prefer an available checked food approach over repeating that pattern. If no option has a checked food approach, compare the non-proven-trapped options with a checked continuation and prefer changing an already repeated departure to reshape the body. Do not keep choosing the same fruitless cycle just because its area or Manhattan distance looks attractive. Repetition alone does not prove another direction safe.\n\n" +
		"Analysis is bounded and its limits and unknown results are explicit. HORIZON_REACHED only witnesses movement within the checked window. NO_ROUTE_WITH_EXIT_FOUND does not mean food is unreachable. Future apples are unknown. These are option facts, not an automatically executed plan; decide this one move from the current board and reassess after the next real observation.";
	return {
		request: {
			model,
			state: {
				...observed,
				contextVersion: "dynamic-space-v14",
				factsSemantics: dynamicStaticSemantics,
				...analysis,
				dynamicSemantics: dynamicSpaceSemantics,
			},
			questions: { direction: { type: "choice", instructions, criteria } },
		},
	};
}

export function decisionBodyV14(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): DecisionRequestV14 {
	return buildDecisionContextV14(state, model, timing, progress).request;
}

/** Bounded dynamic evidence; the provider still chooses every submitted move. */
export function buildDecisionContextV15(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
	search?: { limits: GrowthAnalysisLimits; memory?: GrowthRouteMemory },
): { request: DecisionRequestV15 } {
	const base = buildDecisionContextV13(state, model, timing, progress).request;
	const observed = base.state;
	const input = {
		...observed.board,
		bodyHeadToTail: observed.player.bodyHeadToTail,
		direction: observed.player.direction,
		apple: observed.food.apple,
		star: observed.food.star?.point ?? null,
	};
	const analysis = search?.memory
		? search.memory.analyze(
				input,
				{ matchId: state.id, tick: state.tick },
				search.limits,
			)
		: analyzeGrowthSpace(input, search?.limits);
	const criteria = Object.fromEntries(
		directions.flatMap((direction) => {
			const facts = observed.moveFacts[direction];
			const dynamic = analysis.dynamicFacts[direction];
			return facts && dynamic
				? [[direction, describeGrowthSpaceMove(direction, facts, dynamic)]]
				: [];
		}),
	);
	const ascii = observed.board.ascii!;
	const history = observed.progress
		? `Food progress: ${observed.progress.movesSinceApple} moves since the last apple; this exact body/heading/food position has been visited ${observed.progress.positionVisits} times. Recorded departures followed by returning here without an apple: ` +
			directions
				.filter((direction) => observed.moveFacts[direction])
				.map(
					(direction) =>
						`${direction}=${observed.progress!.actions[direction].returnsWithoutApple}`,
				)
				.join(", ") +
			"."
		: "No prior progress history supplied.";
	const instructions =
		"This is a Snake game. Your goal is to keep eating apples and grow to fill all non-obstacle cells. Choose exactly one offered absolute direction.\n\n" +
		`Current observation: tick ${observed.timing.observedTick}; choosing move ${observed.timing.targetTick}.\n` +
		ascii.map +
		"\nLegend: " +
		ascii.legend +
		"\n\n" +
		"Compare consequences in this order: (1) Prefer a winning continuation. Otherwise do not choose PROVEN_TRAP or NO_NEXT_MOVE when another offered move is not proved trapped. PROVEN_TRAP now includes apple growth: even in the optimistic case of no later growth, every continuation runs out of moves, and an earlier board-complete win has been ruled out. (2) Seek apple progress using arrival-specific post-apple checks, not merely the number of exits immediately after eating. An exit can lead into another dead end. Proven trapped apple arrivals are rejected and other arrival body arrangements are searched. Compare a found optimistic continuation, tail access and food progress; temporarily moving away from food may give the tail time to move. (3) An optimistic continuation assumes no additional growth after the current apple, so it is conditional evidence, not guaranteed safety when later food appears. Node limits and near-win exceptions remain unknown; never treat an unknown check as passed. Static area and Manhattan distance must not override a complete trap proof.\n\n" +
		history +
		" Repeated no-apple returns mean that the previous pattern made no progress. Prefer an available checked food approach over repeating that pattern. If no option has a checked food approach, compare the non-proven-trapped options with a checked continuation and prefer changing an already repeated departure to reshape the body. Do not keep choosing the same fruitless cycle just because its area or Manhattan distance looks attractive. Repetition alone does not prove another direction safe.\n\n" +
		"Analysis is bounded and its limits and unknown results are explicit. HORIZON_REACHED is a limited observed-food continuation; OPTIMISTIC_HORIZON_REACHED assumes no further growth. An unsuccessful bounded apple search does not mean food is unreachable. Post-apple move counts start after the apple is eaten; route and branch move counts include this first action. Future apples are unknown. These are option facts, not an automatically executed plan; decide this one move from the current board and reassess after the next real observation.";
	return {
		request: {
			model,
			state: {
				...observed,
				contextVersion: "growth-space-v15",
				factsSemantics: dynamicStaticSemantics,
				...analysis,
				dynamicSemantics: growthSpaceSemantics,
			},
			questions: { direction: { type: "choice", instructions, criteria } },
		},
	};
}

export function decisionBodyV15(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): DecisionRequestV15 {
	return buildDecisionContextV15(state, model, timing, progress).request;
}

/** Live search retains bounded proofs and revalidates the previous candidate. */
export function buildDecisionContext(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
	routeMemory?: GrowthRouteMemory,
): { request: DecisionRequestV16 } {
	return {
		request: compactGrowthRequest(
			buildDecisionContextV15(state, model, timing, progress, {
				limits: liveGrowthLimits,
				memory: routeMemory,
			}).request,
		),
	};
}

export function decisionBody(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): DecisionRequestV16 {
	return buildDecisionContext(state, model, timing, progress).request;
}
