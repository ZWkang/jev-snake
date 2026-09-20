import type {
	DecisionRequestV9,
	LocalSearchOptions,
} from "../../shared/snake/bounded-search.js";
import type { DecisionRequestV8 } from "../../shared/snake/global-view.js";
/** Historical search-assisted builders. Import explicitly for offline evaluation only. */
import type { DecisionRequestV7 } from "../../shared/snake/local-moves.js";
import type { DecisionRequestV10 } from "../../shared/snake/post-apple-search.js";
import {
	directions,
	type DecisionProgress,
	type PublicState,
} from "../../shared/snake/types.js";
import { buildBoardContextV6, type DecisionTiming } from "./board-context.js";
import { searchLocalMoves } from "./bounded-search.js";
import { JEV_PROVIDERS } from "./config.js";
import { immediateMoves, currentMoves } from "./immediate-moves.js";
import { observedSpace } from "./observed-space.js";
import { searchPostAppleMoves } from "./post-apple-search.js";
const JEV_MODEL = JEV_PROVIDERS.typesafe.model;

/** JEV judges a narrow next-move choice over explicit, exact local facts. */
export function buildLocalContextV7(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): { request: DecisionRequestV7 } {
	const base = buildBoardContextV6(state, model, timing, progress).request;
	const moves = immediateMoves(state, progress);
	return {
		request: {
			model,
			state: {
				...base.state,
				contextVersion: "local-moves-v7",
				immediateMoves: moves,
				rules: {
					...base.state.rules,
					objective:
						"Collect apples to grow the snake until it fills every traversable cell. Avoid immediately losing the game.",
				},
			},
			questions: {
				direction: {
					type: "choice",
					instructions: {
						question:
							"Which one absolute direction should the snake take for its immediately next move?",
						inspect:
							"Read `immediateMoves`. Each direction states its exact current legal status, destination cell and apple progress. `board`, `player` and `food` contain the observed geometry for context; do not recompute the supplied one-step facts.",
						constraint:
							"Choose a direction whose `legal` is true. A direction marked blocked is an immediate collision or an illegal reversal, even if it points toward food. All four directions are listed so their conditions can be compared.",
						objective:
							"Among moves legal now, choose the next move that best supports collecting apples while staying alive. Use the local observations and actual history to make your own choice.",
						uncertainty:
							"Legal now does not guarantee safety later. `appleProgress` describes only the change in direct grid distance, not a path around obstacles or a promise that food can be reached. No future route or death prediction is supplied.",
						history:
							"`departureHistory` reports what actually happened after this departure at the same position. A previous return without an apple is evidence of no food progress on that recorded traversal, not proof that this direction is impossible or that another direction is safe.",
					},
					criteria: Object.fromEntries(
						directions.map((direction) => [
							direction,
							{
								meaning: base.questions.direction.criteria[direction].meaning,
								chooseWhen: `Choose ${direction} when \`immediateMoves.${direction}.legal\` is true and its local facts make it the best next move for the objective.`,
								excludeWhen: `Do not choose ${direction} when \`immediateMoves.${direction}.legal\` is false. Its \`blockedBy\` field identifies the collision or illegal reversal.`,
							},
						]),
					) as DecisionRequestV7["questions"]["direction"]["criteria"],
				},
			},
		},
	};
}
export function decisionBodyV7(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): DecisionRequestV7 {
	return buildLocalContextV7(state, model, timing, progress).request;
}

