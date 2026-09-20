import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { renderAsciiBoard } from "../shared/snake/ascii-board.js";
import { decisionRequestV13Schema } from "../shared/snake/context-v13-schema.js";
import {
	analyzeLegalSpace,
	describeLegalSpaceMove,
	legalSpaceSemantics,
} from "../shared/snake/legal-space-analysis.js";
import type {
	DecisionRequestV13,
	LegalSpaceInput,
	LegalSpaceMoveFacts,
} from "../shared/snake/legal-space.js";
import {
	decisionRequestSchema,
	decisionSchema,
} from "../shared/snake/schema.js";
import {
	type DecisionRequestV11,
	type DecisionRequestV12,
	type Direction,
	directions,
	opposite,
} from "../shared/snake/types.js";

function request(overrides: Partial<LegalSpaceInput> = {}): DecisionRequestV13 {
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
	return {
		model: "test-model",
		state: {
			contextVersion: "legal-space-v13",
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
			factsSemantics: legalSpaceSemantics,
			...analysis,
		},
		questions: {
			direction: {
				type: "choice",
				instructions: "Choose among the legal moves using their stated facts.",
				criteria: Object.fromEntries(
					directions.flatMap((direction) => {
						const facts = analysis.moveFacts[direction];
						return facts
							? [[direction, describeLegalSpaceMove(direction, facts)]]
							: [];
					}),
				),
			},
		},
	};
}

function updateAscii(value: DecisionRequestV13) {
	value.state.board.ascii = renderAsciiBoard({
		...value.state.board,
		bodyHeadToTail: value.state.player.bodyHeadToTail,
		apple: value.state.food.apple,
		star: value.state.food.star?.point ?? null,
	});
}

function updateCriteria(value: DecisionRequestV13) {
	value.questions.direction.criteria = Object.fromEntries(
		directions.flatMap((direction) => {
			const facts = value.state.moveFacts[direction];
			return facts
				? [[direction, describeLegalSpaceMove(direction, facts)]]
				: [];
		}),
	);
}

function response(value: DecisionRequestV13) {
	const candidates = Object.keys(
		value.questions.direction.criteria,
	) as Direction[];
	return {
		model: value.model,
		choice: candidates[0],
		probabilities: Object.fromEntries(
			candidates.map((direction) => [direction, 1 / candidates.length]),
		),
		confidence: 0.8,
		requestMs: 10,
		request: value,
	};
}

const obstacleSets = [
	[],
	[{ x: 3, y: 2 }],
	[
		{ x: 3, y: 2 },
		{ x: 3, y: 4 },
	],
];

