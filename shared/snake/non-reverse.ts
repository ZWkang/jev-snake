import type { DecisionRequestV11 } from "./model-planning.js";
import type { Direction } from "./types.js";

/** Direct reversal is omitted; all other choices remain model decisions. */
export type DecisionRequestV12 = {
	model: string;
	state: Omit<DecisionRequestV11["state"], "contextVersion"> & {
		contextVersion: "non-reverse-v12";
	};
	questions: {
		direction: Omit<
			DecisionRequestV11["questions"]["direction"],
			"criteria"
		> & {
			criteria: Partial<Record<Direction, { meaning: string }>>;
		};
	};
};
