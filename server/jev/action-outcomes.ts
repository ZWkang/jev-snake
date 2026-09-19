import { isDeepStrictEqual } from "node:util";
import type {
	ActionOutcome,
	AppleRouteOutcome,
	SurvivalOutcome,
} from "../../shared/snake/action-outcomes.js";
import type {
	ActionSummary,
	Direction,
	PublicState,
} from "../../shared/snake/types.js";
import type {
	OpportunitySummary,
	WitnessRecord,
} from "../../shared/snake/witness-context.js";
import { inspectMove } from "../game/engine.js";
import { createDeathAnalyzer, type DeathAnalyzer } from "./branch-death.js";
import { advanceGeometry, staticSpace } from "./context-v3.js";
import { trappedRegion } from "./trap-geometry.js";
import { witnessOrigin } from "./witness-context.js";

const complete = (state: PublicState) =>
	state.snake.length ===
	state.config.width * state.config.height - state.obstacles.length;

function survivalOutcome(
	state: PublicState,
	direction: Direction,
	facts: ActionSummary,
	analyzer: DeathAnalyzer,
): SurvivalOutcome {
	const next = inspectMove(state, direction);
	if (next.immediateCollision)
		return {
			status:
				next.immediateCollision === "reverse"
					? "illegal_reverse"
					: "immediate_collision",
			collision: next.immediateCollision,
			collisionWithinMoves: next.immediateCollision === "reverse" ? null : 1,
			proof: null,
		};
	const after = advanceGeometry(state, direction);
	if (complete(after))
		return {
			status: "board_complete",
			collision: null,
			collisionWithinMoves: null,
			proof: null,
		};
	const base = { collision: null, status: "proven_fatal" as const };
	if (facts.forcedPath?.outcome === "forced_collision")
		return {
			...base,
			collisionWithinMoves: facts.forcedPath.steps,
			proof: "forced_path",
		};
	const region = trappedRegion(after);
	if (region)
		return {
			...base,
			collisionWithinMoves: 1 + region.regionCells,
			proof: "trapped_region",
		};
	const proof = next.eatsApple
		? analyzer.postApple(after)
		: analyzer.continuation(after);
	return proof
		? {
				...base,
				collisionWithinMoves: 1 + proof.collisionWithinMoves,
				proof: next.eatsApple
					? "post_apple_all_continuations"
					: "all_continuations",
			}
		: {
				status: "not_proven_fatal",
				collision: null,
				collisionWithinMoves: null,
				proof: null,
			};
}

function appleOutcome(
	state: PublicState,
	direction: Direction,
	opportunity: OpportunitySummary,
	record: WitnessRecord | undefined,
	analyzer: DeathAnalyzer,
): AppleRouteOutcome {
	if (
		opportunity.status !== "apple_route_found" &&
		opportunity.status !== "apple_eaten_now"
	)
		return {
			status:
				opportunity.status === "initial_collision"
					? "not_applicable"
					: opportunity.status === "exhausted"
						? "exhausted"
						: "unresolved",
			moves: null,
			postApple: null,
		};
	if (!record || record.evidence.status === "non_growth_cycle")
		throw new Error("Apple outcome requires its exact apple witness record");
	const { witness } = record.evidence;
	if (witness.directions[0] !== direction)
		throw new Error("Apple outcome witness starts with a different direction");
	const afterGrowth = { ...state, ...witness.end };
	const moves = witness.directions.length;
	if (complete(afterGrowth))
		return {
			status: "verified_route",
			moves,
			postApple: {
				status: "board_complete",
				postEat: {
					terminal: "board_complete",
					bodyLength: afterGrowth.snake.length,
					staticReachableCells: null,
					relativeToBody: null,
					legalNextMoves: null,
					tailConnection: null,
				},
				collisionWithinMoves: null,
				collisionWithinMovesFromObservation: null,
			},
		};
	// This endpoint belongs to the archived dynamic witness, not the separate
	// static appleRoute or a previous observation's witness. No respawn is read.
	const proof = analyzer.postApple(afterGrowth);
	return {
		status: "verified_route",
		moves,
		postApple: proof
			? {
					status: "proven_fatal",
					postEat: { terminal: "none", ...staticSpace(afterGrowth) },
					collisionWithinMoves: proof.collisionWithinMoves,
					collisionWithinMovesFromObservation:
						moves + proof.collisionWithinMoves,
				}
			: {
					status: "not_proven_fatal",
					postEat: { terminal: "none", ...staticSpace(afterGrowth) },
					collisionWithinMoves: null,
					collisionWithinMovesFromObservation: null,
				},
	};
}