/** Whole current-board observation; no future states or routes are searched. */
export function buildGlobalContextV8(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): { request: DecisionRequestV8 } {
	const base = buildBoardContextV6(state, model, timing, progress).request;
	return {
		request: {
			model,
			state: {
				...base.state,
				contextVersion: "global-view-v8",
				immediateMoves: currentMoves(state, progress),
				observedSpace: observedSpace(state),
				rules: {
					...base.state.rules,
					objective:
						"Complete the board over the whole game by growing the snake while preserving the ability to keep moving.",
				},
			},
			questions: {
				direction: {
					type: "choice",
					instructions: {
						question:
							"Which one absolute direction should the snake take for its immediately next move?",
						inspect:
							"Read `immediateMoves` for legality and `observedSpace.moves` for the open region entered, whether it currently contains the apple, and the open neighbors around the target. `observedSpace.regions` describes the whole current board.",
						constraint:
							"Choose a direction whose `legal` is true. A direction marked blocked is an immediate collision or an illegal reversal, even if it points toward food. All four directions are listed so their conditions can be compared.",
						objective:
							"Choose the first move that best preserves room to maneuver and access to food over the whole game. A detour temporarily away from the apple can be better than entering a confined pocket. Do not treat coordinate proximity to food as route quality.",
						uncertainty:
							"`observedSpace` freezes all currently occupied body cells. Its region size and open-neighbor counts are observations, not simulated next states or death/safety proofs. The body and tail move: a small region or a region without the apple can later open; a vacating-tail entry has no currently empty target region. No future route is supplied.",
						history:
							"`departureHistory` reports what actually happened after this departure at the same position. A previous return without an apple is evidence of no food progress on that recorded traversal, not proof that this direction is impossible or that another direction is safe.",
					},
					criteria: Object.fromEntries(
						directions.map((direction) => [
							direction,
							{
								meaning: base.questions.direction.criteria[direction].meaning,
								chooseWhen: `Choose ${direction} when it is legal and best supports continued maneuvering and eventual food collection in the whole position.`,
								excludeWhen: `Do not choose ${direction} when \`immediateMoves.${direction}.legal\` is false. Its \`blockedBy\` field identifies the collision or illegal reversal.`,
							},
						]),
					) as DecisionRequestV8["questions"]["direction"]["criteria"],
				},
			},
		},
	};
}
export function decisionBodyV8(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
): DecisionRequestV8 {
	return buildGlobalContextV8(state, model, timing, progress).request;
}

/** Budgeted dynamic evidence; JEV still chooses among all four directions. */
export function buildBoundedContextV9(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
	searchOptions?: LocalSearchOptions,
): { request: DecisionRequestV9 } {
	const base = buildGlobalContextV8(state, model, timing, progress).request;
	return {
		request: {
			...base,
			state: {
				...base.state,
				contextVersion: "bounded-search-v9",
				localSearch: searchLocalMoves(state, searchOptions),
			},
			questions: {
				direction: {
					...base.questions.direction,
					instructions: {
						...base.questions.direction.instructions,
						inspect:
							"Compare `immediateMoves`, `observedSpace` and `localSearch.moves` for each direction. Local search simulates the complete moving body with a depth and node budget shared fairly across legal candidates. Witnesses start with the candidate and are verified routes, not orders to follow. For apple routes, `appleExitDirections` lists exact legal exits immediately after growth. An empty list means that particular route eats the apple and is immediately trapped.",
						constraint:
							"Choose a direction legal now. A `proven_dead` candidate has all legal continuations exhausted without a food or budget boundary: it inevitably ends trapped. Prefer a candidate not proven dead when one exists. All four options remain available; make your own final choice.",
						objective:
							"Complete the board while preserving future movement and making food progress. Prefer a verified winning route. Use apple routes that retain exits and limited survival routes as evidence along with the whole board and recorded repetition. Avoid an apple route with no post-growth exit when an alternative retains movement; reaching food alone is not success. Merely surviving a short horizon or repeatedly circling does not achieve the objective. A detour can be better than entering a confined pocket.",
						uncertainty:
							"`apple_reachable` verifies a route to the current apple only; growth and immediate exits are known but the next apple is unknown, so search stops there (`cutoff=apple`). Nonempty appleExitDirections only proves a legal next move, not long-term safety. An empty list condemns that witness endpoint, not every possible route from its first direction. `win_reachable` verifies filling the board. `survival_found` verifies only its witness prefix, not indefinite safety. Depth or node cutoffs leave unexplored futures: `unknown` is neither safe nor dead. A longer witness or more expanded nodes is not a better-move score. `observedSpace` is a frozen occupancy snapshot, not a dynamic safety proof. Search never reads future food or hidden RNG.",
					},
					criteria: Object.fromEntries(
						directions.map((direction) => [
							direction,
							{
								meaning: base.questions.direction.criteria[direction].meaning,
								chooseWhen: `Choose ${direction} when it is legal and its bounded search evidence, whole-board facts and recorded history best support continued movement and food progress.`,
								excludeWhen: `Do not choose ${direction} when immediateMoves.${direction}.legal is false. Avoid it when localSearch.moves.${direction}.status is proven_dead and another legal candidate is not proven dead. A depth/node cutoff is uncertainty, not a death proof.`,
							},
						]),
					) as DecisionRequestV9["questions"]["direction"]["criteria"],
				},
			},
		},
	};
}

