import { createHash } from "node:crypto";
import {
	directions,
	type Direction,
	type PublicState,
} from "../../shared/snake/types.js";
import type {
	OpportunitySummary,
	WitnessArchive,
	WitnessContinuity,
	WitnessOrigin,
	WitnessRecord,
} from "../../shared/snake/witness-context.js";
import { inspectMove } from "../game/engine.js";
import { advanceGeometry, staticSpace } from "./context-v3.js";
import { analyzePositiveEvidence } from "./positive-evidence.js";

export function witnessOrigin(state: PublicState): WitnessOrigin {
	return structuredClone({
		width: state.config.width,
		height: state.config.height,
		obstacles: state.obstacles,
		rulesVersion: state.rulesVersion,
		tick: state.tick,
		snake: state.snake,
		direction: state.direction,
		apple: state.apple,
	});
}
export function witnessDirections(record: WitnessRecord): Direction[] {
	const evidence = record.evidence;
	return evidence.status === "non_growth_cycle"
		? [
				...evidence.witness.prefixDirections,
				...evidence.witness.cycleDirections,
			]
		: evidence.witness.directions;
}
export function opportunityFacts(
	state: PublicState,
	archive: WitnessArchive,
	basis: WitnessRecord["basis"] = "observed",
): Record<Direction, OpportunitySummary> {
	return Object.fromEntries(
		directions.map((direction) => {
			const evidence = analyzePositiveEvidence(state, direction);
			const base: OpportunitySummary = {
				status: evidence.status,
				witnessId: null,
				moves: null,
				appleTarget: null,
				endEvent: "none",
				cycle: null,
				releasePassages: [],
				scope: "none",
				postEat: null,
			};
			if (!("witness" in evidence)) return [direction, base];
			const record: WitnessRecord = {
				basis,
				origin: witnessOrigin(state),
				evidence,
			};
			const id = createHash("sha256")
				.update(JSON.stringify(record))
				.digest("hex");
			archive.records[id] = record;
			const cycle = evidence.status === "non_growth_cycle";
			return [
				direction,
				{
					...base,
					witnessId: id,
					moves: witnessDirections(record).length,
					appleTarget: cycle ? null : state.apple,
					endEvent:
						evidence.status === "non_growth_cycle"
							? "cycle_completed"
							: evidence.terminal === "board_complete"
								? "board_complete"
								: "apple_eaten",
					cycle: cycle
						? {
								prefixMoves: evidence.witness.prefixDirections.length,
								period: evidence.witness.cycleDirections.length,
							}
						: null,
					releasePassages: evidence.witness.releasePassages,
					scope: cycle ? "no_growth_cycle" : "observed_apple_only",
					postEat: cycle
						? null
						: evidence.terminal === "board_complete"
							? {
									terminal: "board_complete",
									bodyLength: evidence.witness.end.snake.length,
									staticReachableCells: null,
									relativeToBody: null,
									legalNextMoves: null,
									tailConnection: null,
								}
							: {
									terminal: "none",
									...staticSpace({ ...state, ...evidence.witness.end }),
								},
				} satisfies OpportunitySummary,
			];
		}),
	) as Record<Direction, OpportunitySummary>;
}

// Counterfactual state compatibility only: different actual routes can converge
// on the same ordered-body geometry. Retain the source records for audit, never
// infer a model commitment or a history of actions from a matching endpoint.
export function witnessContinuity(
	state: PublicState,
	targetArchive?: WitnessArchive,
): WitnessContinuity[] {
	const archive = state.lastDecision?.evidence;
	if (!archive) return [];
	const result: WitnessContinuity[] = [];
	const remainingWitnesses = new Set<string>();
	for (const [witnessId, record] of Object.entries(archive.records)) {
		if (record.basis !== "observed") continue;
		const origin = record.origin;
		const stateCompatibleAfterMoves = state.tick - origin.tick;
		const route = witnessDirections(record);
		if (
			stateCompatibleAfterMoves <= 0 ||
			stateCompatibleAfterMoves >= route.length
		)
			continue;
		if (
			origin.width !== state.config.width ||
			origin.height !== state.config.height ||
			origin.rulesVersion !== state.rulesVersion ||
			JSON.stringify(origin.obstacles) !== JSON.stringify(state.obstacles)
		)
			continue;
		let projected: PublicState = {
			...state,
			snake: structuredClone(origin.snake),
			direction: origin.direction,
			apple: origin.apple,
			star: null,
		};
		for (const direction of route.slice(0, stateCompatibleAfterMoves)) {
			if (inspectMove(projected, direction).immediateCollision)
				throw new Error(
					`Stored witness ${witnessId} contains an invalid prefix`,
				);
			projected = advanceGeometry(projected, direction);
		}
		if (
			projected.direction !== state.direction ||
			JSON.stringify(projected.snake) !== JSON.stringify(state.snake) ||
			JSON.stringify(projected.apple) !== JSON.stringify(state.apple)
		)
			continue;
		const cycle = record.evidence.status === "non_growth_cycle";
		const continuity: WitnessContinuity = {
			witnessId,
			originTick: origin.tick,
			stateCompatibleAfterMoves,
			remainingMoves: route.length - stateCompatibleAfterMoves,
			nextDirection: route[stateCompatibleAfterMoves],
			opportunityStatus: record.evidence.status,
			appleTarget: cycle ? null : structuredClone(origin.apple),
			scope: cycle ? "no_growth_cycle" : "observed_apple_only",
			endEvent:
				record.evidence.status === "non_growth_cycle"
					? "cycle_completed"
					: record.evidence.terminal === "board_complete"
						? "board_complete"
						: "apple_eaten",
		};
		// Identical remaining routes and endpoint semantics are duplicate facts,
		// irrespective of discovery time. This does not rank candidate actions.
		const signature = JSON.stringify([
			route.slice(stateCompatibleAfterMoves),
			continuity.opportunityStatus,
			continuity.appleTarget,
			continuity.scope,
			continuity.endEvent,
		]);
		if (remainingWitnesses.has(signature)) continue;
		remainingWitnesses.add(signature);
		if (targetArchive)
			targetArchive.records[witnessId] = structuredClone(record);
		result.push(continuity);
	}
	return result;
}
