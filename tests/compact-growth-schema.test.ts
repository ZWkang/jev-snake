import { describe, expect, test, vi } from "vitest";
import { createState } from "../server/game/engine.js";
import { decisionBodyV15 } from "../server/jev/board-context.js";
import { ProgressHistory } from "../server/jev/progress.js";
import {
	compactGrowthInstructions,
	compactGrowthRequest,
	type DecisionRequestV16,
} from "../shared/snake/compact-growth.js";
import { decisionRequestV16Schema } from "../shared/snake/context-v16-schema.js";
import * as growth from "../shared/snake/growth-space-analysis.js";
import type { DecisionRequestV15 } from "../shared/snake/growth-space.js";
import {
	decisionRequestSchema,
	decisionSchema,
} from "../shared/snake/schema.js";
import {
	directions,
	opposite,
	publicState,
	type Direction,
	type Point,
} from "../shared/snake/types.js";

function original(obstacles: Point[] = []): DecisionRequestV15 {
	const state = createState(
		"compact-schema",
		"test",
		null,
		{
			width: 8,
			height: 8,
			obstacleCount: 0,
			seed: "compact-schema",
			layoutVersion: 3,
			stepMode: "response",
			tickIntervalMs: null,
		},
		"now",
	);
	state.snake = [3, 2, 1, 0].map((x) => ({ x, y: 3 }));
	state.direction = "right";
	state.obstacles = obstacles;
	state.config.obstacleCount = obstacles.length;
	state.apple = { x: 6, y: 6 };
	state.star = null;
	const visible = publicState(state);
	const history = new ProgressHistory();
	history.observe(visible);
	return decisionBodyV15(
		visible,
		"test-model",
		undefined,
		history.snapshot(visible),
	);
}
const reference = original();
const fresh = () => compactGrowthRequest(reference);

