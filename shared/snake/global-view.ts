import type { DecisionRequestV7, ImmediateMoveFacts } from "./local-moves.js";
import type { ObservedSpace } from "./observed-space.js";
import type { Direction } from "./types.js";

export type ImmediateMoveObservation = Omit<
	ImmediateMoveFacts,
	"appleProgress"
>;
export type DecisionRequestV8 = {
	model: string;
	state: Omit<
		DecisionRequestV7["state"],
		"contextVersion" | "immediateMoves"
	> & {
		contextVersion: "global-view-v8";
		immediateMoves: Record<Direction, ImmediateMoveObservation>;
		observedSpace: ObservedSpace;
	};
	questions: DecisionRequestV7["questions"];
};
