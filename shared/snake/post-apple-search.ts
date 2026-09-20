import type {
	DecisionRequestV9,
	LocalSearchEvidence,
	LocalSearchMove,
	LocalSearchOptions,
} from "./bounded-search.js";
import type { Direction } from "./types.js";

export const DEFAULT_POST_APPLE_SEARCH_OPTIONS: LocalSearchOptions = {
	maxDepth: 32,
	maxNodes: 5_000,
};

export type PostAppleCheck = {
	assumption: "no_further_growth";
	result: "survival_possible" | "unknown";
	maxDepth: number;
	maxDepthReached: number;
	expandedNodes: number;
	cutoff: "depth" | "nodes" | "possible_win";
};
export type PostAppleSearchMove = LocalSearchMove & {
	postApple: PostAppleCheck | null;
	/** Counts visits, including repeated iterations, not unique endpoints. */
	rejectedAppleEndpoints: number;
	/** Included in expandedNodes, never an additional node allowance. */
	postAppleExpandedNodes: number;
};
export type PostAppleSearchEvidence = Omit<
	LocalSearchEvidence,
	"algorithm" | "foodBoundary" | "moves"
> & {
	algorithm: "iterative_deepening_with_post_apple";
	foodBoundary: "optimistic_no_growth_after_apple";
	moves: Record<Direction, PostAppleSearchMove>;
};
export type DecisionRequestV10 = {
	model: string;
	state: Omit<DecisionRequestV9["state"], "contextVersion" | "localSearch"> & {
		contextVersion: "post-apple-v10";
		localSearch: PostAppleSearchEvidence;
	};
	questions: DecisionRequestV9["questions"];
};