describe("compact-growth-v16 request contract", () => {
	test("drops only repeated explanations and preserves every observation and analysis fact", () => {
		const before = structuredClone(reference);
		const compact = fresh();
		const {
			rules: _rules,
			factsSemantics: _facts,
			dynamicSemantics: _dynamic,
			...expected
		} = before.state;
		expect(compact.state).toEqual({
			...expected,
			contextVersion: "compact-growth-v16",
		});
		expect(compact.model).toBe(reference.model);
		expect(compact.questions.direction.criteria).toEqual({
			up: "up",
			right: "right",
			down: "down",
		});
		expect(reference).toEqual(before);
		compact.state.player.bodyHeadToTail[0].x++;
		expect(reference).toEqual(before);
	});

	test("short instructions keep the exact map and legend, goals and uncertainty semantics", () => {
		const value = fresh();
		const instructions = value.questions.direction.instructions;
		expect(instructions).toBe(compactGrowthInstructions(value.state));
		expect(instructions).toContain(value.state.board.ascii.map);
		expect(instructions).toContain(value.state.board.ascii.legend);
		for (const text of [
			"Snake game",
			"Eat apples",
			"fill every non-obstacle cell",
			"up=y-1",
			"postApple",
			"proven_trap",
			"never guarantee safety",
			"no_qualifying_route_found does not prove food unreachable",
			"stagnation does not prove another route safe",
		])
			expect(instructions).toContain(text);
		const prose = instructions
			.replace(value.state.board.ascii.map, "")
			.replace(value.state.board.ascii.legend, "");
		expect(prose.trim().split(/\s+/).length).toBeLessThanOrEqual(200);
	});

	test("parsing returns the exact compact payload without temporary V15 fields or criteria", () => {
		const value = fresh();
		value.questions.direction.instructions +=
			"\nUse this recorded observation.";
		const before = structuredClone(value);
		for (const schema of [decisionRequestV16Schema, decisionRequestSchema]) {
			const parsed = schema.parse(value);
			expect(parsed).toEqual(before);
			for (const field of ["rules", "factsSemantics", "dynamicSemantics"])
				expect(parsed.state).not.toHaveProperty(field);
			expect(parsed.questions.direction.criteria).toEqual(
				before.questions.direction.criteria,
			);
		}
		expect(value).toEqual(before);
	});

	test("conversion and archive parsing do not rerun growth searches", () => {
		const search = vi
			.spyOn(growth, "analyzeGrowthSpace")
			.mockImplementation(() => {
				throw new Error("No dynamic search while compacting or parsing");
			});
		try {
			const value = fresh();
			expect(decisionRequestSchema.parse(value)).toEqual(value);
			expect(search).not.toHaveBeenCalled();
		} finally {
			search.mockRestore();
		}
	});

	test.each(["missing", "reverse", "wrong value", "unknown", "empty"] as const)(
		"rejects %s compact options",
		(change) => {
			const value = fresh();
			const criteria = value.questions.direction.criteria;
			if (change === "missing") delete criteria.up;
			if (change === "reverse")
				criteria[opposite[value.state.player.direction]] = "left";
			if (change === "wrong value") criteria.up = "right";
			if (change === "unknown") Object.assign(criteria, { wait: "wait" });
			if (change === "empty") value.questions.direction.criteria = {};
			expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		},
	);

	test("conversion does not repair an invalid source option set behind the caller's back", () => {
		const source = structuredClone(reference);
		source.questions.direction.criteria = {};
		const value = compactGrowthRequest(source);
		expect(value.questions.direction.criteria).toEqual({});
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test.each([
		"body",
		"map",
		"obstacles",
		"static facts",
		"growth budget",
		"post budget",
		"timing",
		"progress",
		"missing dynamic",
	] as const)("inherits V15 validation for %s", (change) => {
		const value = fresh();
		if (change === "body")
			value.state.player.bodyHeadToTail[0] = { x: 7, y: 7 };
		if (change === "map") {
			value.state.board.ascii.map += "\n#";
			value.questions.direction.instructions = compactGrowthInstructions(
				value.state,
			);
		}
		if (change === "obstacles")
			value.state.board.obstacles.push(value.state.player.bodyHeadToTail[0]);
		if (change === "static facts")
			value.state.moveFacts.right!.reachableFreeCells++;
		if (change === "growth budget")
			value.state.dynamicFacts.right!.trap.exploredNodes =
				value.state.analysisLimits.maxNodesPerSearch + 1;
		if (change === "post budget")
			value.state.dynamicFacts.right!.apple.postAppleNodes =
				value.state.analysisLimits.maxNodesPerSearch + 1;
		if (change === "timing") value.state.timing.targetTick++;
		if (change === "progress") value.state.progress!.throughTick++;
		if (change === "missing dynamic") delete value.state.dynamicFacts.right;
		expect(decisionRequestSchema.safeParse(value).success, change).toBe(false);
	});

	test("malformed qualifying postchecks produce schema errors instead of throwing during temporary formatting", () => {
		const value = fresh();
		expect(value.state.dynamicFacts.right!.apple.status).toBe(
			"route_with_optimistic_continuation",
		);
		value.state.dynamicFacts.right!.apple.postApple = null;
		expect(() => decisionRequestSchema.safeParse(value)).not.toThrow();
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("keeps node-limit unknowns without turning them into passed postchecks", () => {
		const source = structuredClone(reference);
		const analysis = growth.analyzeGrowthSpace(
			{
				...source.state.board,
				bodyHeadToTail: source.state.player.bodyHeadToTail,
				direction: source.state.player.direction,
				apple: source.state.food.apple,
				star: null,
			},
			{ ...source.state.analysisLimits, maxNodesPerSearch: 1 },
		);
		Object.assign(source.state, analysis);
		source.questions.direction.criteria = Object.fromEntries(
			directions.flatMap((direction) =>
				source.state.moveFacts[direction] &&
				source.state.dynamicFacts[direction]
					? [
							[
								direction,
								growth.describeGrowthSpaceMove(
									direction,
									source.state.moveFacts[direction]!,
									source.state.dynamicFacts[direction]!,
								),
							],
						]
					: [],
			),
		);
		const value = compactGrowthRequest(source);
		expect(value.state.dynamicFacts.right!.trap).toMatchObject({
			status: "node_limit",
			moves: null,
		});
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		value.state.dynamicFacts.right!.trap.moves = 1;
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("cannot add discarded explanations back or replace the instruction map with an old frame", () => {
		for (const field of [
			"rules",
			"factsSemantics",
			"dynamicSemantics",
		] as const) {
			const value = fresh();
			Object.assign(value.state, { [field]: reference.state[field] });
			expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		}
		for (const field of ["map", "legend"] as const) {
			const value = fresh();
			value.questions.direction.instructions =
				value.questions.direction.instructions.replace(
					value.state.board.ascii[field],
					"old observation",
				);
			expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		}
	});

	test("near-win postchecks remain unknown after compaction and cannot be promoted to passed", () => {
		const state = createState(
			"compact-near-win",
			"test",
			null,
			{
				width: 7,
				height: 1,
				obstacleCount: 0,
				seed: "compact-near-win",
				layoutVersion: 3,
				stepMode: "response",
				tickIntervalMs: null,
			},
			"now",
		);
		state.snake = [4, 3, 2, 1, 0].map((x) => ({ x, y: 0 }));
		state.direction = "right";
		state.apple = { x: 5, y: 0 };
		state.star = null;
		const value = compactGrowthRequest(
			decisionBodyV15(publicState(state), "test-model"),
		);
		expect(value.state.dynamicFacts.right).toMatchObject({
			trap: { status: "unknown_near_win", moves: null },
			apple: {
				status: "route_postcheck_unknown",
				postApple: { status: "unknown_near_win", moves: null },
			},
		});
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		value.state.dynamicFacts.right!.apple.status =
			"route_with_optimistic_continuation";
		value.state.dynamicFacts.right!.apple.termination = "found";
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("a compact request requires the supplied map instead of generating a missing one", () => {
		const source = structuredClone(reference);
		delete source.state.board.ascii;
		expect(() => compactGrowthRequest(source)).toThrow(
			"requires its observed character map",
		);
		const value = fresh();
		Reflect.deleteProperty(value.state.board, "ascii");
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("historical V15 requests retain all original text and stay independent of V16 parsing", () => {
		const originalText = structuredClone(reference);
		decisionRequestSchema.parse(fresh());
		expect(decisionRequestSchema.parse(reference)).toEqual(originalText);
		expect(reference).toEqual(originalText);
		expect(reference.state).toHaveProperty("rules");
		expect(reference.state).toHaveProperty("dynamicSemantics");
		expect(reference.questions.direction.criteria.right).not.toBe("right");
	});
});

describe("compact-growth-v16 response probabilities", () => {
	test.each([
		{ obstacles: [] },
		{ obstacles: [{ x: 3, y: 2 }] },
		{
			obstacles: [
				{ x: 3, y: 2 },
				{ x: 3, y: 4 },
			],
		},
	])(
		"keeps the exact one-to-three legal choice set: $obstacles",
		({ obstacles }) => {
			const request: DecisionRequestV16 = compactGrowthRequest(
				original(obstacles),
			);
			const offered = Object.keys(
				request.questions.direction.criteria,
			) as Direction[];
			const value = {
				model: request.model,
				choice: offered[0],
				probabilities: Object.fromEntries(
					offered.map((direction) => [direction, 1 / offered.length]),
				),
				confidence: 0.8,
				requestMs: 10,
				request,
			};
			expect(decisionSchema.parse(value)).toEqual(value);
			for (const change of ["missing", "extra", "choice"] as const) {
				const mutated = structuredClone(value);
				if (change === "missing") delete mutated.probabilities[mutated.choice];
				if (change === "extra") mutated.probabilities.left = 0;
				if (change === "choice") mutated.choice = "left";
				expect(decisionSchema.safeParse(mutated).success).toBe(false);
			}
		},
	);
});
