import {
	type DecisionProgress,
	type Direction,
	directions,
	type PublicState,
} from "../../shared/snake/types.js";

type PositionHistory = {
	visits: number;
	lastVisitTick: number;
	previousVisitTick: number | null;
	actions: DecisionProgress["actions"];
	lastDeparture: Direction | null;
};

// A position includes the ordered body and visible rewards, but not clocks or
// score: waiting for a response does not make an otherwise identical visit new.
export function progressPositionKey(state: PublicState): string {
	return JSON.stringify({
		width: state.config.width,
		height: state.config.height,
		obstacles: state.obstacles,
		snake: state.snake,
		direction: state.direction,
		apple: state.apple,
		star: state.star?.point ?? null,
	});
}

function emptyActions(): DecisionProgress["actions"] {
	return Object.fromEntries(
		directions.map((direction) => [
			direction,
			{ timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
		]),
	) as DecisionProgress["actions"];
}

/** Accumulates committed observations; it never predicts or selects a move. */
export class ProgressHistory {
	private positions = new Map<string, PositionHistory>();
	private throughTick: number | null = null;
	private currentKey: string | null = null;
	private applesEaten = 0;
	private lastAppleTick = 0;

	observe(state: PublicState): void {
		const tick = state.tick;
		if (this.throughTick === null) {
			if (tick !== 0) throw new Error("Progress history must begin at tick 0");
		} else if (tick < this.throughTick || tick > this.throughTick + 1) {
			throw new Error(
				`Progress history tick sequence is incomplete: ${this.throughTick} -> ${tick}`,
			);
		}
		if (state.applesEaten < this.applesEaten)
			throw new Error("Progress history apple count moved backwards");

		if (this.throughTick !== null && tick > this.throughTick) {
			const previous = this.positions.get(this.currentKey as string);
			if (!previous)
				throw new Error("Progress history current position is missing");
			// A fatal attempt advances the engine tick but does not move the body.
			// Every successful move counts, including coast and fallback execution.
			if (state.status !== "gameover") {
				const action = previous.actions[state.direction];
				action.timesTaken++;
				action.lastTakenTick = tick;
				previous.lastDeparture = state.direction;
			}
		}

		if (state.applesEaten > this.applesEaten) {
			this.positions.clear();
			this.lastAppleTick = tick;
		}
		this.applesEaten = state.applesEaten;
		this.throughTick = tick;
		this.currentKey = progressPositionKey(state);
		const position = this.positions.get(this.currentKey);
		if (!position) {
			this.positions.set(this.currentKey, {
				visits: 1,
				lastVisitTick: tick,
				previousVisitTick: null,
				actions: emptyActions(),
				lastDeparture: null,
			});
		} else if (position.lastVisitTick < tick && state.status !== "gameover") {
			position.visits++;
			position.previousVisitTick = position.lastVisitTick;
			position.lastVisitTick = tick;
			if (position.lastDeparture !== null) {
				position.actions[position.lastDeparture].returnsWithoutApple++;
				// Duplicate events at this tick cannot charge this departure again.
				position.lastDeparture = null;
			}
		}
	}

	snapshot(state: PublicState): DecisionProgress {
		if (
			this.throughTick !== state.tick ||
			this.currentKey !== progressPositionKey(state) ||
			this.applesEaten !== state.applesEaten
		)
			throw new Error("Progress history does not match the observed state");
		const position = this.positions.get(this.currentKey);
		if (!position)
			throw new Error("Progress history current position is missing");
		return {
			historyVersion: "progress-v1",
			historyStartTick: 0,
			throughTick: this.throughTick,
			lastAppleTick: this.lastAppleTick,
			movesSinceApple: this.throughTick - this.lastAppleTick,
			positionVisits: position.visits,
			previousVisitTick: position.previousVisitTick,
			repeatAfterMoves:
				position.previousVisitTick === null
					? null
					: this.throughTick - position.previousVisitTick,
			actions: structuredClone(position.actions),
		};
	}
}
