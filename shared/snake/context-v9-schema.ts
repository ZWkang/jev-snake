import { z } from "zod";
import type { DecisionRequestV9 } from "./bounded-search.js";
import { decisionRequestV8Schema } from "./context-v8-schema.js";
import { directions, opposite, type Point, vectors } from "./types.js";

const integer = z.number().int().nonnegative();
const positive = z.number().int().positive();
const localSearch = z
	.object({
		algorithm: z.literal("iterative_deepening_dfs"),
		foodBoundary: z.literal("stop_at_current_apple"),
		maxDepth: positive,
		maxNodes: integer,
		expandedNodes: integer,
		moves: z.record(
			z.enum(directions),
			z
				.object({
					status: z.enum([
						"blocked",
						"proven_dead",
						"apple_reachable",
						"win_reachable",
						"survival_found",
						"unknown",
					]),
					expandedNodes: integer,
					nodeBudget: integer,
					maxDepthReached: integer,
					cutoff: z.enum(["none", "depth", "nodes", "apple"]),
					witness: z.array(z.enum(directions)).nonempty().nullable(),
					appleExitDirections: z.array(z.enum(directions)).nullable(),
				})
				.strict(),
		),
	})
	.strict();

const equal = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
function validateLocalSearch(
	state: DecisionRequestV9["state"],
	context: z.RefinementCtx,
) {
	const search = state.localSearch;
	const issue = (path: (string | number)[], message: string) =>
		context.addIssue({
			code: "custom",
			path: ["localSearch", ...path],
			message,
		});
	const legalCount = directions.filter(
		(d) => state.immediateMoves[d].legal,
	).length;
	const budget =
		legalCount === 0 ? 0 : Math.floor(search.maxNodes / legalCount);
	const total = directions.reduce(
		(sum, d) => sum + search.moves[d].expandedNodes,
		0,
	);
	if (search.expandedNodes !== total || total > search.maxNodes)
		issue(
			["expandedNodes"],
			"Total expansion count must match the moves and stay within the budget",
		);
	const obstacleKeys = new Set(
		state.board.obstacles.map((p) => `${p.x},${p.y}`),
	);
	const apple = state.food.apple;
	const traversableCells =
		state.board.width * state.board.height - obstacleKeys.size;
	function advance(
		body: Point[],
		current: (typeof directions)[number],
		direction: (typeof directions)[number],
		food: Point | null = apple,
	) {
		if (direction === opposite[current]) return null;
		const vector = vectors[direction];
		const target = { x: body[0].x + vector.x, y: body[0].y + vector.y };
		if (
			target.x < 0 ||
			target.y < 0 ||
			target.x >= state.board.width ||
			target.y >= state.board.height ||
			obstacleKeys.has(`${target.x},${target.y}`)
		)
			return null;
		const grows = food !== null && equal(target, food);
		if (body.some((p, i) => (grows || i < body.length - 1) && equal(p, target)))
			return null;
		return {
			body: [target, ...body.slice(0, grows ? body.length : -1)],
			grows,
		};
	}
	for (const direction of directions) {
		const move = search.moves[direction];
		const path = ["moves", direction];
		const require = (condition: boolean, field: string, message: string) => {
			if (!condition) issue([...path, field], message);
		};
		const blocked = !state.immediateMoves[direction].legal;
		require((move.status === "apple_reachable") ===
			(move.appleExitDirections !==
				null), "appleExitDirections", "Only an apple route reports its growth endpoint's legal exits");
		require((move.status === "blocked") ===
			blocked, "status", "Blocked status must match the immediate move");
		require(move.nodeBudget ===
			(blocked
				? 0
				: budget), "nodeBudget", "Legal moves receive equal shares of the total node budget");
		require(move.expandedNodes <=
			move.nodeBudget, "expandedNodes", "A move cannot exceed its allocated node budget");
		require(move.maxDepthReached <=
			Math.min(search.maxDepth, move.expandedNodes) &&
			(move.expandedNodes === 0) ===
				(move.maxDepthReached ===
					0), "maxDepthReached", "Reached depth must match actual expanded nodes and the configured depth");
		if (blocked) {
			require(move.expandedNodes === 0 &&
				move.maxDepthReached === 0 &&
				move.cutoff === "none" &&
				move.witness ===
					null, "status", "Blocked moves have no search expansion, cutoff or witness");
			continue;
		}
		if (move.cutoff === "nodes")
			require(move.expandedNodes ===
				move.nodeBudget, "expandedNodes", "A node cutoff must exhaust the allocated budget");
		switch (move.status) {
			case "blocked":
				break;
			case "proven_dead":
				require(move.cutoff === "none" &&
					move.witness === null &&
					move.expandedNodes >
						0, "status", "Proven death requires an expanded search without a cutoff or witness");
				break;
			case "unknown":
				require(move.cutoff === "nodes" &&
					move.witness === null &&
					move.expandedNodes ===
						0, "status", "Unknown search results have no expanded candidate or verified witness");
				break;
			case "apple_reachable":
				require(move.cutoff === "apple" &&
					move.witness !==
						null, "status", "A reachable apple needs a route ending at the current apple boundary");
				break;
			case "win_reachable":
				require(move.cutoff === "none" &&
					move.witness !==
						null, "status", "A reachable win needs a terminal route without a cutoff");
				break;
			case "survival_found":
				require((move.cutoff === "nodes" || move.cutoff === "depth") &&
					move.witness !==
						null, "status", "Survival evidence needs a verified route and an explicit search limit");
				if (move.cutoff === "depth")
					require(move.witness?.length ===
						search.maxDepth, "witness", "A depth cutoff needs a surviving route to the configured depth");
				break;
		}
		const witness = move.witness;
		if (witness === null) continue;
		require(witness[0] ===
			direction, "witness", "A witness must start with its candidate direction");
		require(witness.length <=
			move.maxDepthReached, "witness", "A witness cannot exceed the depth actually reached");
		let body = state.player.bodyHeadToTail;
		let current = state.player.direction;
		let ateApple = false;
		let valid = true;
		for (const [index, step] of witness.entries()) {
			const next = advance(body, current, step);
			if (!next) {
				issue(
					[...path, "witness", index],
					"Witness moves must follow the actual reversal, boundary, obstacle and body rules",
				);
				valid = false;
				break;
			}
			body = next.body;
			current = step;
			ateApple = next.grows;
			if (ateApple && index !== witness.length - 1) {
				issue(
					[...path, "witness", index],
					"A witness must stop at the current apple and cannot invent the next food position",
				);
				valid = false;
				break;
			}
		}
		if (!valid) continue;
		const won = ateApple && body.length === traversableCells;
		if (move.status === "apple_reachable") {
			require(ateApple &&
				!won, "witness", "An apple route must reach the current apple without completing the board");
			if (ateApple && !won) {
				// No next apple position is assumed. A new apple cannot occupy the
				// current body or tail, so immediate move legality is unchanged.
				const exits = directions.filter(
					(next) => advance(body, current, next, null) !== null,
				);
				require(move.appleExitDirections !== null &&
					move.appleExitDirections.length === exits.length &&
					move.appleExitDirections.every(
						(entry, index) => entry === exits[index],
					), "appleExitDirections", "Apple exits must exactly match the legal next directions at this witness endpoint");
			}
		}
		if (move.status === "win_reachable")
			require(won, "witness", "A winning route must eat the current apple and fill every traversable cell");
		if (move.status === "survival_found")
			require(!ateApple &&
				directions.some(
					(next) => advance(body, current, next) !== null,
				), "witness", "A survival route must avoid growth and retain a legal next move at its endpoint");
	}
}

export const decisionRequestV9Schema = z
	.object({
		model: z.string().min(1),
		state: z
			.object({
				...decisionRequestV8Schema.shape.state.shape,
				contextVersion: z.literal("bounded-search-v9"),
				localSearch,
			})
			.strict()
			.superRefine((value, context) => {
				if (context.issues.length) return;
				const { localSearch: _localSearch, ...observed } = value;
				const base = decisionRequestV8Schema.shape.state.safeParse({
					...observed,
					contextVersion: "global-view-v8",
				});
				if (!base.success) {
					for (const issue of base.error.issues) context.addIssue({ ...issue });
					return;
				}
				validateLocalSearch(value, context);
			}),
		questions: decisionRequestV8Schema.shape.questions,
	})
	.strict();