describe("legal-space-v13 request contract", () => {
	test.each(obstacleSets.map((obstacles) => ({ obstacles })))(
		"accepts all and only the remaining legal directions: $obstacles",
		({ obstacles }) => {
			const value = request({ obstacles });
			const original = structuredClone(value);
			expect(Object.keys(value.state.moveFacts)).toHaveLength(
				3 - obstacles.length,
			);
			expect(decisionRequestV13Schema.parse(value)).toEqual(original);
			expect(decisionRequestSchema.parse(value)).toEqual(original);
			expect(value).toEqual(original);
		},
	);

	test("preserves a legal move into a one-cell dead end as a model choice", () => {
		const fixture = JSON.parse(
			readFileSync(
				new URL("./fixtures/legal-space-down51.json", import.meta.url),
				"utf8",
			),
		) as {
			input: LegalSpaceInput;
			source: { observedTick: number; targetTick: number };
		};
		const value = request(fixture.input);
		value.state.timing.observedTick = fixture.source.observedTick;
		value.state.timing.targetTick = fixture.source.targetTick;
		expect(value.state.moveFacts.down).toMatchObject({
			target: { x: 0, y: 2 },
			nextLegalMoveCount: 0,
			deadEndRisk: true,
		});
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		expect(Object.keys(value.questions.direction.criteria)).toEqual([
			"up",
			"down",
		]);
	});

	test("rejects a request with no legal choices", () => {
		const value = request({
			obstacles: [
				{ x: 3, y: 2 },
				{ x: 4, y: 3 },
				{ x: 3, y: 4 },
			],
		});
		expect(value.state.moveFacts).toEqual({});
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test.each(["missing", "reverse", "blocked", "unknown"] as const)(
		"rejects %s criteria and corresponding move facts",
		(change) => {
			const value = request({ obstacles: [{ x: 3, y: 2 }] });
			if (change === "missing") delete value.state.moveFacts.right;
			if (change === "reverse")
				value.state.moveFacts.left = value.state.moveFacts.right;
			if (change === "blocked")
				value.state.moveFacts.up = value.state.moveFacts.right;
			if (change === "unknown")
				Object.assign(value.state.moveFacts, {
					wait: value.state.moveFacts.right,
				});
			updateCriteria(value);
			expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		},
	);

	test.each([
		"target",
		"turn",
		"eatsApple",
		"eatsStar",
		"appleDistance",
		"lengthAfter",
		"freeCellsAfter",
		"reachableFreeCells",
		"canReachTail",
		"nextLegalMoveCount",
		"deadEndRisk",
		"terminal",
	] as const)(
		"rejects fabricated %s even when the criteria agree with it",
		(key) => {
			const value = request();
			const facts = value.state.moveFacts.right!;
			const mutations: LegalSpaceMoveFacts = {
				target: { x: 7, y: 7 },
				turn: "left turn",
				eatsApple: true,
				eatsStar: true,
				appleDistance: 0,
				lengthAfter: 20,
				freeCellsAfter: 0,
				reachableFreeCells: 0,
				canReachTail: null,
				nextLegalMoveCount: null,
				deadEndRisk: true,
				terminal: "board_complete",
			};
			Object.assign(facts, { [key]: mutations[key] });
			updateCriteria(value);
			expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		},
	);

	test.each(["missing", "extra", "wrong reason"] as const)(
		"rejects %s exclusions",
		(change) => {
			const value = request();
			if (change === "missing") delete value.state.excludedMoves.left;
			if (change === "extra") value.state.excludedMoves.up = "wall";
			if (change === "wrong reason") value.state.excludedMoves.left = "body";
			expect(decisionRequestSchema.safeParse(value).success).toBe(false);
		},
	);

	test("rejects stale board, map, facts and timing rather than silently recomputing them", () => {
		for (const change of [
			"obstacle",
			"body",
			"map",
			"timing",
			"semantics",
			"guide",
			"criteria",
			"option",
		] as const) {
			const value = request();
			if (change === "obstacle") {
				value.state.board.obstacles.push({ x: 7, y: 7 });
				updateAscii(value);
			}
			if (change === "body") {
				value.state.player.bodyHeadToTail[2] = { x: 7, y: 7 };
				updateAscii(value);
			}
			if (change === "map") value.state.board.ascii!.map += "\n#";
			if (change === "timing") value.state.timing.targetTick = 2;
			if (change === "semantics")
				value.state.factsSemantics = "Guaranteed winning paths";
			if (change === "guide")
				Object.assign(value.state, { strategyGuide: "Long old guide" });
			if (change === "criteria")
				value.questions.direction.criteria.right = "Move right";
			if (change === "option") delete value.questions.direction.criteria.right;
			expect(decisionRequestSchema.safeParse(value).success, change).toBe(
				false,
			);
		}
	});

	test("the tail vacates on a non-growing move, and apple growth must be reflected in the facts", () => {
		const tailMove = request({
			bodyHeadToTail: [
				{ x: 1, y: 1 },
				{ x: 1, y: 2 },
				{ x: 2, y: 2 },
				{ x: 2, y: 1 },
			],
			direction: "up",
		});
		expect(tailMove.state.moveFacts.right).toMatchObject({
			target: { x: 2, y: 1 },
			lengthAfter: 4,
			eatsApple: false,
		});
		expect(decisionRequestSchema.parse(tailMove)).toEqual(tailMove);
		tailMove.state.excludedMoves.right = "body";
		delete tailMove.state.moveFacts.right;
		updateCriteria(tailMove);
		expect(decisionRequestSchema.safeParse(tailMove).success).toBe(false);
		const growth = request({ apple: { x: 4, y: 3 } });
		expect(growth.state.moveFacts.right).toMatchObject({
			eatsApple: true,
			lengthAfter: 4,
		});
		expect(decisionRequestSchema.parse(growth)).toEqual(growth);
		growth.state.moveFacts.right!.lengthAfter--;
		updateCriteria(growth);
		expect(decisionRequestSchema.safeParse(growth).success).toBe(false);
	});

	test("a board-completing move has no continuing tail or next-move estimate", () => {
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
		expect(value.state.moveFacts.right).toMatchObject({
			terminal: "board_complete",
			canReachTail: null,
			nextLegalMoveCount: null,
			deadEndRisk: false,
		});
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		for (const fake of [
			{ canReachTail: false },
			{ nextLegalMoveCount: 0 },
			{ deadEndRisk: true },
		]) {
			const mutated = structuredClone(value);
			Object.assign(mutated.state.moveFacts.right!, fake);
			updateCriteria(mutated);
			expect(decisionRequestSchema.safeParse(mutated).success).toBe(false);
		}
	});

	test("historical v11 and v12 requests retain their original shape and choice sets", () => {
		const current = request({ obstacles: [{ x: 3, y: 2 }] });
		const {
			factsSemantics: _factsSemantics,
			moveFacts: _moveFacts,
			excludedMoves: _excludedMoves,
			...state
		} = current.state;
		for (const version of ["model-planning-v11", "non-reverse-v12"] as const) {
			const value: DecisionRequestV11 | DecisionRequestV12 = {
				model: current.model,
				state: {
					...state,
					contextVersion: version,
					strategyGuide: "Historical strategy",
				},
				questions: {
					direction: {
						type: "choice",
						instructions: "Historical prompt",
						criteria: Object.fromEntries(
							directions
								.filter(
									(direction) =>
										version === "model-planning-v11" ||
										direction !== opposite[state.player.direction],
								)
								.map((direction) => [
									direction,
									{ meaning: `Move ${direction}` },
								]),
						),
					},
				},
			};
			expect(decisionRequestSchema.parse(value)).toEqual(value);
			expect(decisionRequestSchema.parse(value).state).not.toHaveProperty(
				"moveFacts",
			);
			expect(value.questions.direction.criteria).toHaveProperty("up");
		}
	});
});

describe("legal-space-v13 response contract", () => {
	test.each(obstacleSets.map((obstacles) => ({ obstacles })))(
		"retains exactly the $obstacles request's probabilities",
		({ obstacles }) => {
			const value = response(request({ obstacles }));
			expect(decisionSchema.parse(value)).toEqual(value);
			for (const change of ["missing", "extra", "choice"] as const) {
				const mutated = structuredClone(value);
				if (change === "missing") delete mutated.probabilities[mutated.choice];
				if (change === "extra") mutated.probabilities.left = 0;
				if (change === "choice") mutated.choice = "left";
				expect(decisionSchema.safeParse(mutated).success, change).toBe(false);
			}
		},
	);
});
