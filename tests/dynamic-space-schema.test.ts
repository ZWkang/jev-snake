import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { renderAsciiBoard } from "../shared/snake/ascii-board.js";
import { decisionRequestV14Schema } from "../shared/snake/context-v14-schema.js";
import * as dynamicAnalysis from "../shared/snake/dynamic-space-analysis.js";
import type {
	DecisionRequestV14,
	DynamicAnalysisLimits,
} from "../shared/snake/dynamic-space.js";
import {
	analyzeLegalSpace,
	describeLegalSpaceMove,
	legalSpaceSemantics,
} from "../shared/snake/legal-space-analysis.js";
import type { LegalSpaceInput } from "../shared/snake/legal-space.js";
import {
	decisionRequestSchema,
	decisionSchema,
} from "../shared/snake/schema.js";
import { directions, type Direction } from "../shared/snake/types.js";

function request(
	overrides: Partial<LegalSpaceInput> = {},
	limits: DynamicAnalysisLimits = dynamicAnalysis.defaultDynamicLimits,
): DecisionRequestV14 {
	const input: LegalSpaceInput = {
		width: 8,
		height: 8,
		bodyHeadToTail: [
			{ x: 3, y: 3 },
			{ x: 2, y: 3 },
			{ x: 1, y: 3 },
		],
		direction: "right",
		obstacles: [{ x: 4, y: 4 }],
		apple: { x: 6, y: 6 },
		star: null,
		...overrides,
	};
	const analysis = analyzeLegalSpace(input);
	const dynamic = dynamicAnalysis.analyzeDynamicSpace(input, limits);
	const value: DecisionRequestV14 = {
		model: "test-model",
		state: {
			contextVersion: "dynamic-space-v14",
			rules: {
				objective: "Fill the board while staying alive.",
				applePoints: 10,
				starPoints: 30,
				coordinates: "x increases right; y increases down.",
				mechanics: "No reversal. Apples grow the body; stars do not.",
			},
			board: {
				width: input.width,
				height: input.height,
				obstacles: [...input.obstacles],
				ascii: renderAsciiBoard(input),
			},
			player: {
				bodyHeadToTail: [...input.bodyHeadToTail],
				direction: input.direction,
				score: 0,
				applesEaten: 0,
			},
			food: {
				apple: input.apple,
				star: input.star ? { point: input.star, expiresAt: 1000 } : null,
			},
			timing: {
				stateIsProjected: false,
				stepMode: "response",
				observedTick: 0,
				targetTick: 1,
				gameTimeMs: 0,
				tickIntervalMs: null,
				deadlineInMs: null,
			},
			...analysis,
			...dynamic,
			factsSemantics: dynamicAnalysis.dynamicStaticSemantics,
			dynamicSemantics: dynamicAnalysis.dynamicSpaceSemantics,
		},
		questions: {
			direction: {
				type: "choice",
				instructions:
					"Compare these bounded results without treating unknown as safe.",
				criteria: {},
			},
		},
	};
	updateCriteria(value);
	return value;
}

function updateCriteria(value: DecisionRequestV14) {
	value.questions.direction.criteria = Object.fromEntries(
		directions.flatMap((direction) => {
			const immediate = value.state.moveFacts[direction];
			const dynamic = value.state.dynamicFacts[direction];
			return immediate && dynamic
				? [
						[
							direction,
							dynamicAnalysis.describeDynamicSpaceMove(
								direction,
								immediate,
								dynamic,
							),
						],
					]
				: [];
		}),
	);
}

const reference = request();
function fresh() {
	return structuredClone(reference);
}

const down51 = JSON.parse(
	readFileSync(
		new URL("./fixtures/legal-space-down51.json", import.meta.url),
		"utf8",
	),
) as { input: LegalSpaceInput };

