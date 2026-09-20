import { z } from "zod";
import { decisionRequestV9Schema } from "./context-v9-schema.js";
import { directions } from "./types.js";

const integer = z.number().int().nonnegative();
const priorSearch = decisionRequestV9Schema.shape.state.shape.localSearch;
const priorMove = priorSearch.shape.moves.valueType;
const postApple = z
	.object({
		assumption: z.literal("no_further_growth"),
		result: z.enum(["survival_possible", "unknown"]),
		maxDepth: integer,
		maxDepthReached: integer,
		expandedNodes: integer,
		cutoff: z.enum(["depth", "nodes", "possible_win"]),
	})
	.strict();
const localSearch = priorSearch
	.extend({
		algorithm: z.literal("iterative_deepening_with_post_apple"),
		foodBoundary: z.literal("optimistic_no_growth_after_apple"),
		moves: z.record(
			z.enum(directions),
			priorMove
				.extend({
					postApple: postApple.nullable(),
					rejectedAppleEndpoints: integer,
					postAppleExpandedNodes: integer,
				})
				.strict(),
		),
	})
	.strict();

export const decisionRequestV10Schema = z
	.object({
		model: z.string().min(1),
		state: z
			.object({
				...decisionRequestV9Schema.shape.state.shape,
				contextVersion: z.literal("post-apple-v10"),
				localSearch,
			})
			.strict()
			.superRefine((value, context) => {
				if (context.issues.length) return;
				const search = value.localSearch;
				// Validate the unchanged observed board and the real, pre-apple witness
				// using the historical contract. Never rerun a search while parsing records.
				const base = decisionRequestV9Schema.shape.state.safeParse({
					...value,
					contextVersion: "bounded-search-v9",
					localSearch: {
						...search,
						algorithm: "iterative_deepening_dfs",
						foodBoundary: "stop_at_current_apple",
						moves: Object.fromEntries(
							directions.map((direction) => {
								const {
									postApple: _post,
									rejectedAppleEndpoints: _rejected,
									postAppleExpandedNodes: _nodes,
									...move
								} = search.moves[direction];
								return [direction, move];
							}),
						),
					},
				});
				if (!base.success) {
					for (const issue of base.error.issues) context.addIssue({ ...issue });
					return;
				}
				for (const direction of directions) {
					const move = search.moves[direction];
					const require = (
						condition: boolean,
						field: string,
						message: string,
					) => {
						if (!condition)
							context.addIssue({
								code: "custom",
								path: ["localSearch", "moves", direction, field],
								message,
							});
					};
					require(move.postAppleExpandedNodes <=
						move.expandedNodes, "postAppleExpandedNodes", "Post-apple nodes are included in the original node budget");
					require(move.rejectedAppleEndpoints <=
						move.expandedNodes -
							move.postAppleExpandedNodes, "rejectedAppleEndpoints", "Each rejected endpoint needs a real pre-apple visit");
					if (move.status !== "apple_reachable") {
						require(move.postApple ===
							null, "postApple", "Only a saved apple witness has an endpoint check");
						continue;
					}
					const post = move.postApple;
					require(post !==
						null, "postApple", "Apple witnesses must record their limited post-growth check");
					if (!post || !move.witness) continue;
					require(post.maxDepth ===
						search.maxDepth -
							move.witness
								.length, "postApple", "Post-apple depth uses the remainder of the original horizon");
					require(post.expandedNodes <=
						move.postAppleExpandedNodes, "postApple", "Endpoint check nodes must be part of the aggregated post-apple count");
					require(post.maxDepthReached <=
						Math.min(post.maxDepth, post.expandedNodes) &&
						(post.expandedNodes === 0) ===
							(post.maxDepthReached ===
								0), "postApple", "Reached depth must match expanded post-apple nodes");
					require(move.maxDepthReached >=
						move.witness.length +
							post.maxDepthReached, "postApple", "The overall depth includes the post-apple check");
					const remainingGrowth =
						value.board.width * value.board.height -
						value.board.obstacles.length -
						value.player.bodyHeadToTail.length -
						1;
					if (post.cutoff === "nodes") {
						require(post.result === "unknown" &&
							move.expandedNodes ===
								move.nodeBudget, "postApple", "A node cutoff is unknown and exhausts the shared candidate budget");
					} else if (post.cutoff === "possible_win") {
						require(post.result === "unknown" &&
							post.maxDepthReached === remainingGrowth &&
							remainingGrowth >
								0, "postApple", "Possible future winning growth prevents a death proof");
					} else {
						require(post.maxDepthReached === post.maxDepth &&
							(post.maxDepth === 0
								? post.result === "unknown"
								: post.result ===
									"survival_possible"), "postApple", "A depth boundary proves at most optimistic survival to that depth");
					}
				}
			}),
		questions: decisionRequestV9Schema.shape.questions,
	})
	.strict();
