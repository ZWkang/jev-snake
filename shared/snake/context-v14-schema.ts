import { z } from "zod";
import { decisionRequestV13Schema } from "./context-v13-schema.js";
import {
	describeDynamicSpaceMove,
	dynamicSpaceSemantics,
	dynamicStaticSemantics,
} from "./dynamic-space-analysis.js";
import { legalSpaceSemantics } from "./legal-space-analysis.js";
import { directions } from "./types.js";

const integer = z.number().int().nonnegative();
const positive = integer.positive();
const trapSchema = z
	.object({
		status: z.enum([
			"proven_trap",
			"horizon_reached",
			"unknown_after_apple",
			"node_limit",
			"board_complete",
		]),
		moves: positive.nullable(),
		exploredNodes: integer,
	})
	.strict();
const appleSchema = z
	.object({
		status: z.enum([
			"route_with_exit",
			"route_wins",
			"no_route_with_exit_found",
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
			"not_applicable",
		]),
	})
	.strict();

// Archive validation checks the contract and one-step facts, not the search proof.
// Never rerun dynamic searches while parsing every event during replay/SSR.
export const decisionRequestV14Schema = z
	.object({
		model: z.string().min(1),
		state: z
			.object({
				...decisionRequestV13Schema.shape.state.shape,
				contextVersion: z.literal("dynamic-space-v14"),
				factsSemantics: z.literal(dynamicStaticSemantics),
				analysisLimits: z
					.object({
						trapDepth: positive,
						appleDepth: positive,
						maxNodesPerSearch: positive,
					})
					.strict(),
				dynamicSemantics: z.literal(dynamicSpaceSemantics),
				dynamicFacts: z.partialRecord(
					z.enum(directions),
					z.object({ trap: trapSchema, apple: appleSchema }).strict(),
				),
			})
			.strict()
			.superRefine((value, context) => {
				if (context.issues.length) return;
				const {
					analysisLimits,
					dynamicSemantics: _semantics,
					dynamicFacts,
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
				for (const direction of directions) {
					const dynamic = dynamicFacts[direction];
					const immediate = value.moveFacts[direction];
					const issue = (path: (string | number)[], message: string) =>
						context.addIssue({
							code: "custom",
							path: ["dynamicFacts", direction, ...path],
							message,
						});
					if (!!dynamic !== !!immediate) {
						issue([], "Dynamic facts must contain exactly the legal moves");
						continue;
					}
					if (!dynamic || !immediate) continue;
					for (const kind of ["trap", "apple"] as const) {
						const facts = dynamic[kind];
						const limit =
							kind === "trap"
								? analysisLimits.trapDepth
								: analysisLimits.appleDepth;
						if (facts.moves !== null && facts.moves > limit)
							issue(
								[kind, "moves"],
								"Moves must remain within this search horizon",
							);
						if (facts.exploredNodes > analysisLimits.maxNodesPerSearch)
							issue(
								[kind, "exploredNodes"],
								"Explored nodes exceed the recorded search budget",
							);
						if (facts.moves !== null && facts.moves > facts.exploredNodes)
							issue(
								[kind, "exploredNodes"],
								"A reported continuation must inspect at least its own positions",
							);
					}
					const { trap, apple } = dynamic;
					if (trap.status === "node_limit") {
						if (trap.moves !== null || trap.exploredNodes === 0)
							issue(
								["trap"],
								"A node limit is unknown, with no death distance and inspected nodes",
							);
					} else if (trap.moves === null || trap.exploredNodes === 0) {
						issue(
							["trap"],
							"A completed trap result requires a move count and visited nodes",
						);
					}
					if (
						trap.status === "horizon_reached" &&
						trap.moves !== analysisLimits.trapDepth
					)
						issue(
							["trap", "moves"],
							"A horizon result must reach the recorded depth",
						);
					if (apple.status === "no_apple") {
						if (
							value.food.apple !== null ||
							apple.termination !== "not_applicable" ||
							apple.moves !== null ||
							apple.nextLegalMoveCount !== null ||
							apple.canReachTail !== null ||
							apple.exploredNodes !== 0
						)
							issue(
								["apple"],
								"No-apple analysis must be inapplicable and contain no route facts",
							);
					} else if (value.food.apple === null) {
						issue(
							["apple", "status"],
							"No observed apple is available to search for",
						);
					} else if (apple.status === "no_route_with_exit_found") {
						if (
							!["exhausted", "depth_limit", "node_limit"].includes(
								apple.termination,
							) ||
							apple.moves !== null ||
							apple.nextLegalMoveCount !== null ||
							apple.canReachTail !== null ||
							apple.exploredNodes === 0
						)
							issue(
								["apple"],
								"Unsuccessful bounded search cannot supply a route or claim inapplicability",
							);
					} else {
						if (
							apple.termination !== "found" ||
							apple.moves === null ||
							apple.exploredNodes === 0
						)
							issue(
								["apple"],
								"A route result must be found within the recorded search",
							);
						if (apple.status === "route_wins") {
							if (
								apple.nextLegalMoveCount !== null ||
								apple.canReachTail !== null
							)
								issue(
									["apple"],
									"A winning route has no post-win exit or tail estimate",
								);
						} else if (
							apple.nextLegalMoveCount === null ||
							apple.nextLegalMoveCount === 0 ||
							apple.canReachTail === null
						) {
							issue(
								["apple"],
								"A route with an exit requires a positive next-move count and a tail observation",
							);
						}
					}
					const reachesApple =
						trap.status === "unknown_after_apple" ||
						trap.status === "board_complete";
					const foundApple =
						apple.status === "route_with_exit" || apple.status === "route_wins";
					const checkAppleDistance = (
						kind: "trap" | "apple",
						moves: number | null,
					) => {
						const distance = immediate.appleDistance;
						if (
							distance === null ||
							moves === null ||
							moves < distance + 1 ||
							(moves - distance - 1) % 2 !== 0
						)
							issue(
								[kind, "moves"],
								"Apple arrival must respect the first move and grid distance",
							);
					};
					if (reachesApple) checkAppleDistance("trap", trap.moves);
					if (foundApple) checkAppleDistance("apple", apple.moves);
					if (
						(trap.status === "board_complete" ||
							apple.status === "route_wins") &&
						value.player.bodyHeadToTail.length + 1 !==
							value.board.width * value.board.height -
								value.board.obstacles.length
					)
						issue(
							[],
							"Reaching only the current apple must actually fill the board to claim a win",
						);
					if (
						(trap.status === "unknown_after_apple" ||
							apple.status === "route_with_exit") &&
						value.player.bodyHeadToTail.length + 1 ===
							value.board.width * value.board.height -
								value.board.obstacles.length
					)
						issue(
							[],
							"Filling the board is a win, not a continuing apple route",
						);
					if (trap.status === "proven_trap" && foundApple)
						issue(
							[],
							"A complete trap proof cannot also have an apple route with an exit or a win",
						);
					if (
						trap.status === "proven_trap" &&
						immediate.nextLegalMoveCount !== 0 &&
						trap.moves === 1
					)
						issue(
							["trap", "moves"],
							"A one-move trap contradicts the recorded available next moves",
						);
					if (immediate.terminal === "board_complete") {
						if (
							trap.status !== "board_complete" ||
							trap.moves !== 1 ||
							trap.exploredNodes !== 1 ||
							apple.status !== "route_wins" ||
							apple.moves !== 1 ||
							apple.exploredNodes !== 1
						)
							issue(
								[],
								"An immediate win must be recorded by both searches at their first position",
							);
					} else if (immediate.nextLegalMoveCount === 0) {
						if (
							trap.status !== "proven_trap" ||
							trap.moves !== 1 ||
							trap.exploredNodes !== 1
						)
							issue(
								["trap"],
								"Zero legal next moves are an immediate exhaustive trap",
							);
						if (
							value.food.apple !== null &&
							(apple.status !== "no_route_with_exit_found" ||
								apple.termination !== "exhausted" ||
								apple.exploredNodes !== 1)
						)
							issue(
								["apple"],
								"An immediate trap has no continuing apple search frontier",
							);
					} else if (immediate.eatsApple) {
						if (
							trap.status !== "unknown_after_apple" ||
							trap.moves !== 1 ||
							trap.exploredNodes !== 1
						)
							issue(
								["trap"],
								"Eating with a continuation stops before unknown future food",
							);
						if (
							apple.status !== "route_with_exit" ||
							apple.moves !== 1 ||
							apple.exploredNodes !== 1 ||
							apple.nextLegalMoveCount !== immediate.nextLegalMoveCount ||
							apple.canReachTail !== immediate.canReachTail
						)
							issue(
								["apple"],
								"An immediate apple arrival must match the one-step exit and tail facts",
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
			const dynamic = value.state.dynamicFacts[direction];
			const expected =
				immediate && dynamic
					? describeDynamicSpaceMove(direction, immediate, dynamic)
					: undefined;
			if (value.questions.direction.criteria[direction] !== expected)
				context.addIssue({
					code: "custom",
					path: ["questions", "direction", "criteria", direction],
					message:
						"Criteria must describe exactly these static and dynamic move facts",
				});
		}
	});