function describe(
	survival: SurvivalOutcome,
	apple: AppleRouteOutcome,
	opportunity: OpportunitySummary,
): string {
	if (survival.status === "illegal_reverse")
		return "Direct reversal is illegal: the engine rejects this action without moving.";
	if (survival.status === "immediate_collision")
		return `This move immediately collides with ${survival.collision} and ends the game.`;
	if (survival.status === "board_complete")
		return "This move eats the apple and completes the board; the game is won immediately.";
	const sentences = [
		survival.status === "proven_fatal"
			? `This move is currently legal, but every continuation collides within ${survival.collisionWithinMoves} moves from this observation, including this move and the collision attempt; board completion before that collision is excluded.`
			: "This move is currently legal. No proof establishes that every continuation is fatal; continued survival and board completion are not guaranteed.",
	];
	if (apple.status === "verified_route") {
		sentences.push(
			`One verified route beginning with this move eats the observed apple in ${apple.moves} moves, including this move.`,
		);
		if (apple.postApple?.status === "board_complete")
			sentences.push("That route completes the board at its apple arrival.");
		else if (apple.postApple?.status === "proven_fatal")
			sentences.push(
				`From that route's exact grown endpoint, every continuation collides within ${apple.postApple.collisionWithinMoves} additional moves (${apple.postApple.collisionWithinMovesFromObservation} total from this observation), before the board can be completed, regardless of the next apple spawn. This endpoint proof applies to this route, not to different routes with the same first move.`,
			);
		else
			sentences.push(
				"For that route's exact grown endpoint, unavoidable death has not been proved; reaching the apple does not establish continued survival or completion.",
			);
		if (survival.status === "proven_fatal")
			sentences.push(
				"Reaching that apple does not remove the fatal conclusion for this first move.",
			);
	} else if (opportunity.status === "non_growth_cycle")
		sentences.push(
			"A verified no-growth cycle exists after this move. Other apple routes were not exhausted; reaching the observed apple remains unresolved. The cycle does not establish food progress or board completion.",
		);
	else
		sentences.push(
			"The reachable known-apple geometries were exhausted without finding an apple-arrival route or a no-growth cycle.",
		);
	return sentences.join(" ");
}

// Read-only facts: every direction receives the same analysis. This module
// neither filters actions nor ranks them, and never controls a future move.
export function actionOutcome(
	state: PublicState,
	direction: Direction,
	facts: ActionSummary,
	opportunity: OpportunitySummary,
	record: WitnessRecord | undefined,
	analyzer: DeathAnalyzer = createDeathAnalyzer(),
): ActionOutcome {
	if (opportunity.witnessId !== null && !record)
		throw new Error("Action outcome is missing its referenced witness record");
	if (record && !isDeepStrictEqual(record.origin, witnessOrigin(state)))
		throw new Error(
			"Action outcome witness belongs to a different observation",
		);
	const survival = survivalOutcome(state, direction, facts, analyzer);
	const appleRoute = appleOutcome(
		state,
		direction,
		opportunity,
		record,
		analyzer,
	);
	return {
		survival,
		appleRoute,
		summary: describe(survival, appleRoute, opportunity),
	};
}
