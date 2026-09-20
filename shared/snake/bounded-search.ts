import type { DecisionRequestV8 } from "./global-view.js";
import type { Direction } from "./types.js";

export type LocalSearchOptions = { maxDepth: number; maxNodes: number };
export const DEFAULT_LOCAL_SEARCH_OPTIONS: LocalSearchOptions = {
	maxDepth: 8,
	maxNodes: 5_000,
};
export type LocalSearchMove = {
	status:
		| "blocked"
		| "proven_dead"
		| "apple_reachable"
		| "win_reachable"
		| "survival_found"
		| "unknown";
	expandedNodes: number;
	nodeBudget: number;
	maxDepthReached: number;
	cutoff: "none" | "depth" | "nodes" | "apple";
	/** Verified route starting with this candidate; never a prescribed action. */
	witness: Direction[] | null;
	/** Immediate legal exits after this apple witness grows; never future safety. */
	appleExitDirections: Direction[] | null;
};
export type LocalSearchEvidence = LocalSearchOptions & {
	algorithm: "iterative_deepening_dfs";
	foodBoundary: "stop_at_current_apple";
	expandedNodes: number;
	moves: Record<Direction, LocalSearchMove>;
};
export type DecisionRequestV9 = {
	model: string;
	state: Omit<DecisionRequestV8["state"], "contextVersion"> & {
		contextVersion: "bounded-search-v9";
		localSearch: LocalSearchEvidence;
	};
	questions: DecisionRequestV8["questions"];
};
