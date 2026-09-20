import { expect, test } from "vitest";
import {
	decisionBodyV10 as decisionBody,
	decisionBodyV9,
} from "../server/jev/search-context.js";
import type { DecisionRequestV10 } from "../shared/snake/post-apple-search.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import type { PublicState } from "../shared/snake/types.js";
import cases from "./fixtures/global-view-73882.json";

const state = cases[2].state as PublicState;
const request = () =>
	decisionBody(state, undefined, undefined, undefined, {
		maxDepth: 8,
		maxNodes: 5000,
	});

test("v10 saves bounded post-apple uncertainty and keeps the original v9 contract", () => {
	const v10 = request();
	expect(v10.state.contextVersion).toBe("post-apple-v10");
	expect(v10.state.localSearch.moves.left.postApple).toMatchObject({
		assumption: "no_further_growth",
		result: "survival_possible",
		cutoff: "depth",
		maxDepth: 2,
		maxDepthReached: 2,
	});
	expect(decisionRequestSchema.parse(v10)).toEqual(v10);
	const old = decisionBodyV9(state);
	expect(old.state.contextVersion).toBe("bounded-search-v9");
	expect(old.state.localSearch.moves.left).not.toHaveProperty("postApple");
	expect(decisionRequestSchema.parse(old)).toEqual(old);
});

test.each<[string, (r: DecisionRequestV10) => void]>([
	[
		"unknown assumption",
		(r) =>
			Object.assign(r.state.localSearch.moves.left.postApple!, {
				assumption: "future_food_known",
			}),
	],
	[
		"missing endpoint check",
		(r) => {
			r.state.localSearch.moves.left.postApple = null;
		},
	],
	[
		"adding post budget",
		(r) => {
			r.state.localSearch.moves.left.postAppleExpandedNodes =
				r.state.localSearch.moves.left.expandedNodes + 1;
		},
	],
	[
		"inventing rejected endpoints",
		(r) => {
			r.state.localSearch.moves.left.rejectedAppleEndpoints = 5000;
		},
	],
	[
		"resetting depth after food",
		(r) => {
			r.state.localSearch.moves.left.postApple!.maxDepth = 8;
		},
	],
	[
		"impossible reached depth",
		(r) => {
			r.state.localSearch.moves.left.postApple!.maxDepthReached = 9;
		},
	],
	[
		"unaccounted check nodes",
		(r) => {
			r.state.localSearch.moves.left.postApple!.expandedNodes = 5000;
		},
	],
	[
		"pretending budget exhaustion",
		(r) => {
			Object.assign(r.state.localSearch.moves.left.postApple!, {
				result: "unknown",
				cutoff: "nodes",
			});
		},
	],
	[
		"inventing early victory",
		(r) => {
			Object.assign(r.state.localSearch.moves.left.postApple!, {
				result: "unknown",
				cutoff: "possible_win",
			});
		},
	],
	[
		"unbounded safety claim",
		(r) => {
			Object.assign(r.state.localSearch.moves.left.postApple!, {
				result: "safe",
			});
		},
	],
	[
		"putting endpoint checks on blocked direction",
		(r) => {
			r.state.localSearch.moves.right.postApple =
				r.state.localSearch.moves.left.postApple;
		},
	],
])("rejects %s", (_, mutate) => {
	const value = request();
	mutate(value);
	expect(decisionRequestSchema.safeParse(value).success).toBe(false);
});

test("a spent depth or node budget remains recorded uncertainty", () => {
	for (const maxDepth of [1, 2, 6, 8])
		for (const maxNodes of [0, 1, 5, 20, 5000]) {
			const body = decisionBody(state, undefined, undefined, undefined, {
				maxDepth,
				maxNodes,
			});
			expect(decisionRequestSchema.parse(body)).toEqual(body);
			expect(body.state.localSearch.expandedNodes).toBeLessThanOrEqual(
				maxNodes,
			);
		}
});
