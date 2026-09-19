import { isDeepStrictEqual } from "node:util";
import {
	directions,
	type Direction,
	isResponseMode,
	type MatchEvent,
	type MatchState,
} from "../../shared/snake/types.js";
import { GameError } from "../errors.js";
import { createState, expireStar, move } from "../game/engine.js";

const physicalFields = [
	"tick",
	"config",
	"recordVersion",
	"rulesVersion",
	"snake",
	"direction",
	"obstacles",
	"apple",
	"star",
	"score",
	"applesEaten",
] as const;
const movementTypes = new Set(["move", "apple", "star", "won", "gameover"]);

function historyError(seq: number, detail: string): never {
	throw new GameError(
		"invalid_restore_history",
		`Cannot restore match: event ${seq} ${detail}`,
		409,
	);
}

function movementDirection(event: MatchEvent): Direction {
	// Winning events in record versions 1–3 omit direction from their data.
	const direction =
		event.type === "won"
			? event.state.direction
			: event.type === "gameover"
				? event.data.attemptedDirection
				: event.data.direction;
	if (!directions.includes(direction as Direction))
		historyError(event.seq, "has no valid movement direction");
	return direction as Direction;
}

/** Rebuild private RNG state from an exact, complete public event prefix. */
export function restoreMatchAt(
	events: readonly MatchEvent[],
	targetSeq: number,
): MatchState {
	if (!Number.isSafeInteger(targetSeq) || targetSeq < 0)
		throw new GameError(
			"invalid_restore_target",
			"Restore target must be a nonnegative event sequence",
		);
	if (events.length !== targetSeq + 1)
		historyError(targetSeq, "requires the complete prefix from sequence 0");
	const first = events[0];
	if (first.type !== "created")
		historyError(0, "must be the original created event");
	if (
		![1, 2, 3].includes(first.state.recordVersion) ||
		![1, 2, 3].includes(first.state.rulesVersion)
	)
		historyError(0, "uses an unsupported record or rules version");
	const initial = first.state;
	if (initial.status !== "ready" || first.gameTimeMs !== 0)
		historyError(0, "is not an initial ready state");
	let state: MatchState;
	try {
		state = createState(
			initial.id,
			initial.agentName,
			initial.model,
			structuredClone(initial.config),
			initial.createdAt,
		);
	} catch (error) {
		historyError(
			0,
			`cannot recreate the initial state: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	let lastMoveGameTimeMs = 0;
	for (const [index, event] of events.entries()) {
		if (event.seq !== index || event.state.seq !== index)
			historyError(index, "has a missing or inconsistent sequence");
		if (event.matchId !== initial.id || event.state.id !== initial.id)
			historyError(index, "belongs to a different match");
		if (event.tick !== event.state.tick)
			historyError(index, "has inconsistent tick metadata");
		if (
			!Number.isFinite(event.gameTimeMs) ||
			event.gameTimeMs < state.gameTimeMs ||
			event.gameTimeMs !== event.state.gameTimeMs
		)
			historyError(index, "has inconsistent game time");
		state.gameTimeMs = event.gameTimeMs;
		if (movementTypes.has(event.type)) {
			if (state.status !== "running")
				historyError(index, "moves a match that is not running");
			try {
				const result = move(state, movementDirection(event));
				if (result.type !== event.type)
					historyError(index, `replays as ${result.type}, not ${event.type}`);
				if (
					state.status !== event.state.status ||
					state.endReason !== event.state.endReason
				)
					historyError(index, "does not reproduce the movement outcome");
			} catch (error) {
				if (
					error instanceof GameError &&
					error.code === "invalid_restore_history"
				)
					throw error;
				historyError(
					index,
					`cannot replay movement: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			lastMoveGameTimeMs = event.gameTimeMs;
		} else if (event.type === "star_expired") {
			if (!expireStar(state, event.gameTimeMs))
				historyError(index, "does not expire an existing star");
		} else if (index > 0 && event.type === "created") {
			historyError(index, "unexpectedly recreates the match");
		}
		for (const field of physicalFields)
			if (!isDeepStrictEqual(state[field], event.state[field]))
				historyError(index, `does not reproduce ${field}`);
		// Control/lifecycle metadata is recorded, while geometry and RNG are replayed.
		// In particular, forked changes identity metadata/status, not the board.
		state.status = event.state.status;
		state.seq = event.seq;
	}
	const target = events[targetSeq].state;
	if (target.status !== "ready" && target.status !== "running")
		throw new GameError(
			"invalid_restore_target",
			`Cannot resume a ${target.status} event; choose a ready or running event`,
			409,
		);
	const { scheduledActions: _scheduled, ...metadata } = structuredClone(target);
	return {
		...metadata,
		rngState: state.rngState,
		pending: [],
		...(target.config.decisionMode === "two_step_fallback"
			? { plans: [] }
			: {}),
		...(isResponseMode(target.config) ? { lastMoveGameTimeMs } : {}),
	};
}
