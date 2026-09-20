import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { inspectMove } from "../server/game/engine.js";
import { decisionBodyV5 as decisionBody } from "../server/jev/analysis-context.js";
import { sendJevRequest } from "../server/jev/client.js";
import {
	advanceGeometry,
	analyzeAction,
	staticSpace,
} from "../server/jev/context-v3.js";
import { planBody } from "../server/jev/legacy-context.js";
import { ProgressHistory } from "../server/jev/progress.js";
import {
	decisionRequestSchema,
	planRequestSchema,
} from "../shared/snake/schema.js";
import { directions, type PublicState } from "../shared/snake/types.js";

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/loop-replay.json", import.meta.url), "utf8"),
) as { states: PublicState[] };
function repeated() {
	const history = new ProgressHistory();
	for (const state of fixture.states) {
		history.observe(state);
		if (state.tick === 143) return { state, progress: history.snapshot(state) };
	}
	throw new Error("Missing real replay tick143");
}

test("the real 24-move loop reaches a legal apple with exits while recording the repeated right departure", () => {
	const { state, progress } = repeated();
	expect(state.snake[0]).toEqual({ x: 1, y: 1 });
	expect(state.apple).toEqual({ x: 1, y: 0 });
	expect(progress).toMatchObject({
		lastAppleTick: 103,
		movesSinceApple: 40,
		positionVisits: 2,
		previousVisitTick: 119,
		repeatAfterMoves: 24,
		actions: {
			right: { timesTaken: 1, returnsWithoutApple: 1, lastTakenTick: 120 },
			up: { timesTaken: 0, returnsWithoutApple: 0 },
		},
	});
	expect(inspectMove(state, "up")).toMatchObject({
		immediateCollision: null,
		eatsApple: true,
	});
	const after = advanceGeometry(state, "up");
	expect(
		directions.filter((d) => inspectMove(after, d).immediateCollision === null),
	).toEqual(["right", "left"]);
	const request = decisionBody(state, undefined, undefined, progress);
	expect(request.state.progress).toEqual(progress);
	expect(request.questions.direction.criteria.up).toMatchObject({
		appleRoute: {
			status: "verified_route",
			moves: 1,
			postApple: {
				postEat: { legalNextMoves: 2, tailConnection: "connected" },
			},
		},
	});
	expect(request.questions.direction.instructions).toContain(
		"Decide your strategy",
	);
	expect(request.questions.direction.instructions).toContain(
		"records committed movement",
	);
	expect(request.questions.direction.instructions).not.toMatch(
		/First compare danger|prefer an UNTRIED|prefer fewer|Do not maximize|If any action has danger=null/,
	);
	expect(decisionRequestSchema.parse(request)).toEqual(request);
});

test("history is optional for old standalone inputs, but cannot describe a different observation", () => {
	const { state, progress } = repeated();
	expect(decisionBody(state).state).not.toHaveProperty("progress");
	expect(() =>
		decisionBody(state, undefined, undefined, {
			...progress,
			throughTick: 144,
		}),
	).toThrow("observed tick");
	const fixed = {
		...state,
		config: {
			...state.config,
			stepMode: "fixed" as const,
			tickIntervalMs: 500,
			decisionMode: "two_step_fallback" as const,
		},
	};
	const plan = planBody(fixed, undefined, undefined, progress);
	expect(plan.state.progress).toEqual(progress);
	expect(plan.questions.plan.instructions).toContain(
		"only the first direction",
	);
	expect(planRequestSchema.parse(plan)).toEqual(plan);
});

test("offline v5 transport preserves JEV's returned direction when history shows a repeated departure", async () => {
	const { state, progress } = repeated();
	const transport = vi.fn<typeof fetch>().mockResolvedValue(
		Response.json({
			model: "test-actual-choice",
			answers: {
				direction: {
					type: "choice",
					choice: "right",
					probabilities: { up: 0.2, right: 0.7, down: 0.05, left: 0.05 },
					confidence: 0.7,
				},
			},
		}),
	);
	const request = decisionBody(state, undefined, undefined, progress);
	const { decision } = await sendJevRequest("test-only", request, {
		fetch: transport,
	});
	expect(decision.choice).toBe("right");
	const sent = JSON.parse(String(transport.mock.calls[0][1]?.body));
	expect(sent.state.progress).toEqual(progress);
	expect(decision.request).toEqual(sent);
	expect(transport).toHaveBeenCalledTimes(1);
});

test("a no-static-path loop exposes actual action history without prescribing an exploration order", () => {
	const saved = JSON.parse(
		readFileSync(
			new URL("./fixtures/no-static-route-loop.json", import.meta.url),
			"utf8",
		),
	);
	const input = decisionBody(saved.state, undefined, undefined, saved.progress);
	expect(input.state.progress).toMatchObject({
		repeatAfterMoves: 32,
		actions: {
			up: { timesTaken: 17, returnsWithoutApple: 17 },
			right: { timesTaken: 0, returnsWithoutApple: 0 },
		},
	});
	for (const d of ["up", "right"] as const)
		expect(input.questions.direction.criteria[d]).toMatchObject({
			survival: { status: "not_proven_fatal" },
			appleRoute: { status: "verified_route" },
		});
	expect(input.questions.direction.instructions).toContain(
		"not which direction to choose",
	);
	expect(input.questions.direction.instructions).not.toMatch(
		/prefer an UNTRIED|prefer fewer|among danger=null options/,
	);
	expect(input.state.rules.factsSemantics).toContain(
		"not_proven_fatal means unresolved",
	);
	expect(decisionRequestSchema.parse(input)).toEqual(input);
});

test("the earlier live model's eight-move exploration trace reaches the blocked apple with an exit", () => {
	const saved = JSON.parse(
		readFileSync(
			new URL("./fixtures/no-static-route-loop.json", import.meta.url),
			"utf8",
		),
	);
	let state = saved.state as PublicState;
	// Actual JEV choices from the recorded-geometry live probe; never a runtime controller.
	const path = [
		"right",
		"up",
		"left",
		"up",
		"right",
		"up",
		"left",
		"left",
	] as const;
	for (const direction of path) {
		expect(analyzeAction(state, direction).danger).toBeNull();
		expect(inspectMove(state, direction).immediateCollision).toBeNull();
		state = advanceGeometry(state, direction);
	}
	expect(state.snake[0]).toEqual(saved.state.apple);
	expect(state.snake.length).toBe(saved.state.snake.length + 1);
	expect(staticSpace(state)).toMatchObject({
		legalNextMoves: 1,
		tailConnection: "connected",
	});
});
