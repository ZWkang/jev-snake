import { z } from "zod";
import { decisionRequestV13Schema } from "./context-v13-schema.js";
import { dynamicStaticSemantics } from "./dynamic-space-analysis.js";
import {
	describeGrowthSpaceMove,
	growthSpaceSemantics,
} from "./growth-space-analysis.js";
import { legalSpaceSemantics } from "./legal-space-analysis.js";
import { directions } from "./types.js";

const integer = z.number().int().nonnegative();
const positive = integer.positive();
const trapSchema = z
	.object({
		status: z.enum([
			"proven_trap",
			"horizon_reached",
			"optimistic_horizon_reached",
			"unknown_near_win",
			"node_limit",
			"board_complete",
		]),
		moves: positive.nullable(),
		exploredNodes: integer,
	})
	.strict();
const postAppleSchema = z
	.object({
		status: z.enum([
			"proven_trap",
			"optimistic_horizon_reached",
			"unknown_near_win",
			"node_limit",
		]),
		moves: integer.nullable(),
		exploredNodes: integer,
	})
	.strict();
const appleSchema = z
	.object({
		status: z.enum([
			"route_with_optimistic_continuation",
			"route_postcheck_unknown",
			"route_wins",
			"no_qualifying_route_found",
			"no_apple",
		]),
		moves: positive.nullable(),
		nextLegalMoveCount: integer.max(3).nullable(),
		canReachTail: z.boolean().nullable(),
		exploredNodes: integer,
		termination: z.enum([
			"found",
			"exhausted",
			"depth_limit",
			"node_limit",
			"postcheck_node_limit",
			"not_applicable",
		]),
		postApple: postAppleSchema.nullable(),
		postAppleNodes: integer,
		rejectedTrapArrivals: integer,
	})
	.strict();