export function decisionBodyV9(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
	searchOptions?: LocalSearchOptions,
): DecisionRequestV9 {
	return buildBoundedContextV9(state, model, timing, progress, searchOptions)
		.request;
}

export function buildPostAppleContextV10(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
	searchOptions?: LocalSearchOptions,
): { request: DecisionRequestV10 } {
	const base = buildGlobalContextV8(state, model, timing, progress).request;
	return {
		request: {
			...base,
			state: {
				...base.state,
				contextVersion: "post-apple-v10",
				localSearch: searchPostAppleMoves(state, searchOptions),
			},
			questions: {
				direction: {
					type: "choice",
					instructions: {
						question:
							"Which one direction best preserves the chance to complete the board while making food progress?",
						inspect:
							"Compare immediate legality, bounded dynamic search evidence, current open regions and actual departure history for all four directions. Search shares one node budget across movement and post-apple checks; its total horizon includes both. Witnesses describe checked routes; choose only this next move.",
						constraint:
							"Choose a legal direction. Avoid a proven_dead direction when a legal direction not proven dead exists. Proven death means every explored continuation was exhausted without an unresolved horizon, budget or possible future win: even optimistic future body movement cannot escape. Rejected apple endpoints were proved trapped after growth and the search tried other routes within its remaining budget.",
						objective:
							"Complete the board while making food progress and preserving future movement. Prefer a verified winning route. When apple_reachable candidates exist, prefer one of those over merely wandering along survival_found paths; their known fatal endpoints have already been rejected. Future uncertainty is not itself a reason to keep postponing the same apple. Among apple routes, consider room and actual return-without-apple history. A proven_dead move must not be preferred for a quick reward.",
						uncertainty:
							"After the current apple, the search assumes no further growth. This is an optimistic superset of real movement, not a prediction of the next apple. Survival in this assumption does not guarantee real survival; all outcomes that reach a depth/node limit or could win via future growth remain unproven. postApple.result=unknown is neither safe nor dead. The next apple and hidden RNG are never read. Current open regions freeze the body and are not dynamic safety proofs. Node counts and witness length are not move scores.",
						history: base.questions.direction.instructions.history,
					},
					criteria: Object.fromEntries(
						directions.map((direction) => [
							direction,
							{
								meaning: base.questions.direction.criteria[direction].meaning,
								chooseWhen: `Choose ${direction} when it is legal and its search evidence, available space, food access and real departure history best support eventually completing the board.`,
								excludeWhen: `Do not choose ${direction} if immediateMoves.${direction}.legal is false. Avoid localSearch.moves.${direction}.status=proven_dead when another legal candidate is not proven dead. Unfinished search is not a safety guarantee.`,
							},
						]),
					) as DecisionRequestV10["questions"]["direction"]["criteria"],
				},
			},
		},
	};
}

export function decisionBodyV10(
	state: PublicState,
	model: string = JEV_MODEL,
	timing?: DecisionTiming,
	progress?: DecisionProgress,
	searchOptions?: LocalSearchOptions,
): DecisionRequestV10 {
	return buildPostAppleContextV10(state, model, timing, progress, searchOptions)
		.request;
}
