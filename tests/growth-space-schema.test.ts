import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { renderAsciiBoard } from "../shared/snake/ascii-board.js";
import { decisionRequestV15Schema } from "../shared/snake/context-v15-schema.js";
import {
	analyzeDynamicSpace,
	describeDynamicSpaceMove,
	dynamicSpaceSemantics,
	dynamicStaticSemantics,
} from "../shared/snake/dynamic-space-analysis.js";
import * as growth from "../shared/snake/growth-space-analysis.js";
import type {
	DecisionRequestV15,
	GrowthAnalysisLimits,
} from "../shared/snake/growth-space.js";
import { analyzeLegalSpace } from "../shared/snake/legal-space-analysis.js";
import type { LegalSpaceInput } from "../shared/snake/legal-space.js";
import {
	decisionRequestSchema,
	decisionSchema,
} from "../shared/snake/schema.js";
import { directions, type Direction } from "../shared/snake/types.js";

const defaultInput: LegalSpaceInput = {
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
};
function request(
	overrides: Partial<LegalSpaceInput> = {},
	limits: GrowthAnalysisLimits = growth.defaultGrowthLimits,
): DecisionRequestV15 {
	const input = { ...defaultInput, ...overrides };
	const value: DecisionRequestV15 = {
		model: "test-model",
		state: {
			contextVersion: "growth-space-v15",
			rules: {
				objective: "Fill the board.",
				applePoints: 10,
				starPoints: 30,
				coordinates: "x right, y down",
				mechanics: "Apples grow the ordered body.",
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
			factsSemantics: dynamicStaticSemantics,
			dynamicSemantics: growth.growthSpaceSemantics,
			...analyzeLegalSpace(input),
			...growth.analyzeGrowthSpace(input, limits),
		},
		questions: {
			direction: {
				type: "choice",
				instructions: "Compare the bounded post-growth facts.",
				criteria: {},
			},
		},
	};
	updateCriteria(value);
	return value;
}
function updateCriteria(value: DecisionRequestV15) {
	value.questions.direction.criteria = Object.fromEntries(
		directions.flatMap((direction) => {
			const immediate = value.state.moveFacts[direction];
			const dynamic = value.state.dynamicFacts[direction];
			return immediate && dynamic
				? [
						[
							direction,
							growth.describeGrowthSpaceMove(direction, immediate, dynamic),
						],
					]
				: [];
		}),
	);
}
const reference = request();
const fresh = () => structuredClone(reference);
const fixtures = JSON.parse(
	readFileSync(
		new URL("./fixtures/growth-space-cases.json", import.meta.url),
		"utf8",
	),
) as { id: string; input: LegalSpaceInput }[];
const trap487 = fixtures.find(
	(fixture) => fixture.id === "growth-trap-487-77",
)!;

describe("growth-space-v15 archive contract", () => {
	test.each(fixtures)(
		"accepts actual growth analysis for $id without rewriting fields",
		({ input }) => {
			const value = request(input);
			const original = structuredClone(value);
			expect(decisionRequestV15Schema.parse(value)).toEqual(original);
			expect(decisionRequestSchema.parse(value)).toEqual(original);
			expect(value).toEqual(original);
		},
	);

	test("parsing archives never reruns post-growth or route searches", () => {
		const value = fresh();
		const search = vi
			.spyOn(growth, "analyzeGrowthSpace")
			.mockImplementation(() => {
				throw new Error("Archive parsing must not perform dynamic searches");
			});
		try {
			expect(decisionRequestSchema.parse(value)).toEqual(value);
			expect(search).not.toHaveBeenCalled();
		} finally {
			search.mockRestore();
		}
	});

	test.each([
		"trapDepth",
		"appleDepth",
		"postAppleDepth",
		"maxNodesPerSearch",
	] as const)(
		"rejects invalid %s while retaining explicit valid limits",
		(key) => {
			for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
				const value = fresh();
				value.state.analysisLimits[key] = invalid;
				expect(decisionRequestSchema.safeParse(value).success).toBe(false);
			}
			const value = request(
				{},
				{
					trapDepth: 1,
					appleDepth: 1,
					postAppleDepth: 1,
					maxNodesPerSearch: 1,
				},
			);
			expect(decisionRequestSchema.parse(value)).toEqual(value);
		},
	);

	test("retains node-limited postchecks as unknown instead of certifying one exit", () => {
		const value = request(
			{ apple: { x: 4, y: 3 } },
			{ trapDepth: 8, appleDepth: 32, postAppleDepth: 8, maxNodesPerSearch: 1 },
		);
		expect(value.state.dynamicFacts.right).toMatchObject({
			trap: { status: "node_limit", moves: null },
			apple: {
				status: "route_postcheck_unknown",
				moves: 1,
				termination: "postcheck_node_limit",
				postApple: { status: "node_limit", moves: null, exploredNodes: 1 },
				postAppleNodes: 1,
			},
		});
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		for (const change of [
			"strong",
			"found",
			"deathDistance",
			"safePost",
		] as const) {
			const mutated = structuredClone(value);
			const apple = mutated.state.dynamicFacts.right!.apple;
			if (change === "strong")
				apple.status = "route_with_optimistic_continuation";
			if (change === "found") apple.termination = "found";
			if (change === "deathDistance") apple.postApple!.moves = 0;
			if (change === "safePost")
				apple.postApple!.status = "optimistic_horizon_reached";
			updateCriteria(mutated);
			expect(decisionRequestSchema.safeParse(mutated).success, change).toBe(
				false,
			);
		}
	});

	test("a selected postcheck and every rejected arrival share one cumulative budget", () => {
		const value = fresh();
		const apple = value.state.dynamicFacts.right!.apple;
		expect(apple.status).toBe("route_with_optimistic_continuation");
		for (const mutation of [
			{ postAppleNodes: value.state.analysisLimits.maxNodesPerSearch + 1 },
			{ postAppleNodes: apple.postApple!.exploredNodes - 1 },
			{ rejectedTrapArrivals: apple.exploredNodes + 1 },
			{ rejectedTrapArrivals: apple.postAppleNodes + 1 },
		] as const) {
			const mutated = fresh();
			Object.assign(mutated.state.dynamicFacts.right!.apple, mutation);
			updateCriteria(mutated);
			expect(decisionRequestSchema.safeParse(mutated).success).toBe(false);
		}
	});

	test("post-apple moves exclude the eating root and require the complete horizon", () => {
		const value = fresh();
		const apple = value.state.dynamicFacts.right!.apple;
		expect(apple.postApple).toMatchObject({
			status: "optimistic_horizon_reached",
			moves: value.state.analysisLimits.postAppleDepth,
		});
		expect(apple.postApple!.exploredNodes).toBeGreaterThanOrEqual(
			value.state.analysisLimits.postAppleDepth + 1,
		);
		for (const mutation of [
			{ moves: 0 },
			{ moves: null },
			{ moves: value.state.analysisLimits.postAppleDepth + 1 },
			{ exploredNodes: value.state.analysisLimits.postAppleDepth },
		]) {
			const mutated = fresh();
			Object.assign(
				mutated.state.dynamicFacts.right!.apple.postApple!,
				mutation,
			);
			updateCriteria(mutated);
			expect(decisionRequestSchema.safeParse(mutated).success).toBe(false);
		}
	});

	test("a proven-trapped arrival is rejected and never archived as a qualifying route", () => {
		const value = request(trap487.input);
		expect(value.state.dynamicFacts.right!.trap).toMatchObject({
			status: "proven_trap",
			moves: 6,
		});
		expect(value.state.dynamicFacts.right!.apple).toMatchObject({
			status: "no_qualifying_route_found",
			moves: null,
			postApple: null,
		});
		expect(
			value.state.dynamicFacts.right!.apple.rejectedTrapArrivals,
		).toBeGreaterThan(0);
		const mutated = fresh();
		mutated.state.dynamicFacts.right!.apple.postApple = {
			status: "proven_trap",
			moves: 0,
			exploredNodes: 1,
		};
		updateCriteria(mutated);
		expect(decisionRequestSchema.safeParse(mutated).success).toBe(false);
	});

	test("an apple with no immediate exit is still a zero-subsequent-move failed arrival", () => {
		const dead = JSON.parse(
			readFileSync(
				new URL("./fixtures/legal-space-down51.json", import.meta.url),
				"utf8",
			),
		) as { input: LegalSpaceInput };
		const value = request({ ...dead.input, apple: { x: 0, y: 2 } });
		expect(value.state.dynamicFacts.down).toMatchObject({
			trap: { status: "proven_trap", moves: 1 },
			apple: {
				status: "no_qualifying_route_found",
				postApple: null,
				postAppleNodes: 1,
				rejectedTrapArrivals: 1,
			},
		});
		expect(decisionRequestSchema.parse(value)).toEqual(value);
	});

	test("near-win uncertainty cannot invent death steps or appear far from completion", () => {
		for (const which of ["trap", "post"] as const) {
			const value = fresh();
			if (which === "trap")
				value.state.dynamicFacts.right!.trap = {
					status: "unknown_near_win",
					moves: null,
					exploredNodes: 10,
				};
			else {
				const apple = value.state.dynamicFacts.right!.apple;
				apple.status = "route_postcheck_unknown";
				apple.termination = "exhausted";
				apple.postApple = {
					status: "unknown_near_win",
					moves: null,
					exploredNodes: 9,
				};
			}
			updateCriteria(value);
			expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		}
	});

	test("extra growth may win before an optimistic dead end, so near-win stays unknown", () => {
		const value = request({
			width: 7,
			height: 1,
			bodyHeadToTail: [4, 3, 2, 1, 0].map((x) => ({ x, y: 0 })),
			direction: "right",
			obstacles: [],
			apple: { x: 5, y: 0 },
		});
		expect(value.state.dynamicFacts.right).toMatchObject({
			trap: { status: "unknown_near_win", moves: null },
			apple: {
				status: "route_postcheck_unknown",
				moves: 1,
				termination: "exhausted",
				postApple: {
					status: "unknown_near_win",
					moves: null,
					exploredNodes: 2,
				},
			},
		});
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		for (const which of ["trap", "post"] as const) {
			const mutated = structuredClone(value);
			if (which === "trap") mutated.state.dynamicFacts.right!.trap.moves = 2;
			else mutated.state.dynamicFacts.right!.apple.postApple!.moves = 1;
			updateCriteria(mutated);
			expect(decisionRequestSchema.safeParse(mutated).success).toBe(false);
		}
		const falseDeath = structuredClone(value);
		falseDeath.state.dynamicFacts.right!.trap.status = "proven_trap";
		falseDeath.state.dynamicFacts.right!.trap.moves = 2;
		updateCriteria(falseDeath);
		expect(decisionRequestSchema.safeParse(falseDeath).success).toBe(false);
	});

	test("post-growth horizon is explicitly optimistic and cannot be relabeled as before-apple survival", () => {
		const value = request({ apple: { x: 4, y: 3 } });
		expect(value.state.dynamicFacts.right!.trap.status).toBe(
			"optimistic_horizon_reached",
		);
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		value.state.dynamicFacts.right!.trap.status = "horizon_reached";
		updateCriteria(value);
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("wins have no postcheck and may be immediate or several moves later", () => {
		const values = [
			request({
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
			}),
			request({
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
			}),
		];
		for (const [index, value] of values.entries()) {
			const direction = index === 0 ? "right" : "down";
			expect(value.state.dynamicFacts[direction]!.apple).toMatchObject({
				status: "route_wins",
				moves: index + 1,
				postApple: null,
				nextLegalMoveCount: null,
				canReachTail: null,
			});
			expect(decisionRequestSchema.parse(value)).toEqual(value);
			value.state.dynamicFacts[direction]!.apple.nextLegalMoveCount = 0;
			updateCriteria(value);
			expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		}
	});

	test("no apple means no fake search or post-growth work", () => {
		const value = request({ apple: null });
		expect(value.state.dynamicFacts.right!.apple).toMatchObject({
			status: "no_apple",
			moves: null,
			postApple: null,
			postAppleNodes: 0,
			rejectedTrapArrivals: 0,
			exploredNodes: 0,
			termination: "not_applicable",
		});
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		value.state.dynamicFacts.right!.apple.postAppleNodes = 1;
		updateCriteria(value);
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test.each([
		"missing",
		"reverse",
		"unknown",
		"criteria",
		"map",
		"static",
		"semantics",
	] as const)("rejects inconsistent %s", (change) => {
		const value = fresh();
		if (change === "missing") delete value.state.dynamicFacts.right;
		if (change === "reverse")
			value.state.dynamicFacts.left = value.state.dynamicFacts.right;
		if (change === "unknown")
			Object.assign(value.state.dynamicFacts, {
				wait: value.state.dynamicFacts.right,
			});
		if (change === "criteria")
			value.questions.direction.criteria.right =
				"This route is guaranteed safe";
		if (change === "map") value.state.board.ascii!.map += "\n#";
		if (change === "static") value.state.moveFacts.right!.reachableFreeCells++;
		if (change === "semantics")
			value.state.dynamicSemantics = dynamicSpaceSemantics;
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("V14 remains unchanged, including its old premature apple-boundary observation", () => {
		const current = request(trap487.input);
		const oldAnalysis = analyzeDynamicSpace(trap487.input);
		const old = {
			...current,
			state: {
				...current.state,
				contextVersion: "dynamic-space-v14",
				...oldAnalysis,
				dynamicSemantics: dynamicSpaceSemantics,
			},
			questions: {
				direction: {
					...current.questions.direction,
					criteria: Object.fromEntries(
						directions.flatMap((direction) =>
							current.state.moveFacts[direction] &&
							oldAnalysis.dynamicFacts[direction]
								? [
										[
											direction,
											describeDynamicSpaceMove(
												direction,
												current.state.moveFacts[direction]!,
												oldAnalysis.dynamicFacts[direction]!,
											),
										],
									]
								: [],
						),
					),
				},
			},
		};
		expect(old.state.dynamicFacts.right!.trap).toMatchObject({
			status: "unknown_after_apple",
			moves: 2,
		});
		expect(decisionRequestSchema.parse(old)).toEqual(old);
		expect(
			decisionRequestSchema.parse(old).state.analysisLimits,
		).not.toHaveProperty("postAppleDepth");
	});
});

describe("growth-space-v15 response contract", () => {
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
		"retains one, two or three actual options: $obstacles",
		({ obstacles }) => {
			const req = request({ obstacles });
			const options = Object.keys(
				req.questions.direction.criteria,
			) as Direction[];
			const decision = {
				model: req.model,
				choice: options[0],
				probabilities: Object.fromEntries(
					options.map((direction) => [direction, 1 / options.length]),
				),
				confidence: 0.9,
				requestMs: 10,
				request: req,
			};
			expect(decisionSchema.parse(decision)).toEqual(decision);
			for (const change of ["missing", "extra", "choice"] as const) {
				const mutated = structuredClone(decision);
				if (change === "missing") delete mutated.probabilities[mutated.choice];
				if (change === "extra") mutated.probabilities.left = 0;
				if (change === "choice") mutated.choice = "left";
				expect(decisionSchema.safeParse(mutated).success).toBe(false);
			}
		},
	);
});
