import {
	scanObservedSpace,
	type ObservedEntries,
	type ObservedSpace,
} from "../../shared/snake/observed-space.js";
import { directions, type PublicState } from "../../shared/snake/types.js";
import { inspectMove } from "../game/engine.js";

export type {
	ObservedRegion,
	ObservedSpace,
	ObservedSpaceMove,
} from "../../shared/snake/observed-space.js";

/** One shared occupancy scan after checking the four actual one-step rules. */
export function observedSpace(state: PublicState): ObservedSpace {
	const entries = Object.fromEntries(
		directions.map((direction) => {
			const move = inspectMove(state, direction);
			return [
				direction,
				{ target: move.target, legal: move.immediateCollision === null },
			];
		}),
	) as ObservedEntries;
	return scanObservedSpace(
		{
			width: state.config.width,
			height: state.config.height,
			body: state.snake,
			obstacles: state.obstacles,
			apple: state.apple,
		},
		entries,
	);
}