// This archive contract checks necessary consistency, not dynamic proof truth.
// Replay/SSR must not rerun either route search or the shared post-apple search.
export const decisionRequestV15Schema = z
	.object({
		model: z.string().min(1),
		state: z
			.object({
				...decisionRequestV13Schema.shape.state.shape,
				contextVersion: z.literal("growth-space-v15"),
				factsSemantics: z.literal(dynamicStaticSemantics),
				analysisLimits: z
					.object({
						trapDepth: positive,
						appleDepth: positive,
						postAppleDepth: positive,
						maxNodesPerSearch: positive,
					})
					.strict(),
				dynamicSemantics: z.literal(growthSpaceSemantics),
				dynamicFacts: z.partialRecord(
					z.enum(directions),
					z.object({ trap: trapSchema, apple: appleSchema }).strict(),
				),
			})
			.strict()
			.superRefine((value, context) => {
				if (context.issues.length) return;
				const {
					analysisLimits: limits,
					dynamicFacts,
					dynamicSemantics: _semantics,
					...staticState
				} = value;
				const staticResult = decisionRequestV13Schema.shape.state.safeParse({
					...staticState,
					contextVersion: "legal-space-v13",
					factsSemantics: legalSpaceSemantics,
				});
				if (!staticResult.success) {
					for (const issue of staticResult.error.issues)
						context.addIssue({ ...issue });
					return;
				}
				const freeAfterApple =
					value.board.width * value.board.height -
					value.board.obstacles.length -
					value.player.bodyHeadToTail.length -
					1;
				for (const direction of directions) {
					const facts = dynamicFacts[direction];
					const immediate = value.moveFacts[direction];
					const issue = (path: (string | number)[], message: string) =>
						context.addIssue({
							code: "custom",
							path: ["dynamicFacts", direction, ...path],
							message,
						});
					if (!!facts !== !!immediate) {
						issue(
							[],
							"Growth facts must contain exactly the legal first directions",
						);
						continue;
					}
					if (!facts || !immediate) continue;
					const { trap, apple } = facts;
					for (const kind of ["trap", "apple"] as const) {
						const result = facts[kind];
						const depth =
							kind === "trap" ? limits.trapDepth : limits.appleDepth;
						if (
							result.moves !== null &&
							(result.moves > depth || result.moves > result.exploredNodes)
						)
							issue(
								[kind, "moves"],
								"Move count must fit the recorded depth and inspected positions",
							);
						if (result.exploredNodes > limits.maxNodesPerSearch)
							issue(
								[kind, "exploredNodes"],
								"Search exceeds its recorded node budget",
							);
					}
					if (
						trap.status === "node_limit" ||
						trap.status === "unknown_near_win"
					) {
						if (trap.moves !== null || trap.exploredNodes === 0)
							issue(
								["trap"],
								"A node-limited result is unknown and has no death distance",
							);
					} else if (trap.moves === null || trap.exploredNodes === 0)
						issue(
							["trap"],
							"A completed trap result requires its inspected continuation length",
						);
					if (
						(trap.status === "horizon_reached" ||
							trap.status === "optimistic_horizon_reached") &&
						trap.moves !== limits.trapDepth
					)
						issue(
							["trap", "moves"],
							"A horizon result must reach the recorded depth",
						);
					if (
						trap.status === "optimistic_horizon_reached" &&
						(immediate.appleDistance === null ||
							trap.moves === null ||
							trap.moves < immediate.appleDistance + 1)
					)
						issue(
							["trap"],
							"Post-growth assumptions require reaching the observed apple first",
						);
					if (
						trap.status === "unknown_near_win" &&
						(freeAfterApple <= 0 ||
							immediate.appleDistance === null ||
							freeAfterApple > limits.trapDepth - immediate.appleDistance - 1)
					)
						issue(
							["trap"],
							"A near-win uncertainty requires enough remaining moves to possibly fill the board",
						);
					if (immediate.eatsApple && trap.status === "horizon_reached")
						issue(
							["trap", "status"],
							"An already-grown continuation must expose its no-future-growth assumption",
						);
					if (apple.postAppleNodes > limits.maxNodesPerSearch)
						issue(
							["apple", "postAppleNodes"],
							"All arrival checks share one recorded post-apple budget",
						);
					if (
						apple.rejectedTrapArrivals > apple.postAppleNodes ||
						apple.rejectedTrapArrivals > apple.exploredNodes
					)
						issue(
							["apple", "rejectedTrapArrivals"],
							"Rejected arrivals require inspected arrival and post-check positions",
						);
					const post = apple.postApple;
					if (post) {
						if (
							post.exploredNodes + apple.rejectedTrapArrivals >
							apple.postAppleNodes
						)
							issue(
								["apple", "postApple", "exploredNodes"],
								"Selected and rejected arrival checks cannot exceed the shared consumed budget",
							);
						if (
							post.status === "node_limit" ||
							post.status === "unknown_near_win"
						) {
							if (post.moves !== null)
								issue(
									["apple", "postApple", "moves"],
									"Exhausted post-check budget cannot provide a death or survival distance",
								);
							if (
								post.status === "unknown_near_win" &&
								(post.exploredNodes === 0 ||
									freeAfterApple <= 0 ||
									freeAfterApple > limits.postAppleDepth)
							)
								issue(
									["apple", "postApple"],
									"Near-win uncertainty needs inspected positions and a possible additional-growth win within the window",
								);
						} else {
							if (
								post.moves === null ||
								post.moves > limits.postAppleDepth ||
								post.exploredNodes < post.moves + 1
							)
								issue(
									["apple", "postApple"],
									"Post-check moves exclude the inspected arrival root and must fit the recorded horizon",
								);
							if (
								post.status === "optimistic_horizon_reached" &&
								post.moves !== limits.postAppleDepth
							)
								issue(
									["apple", "postApple", "moves"],
									"An optimistic post-check must reach its complete window",
								);
						}
					}
					const strongRoute =
						apple.status === "route_with_optimistic_continuation";
					const unknownRoute = apple.status === "route_postcheck_unknown";
					const winningRoute = apple.status === "route_wins";
					const hasArrival = strongRoute || unknownRoute || winningRoute;
					if (apple.status === "no_apple") {
						if (
							value.food.apple !== null ||
							apple.moves !== null ||
							apple.nextLegalMoveCount !== null ||
							apple.canReachTail !== null ||
							apple.exploredNodes !== 0 ||
							apple.termination !== "not_applicable" ||
							post !== null ||
							apple.postAppleNodes !== 0 ||
							apple.rejectedTrapArrivals !== 0
						)
							issue(
								["apple"],
								"No-apple analysis is inapplicable and contains no route or post-check work",
							);
					} else if (value.food.apple === null)
						issue(
							["apple", "status"],
							"There is no observed apple to search for",
						);
					else if (apple.status === "no_qualifying_route_found") {
						if (
							apple.moves !== null ||
							apple.nextLegalMoveCount !== null ||
							apple.canReachTail !== null ||
							post !== null ||
							apple.exploredNodes === 0 ||
							![
								"exhausted",
								"depth_limit",
								"node_limit",
								"postcheck_node_limit",
							].includes(apple.termination)
						)
							issue(
								["apple"],
								"No qualifying route cannot retain a successful arrival or post-check",
							);
					} else {
						if (apple.moves === null || apple.exploredNodes === 0)
							issue(
								["apple"],
								"A retained arrival requires its route length and inspected positions",
							);
						if ((strongRoute || winningRoute) && apple.termination !== "found")
							issue(
								["apple", "termination"],
								"Only a found winning or checked continuation is a successful search",
							);
						if (
							unknownRoute &&
							![
								"exhausted",
								"depth_limit",
								"node_limit",
								"postcheck_node_limit",
							].includes(apple.termination)
						)
							issue(
								["apple", "termination"],
								"A retained unknown arrival must expose why stronger validation stopped",
							);
						if (winningRoute) {
							if (
								apple.nextLegalMoveCount !== null ||
								apple.canReachTail !== null ||
								post !== null
							)
								issue(
									["apple"],
									"A win has no subsequent exit or post-apple check",
								);
						} else {
							if (
								apple.nextLegalMoveCount === null ||
								apple.nextLegalMoveCount === 0 ||
								apple.canReachTail === null
							)
								issue(
									["apple"],
									"A retained arrival must include positive immediate exits and its tail observation",
								);
							if (
								strongRoute &&
								(apple.nextLegalMoveCount === 0 ||
									post?.status !== "optimistic_horizon_reached")
							)
								issue(
									["apple"],
									"A qualifying route needs a full optimistic continuation, not merely one exit",
								);
							if (
								unknownRoute &&
								post?.status !== "unknown_near_win" &&
								post?.status !== "node_limit"
							)
								issue(
									["apple", "postApple"],
									"Unknown route checks cannot be promoted to a checked continuation",
								);
						}
					}
					const arrivalDistance = (
						kind: "trap" | "apple",
						moves: number | null,
					) => {
						if (
							moves === null ||
							immediate.appleDistance === null ||
							moves < immediate.appleDistance + 1 ||
							(moves - immediate.appleDistance - 1) % 2 !== 0
						)
							issue(
								[kind, "moves"],
								"Arrival length must respect the first move and grid distance",
							);
					};
					if (hasArrival) arrivalDistance("apple", apple.moves);
					if (trap.status === "board_complete")
						arrivalDistance("trap", trap.moves);
					if (
						(winningRoute || trap.status === "board_complete") &&
						freeAfterApple !== 0
					)
						issue(
							[],
							"Only an actual board-filling current apple can claim a win",
						);
					if ((strongRoute || unknownRoute) && freeAfterApple === 0)
						issue(
							["apple", "status"],
							"An arrival that fills the board must be a win",
						);
					if (
						trap.status === "proven_trap" &&
						(winningRoute ||
							(strongRoute &&
								apple.moves !== null &&
								post?.moves !== null &&
								post?.moves !== undefined &&
								trap.moves !== null &&
								apple.moves + post.moves > trap.moves))
					)
						issue(
							[],
							"A complete trap proof contradicts a known longer continuation or win",
						);
					if (
						trap.status === "proven_trap" &&
						trap.moves === 1 &&
						immediate.nextLegalMoveCount !== 0
					)
						issue(
							["trap", "moves"],
							"A one-move trap contradicts legal next moves",
						);
					if (
						trap.status === "proven_trap" &&
						immediate.eatsApple &&
						trap.moves !== null &&
						freeAfterApple > 0 &&
						freeAfterApple <= trap.moves - 1
					)
						issue(
							["trap"],
							"A first-step growth proof must exclude a possible earlier completion from extra growth",
						);
					if (immediate.terminal === "board_complete") {
						if (
							trap.status !== "board_complete" ||
							trap.moves !== 1 ||
							trap.exploredNodes !== 1 ||
							!winningRoute ||
							apple.moves !== 1 ||
							apple.exploredNodes !== 1
						)
							issue(
								[],
								"Both searches must identify an immediate win at their first position",
							);
					} else if (immediate.nextLegalMoveCount === 0) {
						if (
							trap.status !== "proven_trap" ||
							trap.moves !== 1 ||
							trap.exploredNodes !== 1
						)
							issue(
								["trap"],
								"No legal next move is an immediate exhaustive trap",
							);
					} else if (immediate.eatsApple && hasArrival) {
						if (
							apple.moves !== 1 ||
							apple.nextLegalMoveCount !== immediate.nextLegalMoveCount ||
							apple.canReachTail !== immediate.canReachTail
						)
							issue(
								["apple"],
								"A first-step apple arrival must retain its actual one-step geometry",
							);
					}
				}
			}),
		questions: decisionRequestV13Schema.shape.questions,
	})
	.strict()
	.superRefine((value, context) => {
		if (context.issues.length) return;
		for (const direction of directions) {
			const immediate = value.state.moveFacts[direction];
			const growth = value.state.dynamicFacts[direction];
			const expected =
				immediate && growth
					? describeGrowthSpaceMove(direction, immediate, growth)
					: undefined;
			if (value.questions.direction.criteria[direction] !== expected)
				context.addIssue({
					code: "custom",
					path: ["questions", "direction", "criteria", direction],
					message: "Criteria must describe exactly the archived growth facts",
				});
		}
	});