describe("dynamic-space-v14 archive contract", () => {
	test("accepts and preserves actual analysis, including the real down51 trap", () => {
		for (const value of [fresh(), request(down51.input)]) {
			const original = structuredClone(value);
			expect(decisionRequestV14Schema.parse(value)).toEqual(original);
			expect(decisionRequestSchema.parse(value)).toEqual(original);
			expect(value).toEqual(original);
		}
		const deadEnd = request(down51.input).state.dynamicFacts.down!;
		expect(deadEnd.trap).toEqual({
			status: "proven_trap",
			moves: 1,
			exploredNodes: 1,
		});
	});

	test("replay/schema parsing never re-runs dynamic searches", () => {
		const value = fresh();
		const search = vi
			.spyOn(dynamicAnalysis, "analyzeDynamicSpace")
			.mockImplementation(() => {
				throw new Error("Archive parser must not run dynamic searches");
			});
		try {
			expect(decisionRequestSchema.parse(value)).toEqual(value);
			expect(search).not.toHaveBeenCalled();
		} finally {
			search.mockRestore();
		}
	});

	test("supports explicit small budgets without rewriting them to production defaults", () => {
		const limits = { trapDepth: 1, appleDepth: 1, maxNodesPerSearch: 1 };
		const value = request({}, limits);
		expect(decisionRequestSchema.parse(value).state).toMatchObject({
			analysisLimits: limits,
		});
		expect(value.state.dynamicFacts.right).toMatchObject({
			trap: { status: "horizon_reached", moves: 1 },
			apple: {
				status: "no_route_with_exit_found",
				termination: "depth_limit",
				moves: null,
			},
		});
	});

	test("node-limited results stay unknown and are never converted into a death proof", () => {
		const value = request(
			{},
			{ trapDepth: 4, appleDepth: 4, maxNodesPerSearch: 1 },
		);
		expect(value.state.dynamicFacts.right).toMatchObject({
			trap: { status: "node_limit", moves: null },
			apple: {
				status: "no_route_with_exit_found",
				termination: "node_limit",
				moves: null,
			},
		});
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		value.state.dynamicFacts.right!.trap.status = "proven_trap";
		updateCriteria(value);
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test.each(["missing", "reverse", "extra"] as const)(
		"rejects %s dynamic directions",
		(change) => {
			const value = fresh();
			if (change === "missing") delete value.state.dynamicFacts.up;
			if (change === "reverse")
				value.state.dynamicFacts.left = value.state.dynamicFacts.right;
			if (change === "extra")
				Object.assign(value.state.dynamicFacts, {
					wait: value.state.dynamicFacts.right,
				});
			updateCriteria(value);
			expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		},
	);

	test.each(["trapDepth", "appleDepth", "maxNodesPerSearch"] as const)(
		"rejects invalid %s limits",
		(key) => {
			for (const invalid of [0, -1, 0.5, Number.POSITIVE_INFINITY]) {
				const value = fresh();
				value.state.analysisLimits[key] = invalid;
				expect(decisionRequestSchema.safeParse(value).success).toBe(false);
			}
		},
	);

	test.each(["trap", "apple"] as const)(
		"rejects %s results outside move and node budgets",
		(kind) => {
			const value = fresh();
			value.state.dynamicFacts.right![kind].exploredNodes =
				value.state.analysisLimits.maxNodesPerSearch + 1;
			updateCriteria(value);
			expect(decisionRequestSchema.safeParse(value).success).toBe(false);
			const tooDeep = fresh();
			tooDeep.state.dynamicFacts.right![kind].moves =
				(kind === "trap"
					? tooDeep.state.analysisLimits.trapDepth
					: tooDeep.state.analysisLimits.appleDepth) + 1;
			updateCriteria(tooDeep);
			expect(decisionRequestSchema.safeParse(tooDeep).success).toBe(false);
		},
	);

	test("rejects impossible horizon, visit count and one-step death metadata", () => {
		for (const trap of [
			{ status: "horizon_reached", moves: 1, exploredNodes: 1 },
			{
				status: "horizon_reached",
				moves: dynamicAnalysis.defaultDynamicLimits.trapDepth,
				exploredNodes: 0,
			},
			{ status: "proven_trap", moves: 1, exploredNodes: 1 },
			{ status: "node_limit", moves: 2, exploredNodes: 2 },
		] as const) {
			const value = fresh();
			value.state.dynamicFacts.right!.trap = { ...trap };
			updateCriteria(value);
			expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		}
	});

	test("found apple routes require real success metadata and an exit", () => {
		const actual = request({ apple: { x: 4, y: 3 } });
		expect(actual.state.dynamicFacts.right).toMatchObject({
			trap: { status: "unknown_after_apple", moves: 1 },
			apple: { status: "route_with_exit", moves: 1, termination: "found" },
		});
		expect(decisionRequestSchema.parse(actual)).toEqual(actual);
		for (const mutation of [
			{ moves: null },
			{ moves: 2 },
			{ exploredNodes: 0 },
			{ termination: "exhausted" },
			{ nextLegalMoveCount: 0 },
			{ nextLegalMoveCount: null },
			{ canReachTail: null },
		] as const) {
			const value = structuredClone(actual);
			Object.assign(value.state.dynamicFacts.right!.apple, mutation);
			updateCriteria(value);
			expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		}
	});

	test("claims about reaching an apple respect distance and grid parity", () => {
		for (const moves of [1, 7]) {
			const value = fresh();
			value.state.dynamicFacts.right!.apple = {
				status: "route_with_exit",
				moves,
				nextLegalMoveCount: 1,
				canReachTail: true,
				exploredNodes: 10,
				termination: "found",
			};
			// The first move ends at (4,3), five cells from (6,6), so arrival needs
			// at least six moves total and an even total length.
			updateCriteria(value);
			expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		}
	});

	test("a bounded search failure cannot fabricate a path or winning certainty", () => {
		const actual = request(
			{},
			{ trapDepth: 1, appleDepth: 1, maxNodesPerSearch: 1 },
		);
		for (const mutation of [
			{ moves: 1 },
			{ nextLegalMoveCount: 1 },
			{ canReachTail: false },
			{ exploredNodes: 0 },
			{ termination: "found" },
			{ termination: "not_applicable" },
		] as const) {
			const value = structuredClone(actual);
			Object.assign(value.state.dynamicFacts.right!.apple, mutation);
			updateCriteria(value);
			expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		}
		const value = fresh();
		value.state.dynamicFacts.right!.apple.status = "route_wins";
		value.state.dynamicFacts.right!.apple.nextLegalMoveCount = null;
		value.state.dynamicFacts.right!.apple.canReachTail = null;
		updateCriteria(value);
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("no-apple data is inapplicable, never a made-up route", () => {
		const value = request({ apple: null });
		expect(value.state.dynamicFacts.right!.apple).toEqual({
			status: "no_apple",
			moves: null,
			nextLegalMoveCount: null,
			canReachTail: null,
			exploredNodes: 0,
			termination: "not_applicable",
		});
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		value.state.dynamicFacts.right!.apple.exploredNodes = 1;
		updateCriteria(value);
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		const withApple = fresh();
		withApple.state.dynamicFacts.right!.apple = {
			status: "no_apple",
			moves: null,
			nextLegalMoveCount: null,
			canReachTail: null,
			exploredNodes: 0,
			termination: "not_applicable",
		};
		updateCriteria(withApple);
		expect(decisionRequestSchema.safeParse(withApple).success).toBe(false);
	});

	test("immediate wins retain N/A exits rather than false or zero", () => {
		const value = request({
			width: 2,
			height: 2,
			obstacles: [],
			bodyHeadToTail: [
				{ x: 0, y: 0 },
				{ x: 0, y: 1 },
				{ x: 1, y: 1 },
			],
			direction: "up",
			apple: { x: 1, y: 0 },
		});
		expect(value.state.dynamicFacts.right).toMatchObject({
			trap: { status: "board_complete", moves: 1, exploredNodes: 1 },
			apple: {
				status: "route_wins",
				moves: 1,
				nextLegalMoveCount: null,
				canReachTail: null,
				exploredNodes: 1,
				termination: "found",
			},
		});
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		for (const mutation of [
			{ nextLegalMoveCount: 0 },
			{ canReachTail: false },
			{ status: "route_with_exit", nextLegalMoveCount: 1, canReachTail: true },
		]) {
			const mutated = structuredClone(value);
			Object.assign(mutated.state.dynamicFacts.right!.apple, mutation);
			updateCriteria(mutated);
			expect(decisionRequestSchema.safeParse(mutated).success).toBe(false);
		}
	});

	test("winning continuations may need several moves instead of winning immediately", () => {
		const value = request({
			width: 3,
			height: 3,
			obstacles: [],
			bodyHeadToTail: [
				{ x: 0, y: 0 },
				{ x: 1, y: 0 },
				{ x: 2, y: 0 },
				{ x: 2, y: 1 },
				{ x: 2, y: 2 },
				{ x: 1, y: 2 },
				{ x: 0, y: 2 },
				{ x: 0, y: 1 },
			],
			direction: "left",
			apple: { x: 1, y: 1 },
		});
		expect(value.state.moveFacts.down!.terminal).toBe(null);
		expect(value.state.dynamicFacts.down).toMatchObject({
			trap: { status: "board_complete", moves: 2 },
			apple: {
				status: "route_wins",
				moves: 2,
				nextLegalMoveCount: null,
				canReachTail: null,
			},
		});
		expect(decisionRequestSchema.parse(value)).toEqual(value);
	});

	test("a first-step apple with no exit remains an exhaustive trap", () => {
		const value = request({ ...down51.input, apple: { x: 0, y: 2 } });
		expect(value.state.dynamicFacts.down).toMatchObject({
			trap: { status: "proven_trap", moves: 1 },
			apple: {
				status: "no_route_with_exit_found",
				termination: "exhausted",
				exploredNodes: 1,
			},
		});
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		value.state.dynamicFacts.down!.trap.status = "unknown_after_apple";
		updateCriteria(value);
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("a proof of exhausted continuations cannot coexist with a found exit route", () => {
		const value = fresh();
		expect(value.state.dynamicFacts.right!.apple.status).toBe(
			"route_with_exit",
		);
		value.state.dynamicFacts.right!.trap = {
			status: "proven_trap",
			moves: 4,
			exploredNodes: 10,
		};
		updateCriteria(value);
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("retains V13 geometry checks and rejects stale text or invented fields", () => {
		for (const change of [
			"body",
			"map",
			"static",
			"criteria",
			"semantics",
			"staticSemantics",
			"extra",
		] as const) {
			const value = fresh();
			if (change === "body")
				value.state.player.bodyHeadToTail[2] = { x: 7, y: 7 };
			if (change === "map") value.state.board.ascii!.map += "\n#";
			if (change === "static")
				value.state.moveFacts.right!.reachableFreeCells++;
			if (change === "criteria")
				value.questions.direction.criteria.right = "Right is guaranteed safe";
			if (change === "semantics")
				value.state.dynamicSemantics = "Every route guarantees safety";
			if (change === "staticSemantics")
				value.state.factsSemantics = legalSpaceSemantics;
			if (change === "extra")
				Object.assign(value.state.dynamicFacts.right!, {
					winningPath: ["right"],
				});
			expect(decisionRequestSchema.safeParse(value).success, change).toBe(
				false,
			);
		}
	});

	test("historical V13 records keep their original semantics and string criteria", () => {
		const current = fresh();
		const {
			analysisLimits: _limits,
			dynamicFacts: _facts,
			dynamicSemantics: _semantics,
			...state
		} = current.state;
		const old = {
			...current,
			state: {
				...state,
				contextVersion: "legal-space-v13",
				factsSemantics: legalSpaceSemantics,
			},
			questions: {
				direction: {
					...current.questions.direction,
					criteria: Object.fromEntries(
						directions.flatMap((direction) =>
							state.moveFacts[direction]
								? [
										[
											direction,
											describeLegalSpaceMove(
												direction,
												state.moveFacts[direction]!,
											),
										],
									]
								: [],
						),
					),
				},
			},
		};
		expect(decisionRequestSchema.parse(old)).toEqual(old);
		expect(decisionRequestSchema.parse(old).state).not.toHaveProperty(
			"dynamicFacts",
		);
	});
});

describe("dynamic-space-v14 response probabilities", () => {
	test.each([
		{ obstacles: [] },
		{ obstacles: [{ x: 3, y: 2 }] },
		{
			obstacles: [
				{ x: 3, y: 2 },
				{ x: 3, y: 4 },
			],
		},
	])("preserves exactly each legal option: $obstacles", ({ obstacles }) => {
		const req = request({ obstacles });
		const offered = Object.keys(
			req.questions.direction.criteria,
		) as Direction[];
		const value = {
			model: req.model,
			choice: offered[0],
			probabilities: Object.fromEntries(
				offered.map((direction) => [direction, 1 / offered.length]),
			),
			confidence: 0.9,
			requestMs: 2,
			request: req,
		};
		expect(decisionSchema.parse(value)).toEqual(value);
		for (const change of ["missing", "extra", "choice"] as const) {
			const mutated = structuredClone(value);
			if (change === "missing") delete mutated.probabilities[mutated.choice];
			if (change === "extra") mutated.probabilities.left = 0;
			if (change === "choice") mutated.choice = "left";
			expect(decisionSchema.safeParse(mutated).success).toBe(false);
		}
	});
});
