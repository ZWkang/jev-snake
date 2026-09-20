import type { AsciiBoard } from "./ascii-board.js";
import type { DecisionRequestV6 } from "./board-context.js";

/** Complete observations for the model to plan from, with no server analysis. */
export type DecisionRequestV11 = {
	model: string;
	state: Omit<DecisionRequestV6["state"], "contextVersion" | "board"> & {
		contextVersion: "model-planning-v11";
		board: DecisionRequestV6["state"]["board"] & { ascii?: AsciiBoard };
		strategyGuide?: string;
	};
	questions: DecisionRequestV6["questions"];
};
