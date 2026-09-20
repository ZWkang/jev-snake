import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { renderAsciiBoard } from "../shared/snake/ascii-board.js";
import { decisionRequestV12Schema } from "../shared/snake/context-v12-schema.js";
import type { DecisionRequestV11 } from "../shared/snake/model-planning.js";
import type { DecisionRequestV12 } from "../shared/snake/non-reverse.js";
import {
	decisionRequestSchema,
	decisionSchema,
	planDecisionSchema,
} from "../shared/snake/schema.js";
import {
	type Direction,
	directions,
	opposite,
	planChoices,
	vectors,
} from "../shared/snake/types.js";

function updateAscii(value: DecisionRequestV12) {
	value.state.board.ascii = renderAsciiBoard({
		...value.state.board,
		bodyHeadToTail: value.state.player.bodyHeadToTail,
		apple: value.state.food.apple,
		star: value.state.food.star?.point ?? null,
	});
}
function request(heading: Direction = "right"): DecisionRequestV12 {
	const vector = vectors[heading];
	const value: DecisionRequestV12 = {
		model: "test-model",
		state: {
			contextVersion: "non-reverse-v12",
			rules: {
				objective: "Fill the board while staying alive.",
				applePoints: 10,
				starPoints: 30,
				coordinates: "x increases right; y increases down.",
				mechanics:
					"Move one cell. No direct reversal. Apples grow the body; stars do not.",
			},
			board: { width: 12, height: 12, obstacles: [{ x: 10, y: 9 }] },
			player: {
				bodyHeadToTail: [0, 1, 2, 3].map((index) => ({
					x: 5 - vector.x * index,
					y: 5 - vector.y * index,
				})),
				direction: heading,
				score: 0,
				applesEaten: 0,
			},
			food: { apple: { x: 10, y: 10 }, star: null },
			timing: {
				stateIsProjected: false,
				stepMode: "response",
				observedTick: 0,
				targetTick: 1,
				gameTimeMs: 0,
				tickIntervalMs: null,
				deadlineInMs: null,
			},
			strategyGuide: "Plan your own moves using the complete observed board.",
		},
		questions: {
			direction: {
				type: "choice",
				instructions: "Choose the next direction.",
				criteria: Object.fromEntries(
					directions
						.filter((direction) => direction !== opposite[heading])
						.map((direction) => [direction, { meaning: `Move ${direction}.` }]),
				),
			},
		},
	};
	updateAscii(value);
	return value;
}
function decision(value = request()) {
	const candidates = directions.filter((direction) =>
		Object.hasOwn(value.questions.direction.criteria, direction),
	);
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

describe("three non-reverse choices", () => {
	test.each(directions)(
		"heading %s has exactly its three non-reverse choices and probabilities",
		(heading) => {
			const value = request(heading);
			const original = structuredClone(value);
			const keys = directions.filter(
				(direction) => direction !== opposite[heading],
			);
			expect(Object.keys(value.questions.direction.criteria)).toEqual(keys);
			expect(decisionRequestV12Schema.parse(value)).toEqual(original);
			expect(decisionRequestSchema.parse(value)).toEqual(original);
			const recorded = decision(value);
			expect(decisionSchema.parse(recorded)).toEqual(recorded);
			expect(Object.keys(recorded.probabilities)).toEqual(keys);
			expect(value).toEqual(original);
		},
	);

	test.each(directions)(
		"heading %s rejects reverse, missing, replaced and unknown candidates",
		(heading) => {
			const reverse = opposite[heading];
			const candidate = directions.find((direction) => direction !== reverse)!;
			for (const change of [
				"reverse",
				"missing",
				"replaced",
				"unknown",
			] as const) {
				const value = request(heading);
				const criteria = value.questions.direction.criteria;
				if (change === "reverse" || change === "replaced")
					criteria[reverse] = { meaning: "Reverse" };
				if (change === "missing" || change === "replaced")
					delete criteria[candidate];
				if (change === "unknown")
					Object.assign(criteria, { wait: { meaning: "Wait" } });
				expect(decisionRequestSchema.safeParse(value).success, change).toBe(
					false,
				);
			}
		},
	);

	test.each(directions)(
		"heading %s rejects a reverse choice and probability keys that disagree with its request",
		(heading) => {
			const reverse = opposite[heading];
			for (const change of [
				"choice",
				"missing",
				"extra",
				"replaced",
				"unknown",
			] as const) {
				const recorded = decision(request(heading));
				if (change === "choice") recorded.choice = reverse;
				if (change === "extra" || change === "replaced")
					recorded.probabilities[reverse] = 0;
				if (change === "missing" || change === "replaced")
					delete recorded.probabilities[recorded.choice];
				if (change === "unknown") recorded.probabilities.wait = 0;
				expect(decisionSchema.safeParse(recorded).success, change).toBe(false);
			}
		},
	);

	test("wall and obstacle choices remain available; only direct reversal is removed", () => {
		const value = request("right");
		value.state.player.bodyHeadToTail = [3, 2, 1, 0].map((x) => ({ x, y: 0 }));
		value.state.board.obstacles = [{ x: 3, y: 1 }];
		updateAscii(value);
		expect(Object.keys(value.questions.direction.criteria)).toEqual([
			"up",
			"right",
			"down",
		]);
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		for (const choice of ["up", "down"] as const)
			expect(decisionSchema.parse({ ...decision(value), choice }).choice).toBe(
				choice,
			);
	});

	test("a body collision remains a model choice rather than another filtered direction", () => {
		const value = request("right");
		value.state.player.bodyHeadToTail = [
			{ x: 3, y: 1 },
			{ x: 2, y: 1 },
			{ x: 2, y: 0 },
			{ x: 3, y: 0 },
			{ x: 4, y: 0 },
		];
		updateAscii(value);
		expect(decisionRequestSchema.parse(value)).toEqual(value);
		expect(
			decisionSchema.parse({ ...decision(value), choice: "up" }).choice,
		).toBe("up");
	});

	test("candidates follow the recorded heading even when other request fields stay unchanged", () => {
		const value = request("right");
		value.state.player.direction = "up";
		expect(decisionRequestSchema.safeParse(value).success).toBe(false);
	});

	test("inherits full geometry, character map, guide and strict raw input validation", () => {
		for (const change of [
			"body",
			"obstacle",
			"map",
			"legend",
			"guide",
			"analysis",
		] as const) {
			const value = request();
			if (change === "body")
				value.state.player.bodyHeadToTail[3] = { x: 0, y: 0 };
			if (change === "obstacle")
				value.state.board.obstacles.push(value.state.player.bodyHeadToTail[0]);
			if (change === "map") value.state.board.ascii!.map += "\n.";
			if (change === "legend")
				value.state.board.ascii!.legend = "Invented symbols";
			if (change === "guide")
				Object.assign(value.state, { strategyGuide: { route: ["up"] } });
			if (change === "analysis")
				Object.assign(value.state, { localSearch: {} });
			expect(decisionRequestSchema.safeParse(value).success, change).toBe(
				false,
			);
		}
		const optional = request();
		delete optional.state.board.ascii;
		delete optional.state.strategyGuide;
		expect(decisionRequestSchema.parse(optional)).toEqual(optional);
	});

	test("v12 records retain probability values rather than normalizing or adding the removed direction", () => {
		const recorded = decision();
		recorded.probabilities = { up: 0.69, right: 0.1, down: 0.1 };
		expect(decisionSchema.parse(recorded).probabilities).toEqual(
			recorded.probabilities,
		);
	});

	test("historical v11 requests and decisions keep all four choices, including reverse", () => {
		const current = request();
		const old: DecisionRequestV11 = {
			...current,
			state: { ...current.state, contextVersion: "model-planning-v11" },
			questions: {
				direction: {
					...current.questions.direction,
					criteria: Object.fromEntries(
						directions.map((direction) => [
							direction,
							{ meaning: `Move ${direction}.` },
						]),
					) as DecisionRequestV11["questions"]["direction"]["criteria"],
				},
			},
		};
		expect(decisionRequestSchema.parse(old)).toEqual(old);
		const recorded = {
			...decision(),
			choice: "left",
			request: old,
			probabilities: { up: 0.1, right: 0.1, down: 0.1, left: 0.69 },
		};
		expect(decisionSchema.parse(recorded)).toEqual(recorded);
		Reflect.deleteProperty(recorded.probabilities, "left");
		expect(decisionSchema.safeParse(recorded).success).toBe(false);
	});

	test("records without a request and captured legacy requests still require four probabilities", () => {
		const legacy = JSON.parse(
			readFileSync(
				new URL("./fixtures/context-legacy.json", import.meta.url),
				"utf8",
			),
		);
		for (const request of [undefined, ...Object.values(legacy)]) {
			const recorded = {
				model: "legacy-model",
				choice: "left",
				probabilities: { up: 0.69, right: 0.1, down: 0.1, left: 0.1 },
				confidence: 0.8,
				requestMs: 10,
				...(request === undefined ? {} : { request }),
			};
			expect(decisionSchema.parse(recorded)).toEqual(recorded);
			Reflect.deleteProperty(recorded.probabilities, "left");
			expect(decisionSchema.safeParse(recorded).success).toBe(false);
		}
	});

	test("legacy plans retain their sixteen-choice envelope independently of single-step validation", () => {
		const captures = JSON.parse(
			readFileSync(
				new URL("./fixtures/context-v2.json", import.meta.url),
				"utf8",
			),
		);
		const plan = (Object.values(captures)[0] as { plan: { model: string } })
			.plan;
		const recorded = {
			kind: "plan",
			model: plan.model,
			choice: "up_up",
			probabilities: Object.fromEntries(
				planChoices.map((choice) => [choice, choice === "up_up" ? 0.69 : 0.01]),
			),
			confidence: 0.8,
			requestMs: 10,
			request: plan,
		};
		expect(planDecisionSchema.parse(recorded)).toEqual(recorded);
		delete recorded.probabilities.left_left;
		expect(planDecisionSchema.safeParse(recorded).success).toBe(false);
	});
});
