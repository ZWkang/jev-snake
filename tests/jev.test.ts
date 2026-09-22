import { expect, test, vi } from "vitest";
import { createState, move, inspectMove } from "../server/game/engine.js";
import { decisionBodyV4 } from "../server/jev/analysis-context.js";
import { askJev, JEV_ENDPOINT, JEV_MODEL } from "../server/jev/client.js";
import { JEV_PROVIDERS, jevConfig } from "../server/jev/config.js";
import { actionFacts } from "../server/jev/context.js";
import { planBody } from "../server/jev/legacy-context.js";
import {
	decisionRequestSchema,
	planRequestSchema,
} from "../shared/snake/schema.js";
import {
	directions,
	opposite,
	publicState,
	type Direction,
} from "../shared/snake/types.js";
import { deadEndReplay, nearComplete } from "./context-fixture.js";

const state = publicState(
	createState(
		"a",
		"JEV",
		JEV_MODEL,
		{
			width: 24,
			height: 18,
			obstacleCount: 0,
			seed: "test",
			stepMode: "response",
			tickIntervalMs: null,
		},
		"now",
	),
);
const legacyState = {
	...state,
	config: { ...state.config, stepMode: "fixed" as const, tickIntervalMs: 125 },
};

const answer = {
	model: JEV_MODEL,
	answers: {
		direction: {
			type: "choice",
			choice: "up",
			probabilities: { up: 0.7, right: 0.2, down: 0.1, left: 0 } as Partial<
				Record<Direction, number>
			>,
			confidence: 0.8,
		},
	},
	usage: { input_tokens: 123 },
};

function responseFor(init: RequestInit | undefined, payload = answer) {
	const request = JSON.parse(init!.body as string);
	const response = structuredClone(payload);
	response.answers.direction.probabilities = Object.fromEntries(
		Object.keys(request.questions.direction.criteria).map((direction) => {
			const probability =
				payload.answers.direction.probabilities[direction as Direction];
			if (probability === undefined)
				throw new Error(`Missing test probability for ${direction}`);
			return [direction, probability];
		}),
	);
	return response;
}
test("uses the real Decisions contract and preserves probabilities", async () => {
	const transport = vi
		.fn<typeof fetch>()
		.mockImplementation(async (_input, init) =>
			Response.json(responseFor(init)),
		);
	const d = await askJev("unit-test-credential", state, { fetch: transport });
	const [url, init] = transport.mock.calls[0];
	expect(url).toBe(JEV_ENDPOINT);
	const body = JSON.parse(init?.body as string);
	expect(body.model).toBe(JEV_MODEL);
	expect(body.questions.direction.type).toBe("choice");
	expect(body).not.toHaveProperty("messages");
	expect(body.state.player).toEqual({
		bodyHeadToTail: state.snake,
		direction: state.direction,
		score: state.score,
		applesEaten: state.applesEaten,
	});
	expect(body.state.board).toMatchObject({
		width: 24,
		height: 18,
		obstacles: [],
	});
	expect(Object.keys(body.state.board).sort()).toEqual([
		"ascii",
		"height",
		"obstacles",
		"width",
	]);
	expect(body.state.contextVersion).toBe("compact-growth-v16");
	expect(Object.keys(body.state).sort()).toEqual([
		"analysisLimits",
		"board",
		"contextVersion",
		"dynamicFacts",
		"excludedMoves",
		"food",
		"moveFacts",
		"player",
		"timing",
	]);
	expect(Object.keys(body.questions.direction.criteria)).toEqual(
		directions.filter(
			(direction) => inspectMove(state, direction).immediateCollision === null,
		),
	);
	for (const value of Object.values(body.questions.direction.criteria))
		expect(typeof value).toBe("string");
	expect(d).not.toHaveProperty("evidence");
	expect(body.state.timing).toMatchObject({
		stateIsProjected: false,
		observedTick: state.tick,
		targetTick: state.tick + 1,
	});
	expect(d.probabilities.up).toBe(0.7);
	expect(Object.keys(d.probabilities)).toEqual(
		Object.keys(body.questions.direction.criteria),
	);
	expect(d.probabilities).not.toHaveProperty(opposite[state.direction]);
	expect(d.inputTokens).toBe(123);
	expect(d.request).toEqual(body);
	expect(d.contextBuildMs).toBeGreaterThanOrEqual(0);
	expect(d.requestBytes).toBe(Buffer.byteLength(init?.body as string, "utf8"));
	expect(JSON.stringify(d.request)).toBe(init?.body);
	expect(decisionRequestSchema.safeParse(d.request).success).toBe(true);
	expect(JSON.stringify(d.request)).not.toContain("unit-test-credential");
	expect(d.request).not.toHaveProperty("headers");
});

test("action facts agree with real movement rules including reverse, wall, obstacles and departing tail", () => {
	const base = createState(
		"facts",
		"Test",
		null,
		{
			width: 24,
			height: 18,
			obstacleCount: 0,
			tickIntervalMs: 500,
			seed: "facts",
		},
		"now",
	);
	base.status = "running";
	base.snake = [
		{ x: 8, y: 6 },
		{ x: 9, y: 6 },
		{ x: 10, y: 6 },
		{ x: 11, y: 6 },
	];
	base.direction = "left";
	base.obstacles = [{ x: 7, y: 6 }];
	base.apple = { x: 7, y: 14 };
	const wall = structuredClone(base);
	wall.snake = [
		{ x: 0, y: 0 },
		{ x: 1, y: 0 },
		{ x: 2, y: 0 },
		{ x: 3, y: 0 },
	];
	const loop = structuredClone(base);
	loop.direction = "left";
	loop.snake = [
		{ x: 1, y: 1 },
		{ x: 2, y: 1 },
		{ x: 2, y: 2 },
		{ x: 1, y: 2 },
	];
	const growing = structuredClone(loop);
	growing.apple = { x: 1, y: 2 };
	for (const original of [base, wall, loop, growing]) {
		const before = structuredClone(original);
		const facts = actionFacts(publicState(original));
		for (const direction of directions) {
			const next = structuredClone(original);
			if (facts[direction].immediateCollision === "reverse")
				expect(() => move(next, direction)).toThrow("reversal");
			else {
				const result = move(next, direction);
				expect(facts[direction].immediateCollision).toBe(
					result.type === "gameover"
						? result.data.reason === "self"
							? "body"
							: result.data.reason
						: null,
				);
			}
		}
		expect(original).toEqual(before);
	}
	expect(actionFacts(publicState(base)).down).toMatchObject({
		target: { x: 8, y: 7 },
		immediateCollision: null,
		appleDistance: 8,
	});
	expect(actionFacts(publicState(loop)).down.immediateCollision).toBeNull();
	expect(actionFacts(publicState(growing)).down.immediateCollision).toBe(
		"body",
	);
});
test("missing key, upstream errors and invalid choices fail explicitly", async () => {
	await expect(askJev("", state)).rejects.toThrow("TYPESAFE_API_KEY");
	await expect(
		askJev("unit-test-credential", state, {
			fetch: vi
				.fn<typeof fetch>()
				.mockResolvedValue(new Response("unavailable", { status: 503 })),
		}),
	).rejects.toThrow("503");
	const invalid = structuredClone(answer);
	invalid.answers.direction.choice = "diagonal";
	await expect(
		askJev("unit-test-credential", state, {
			fetch: vi
				.fn<typeof fetch>()
				.mockImplementation(async (_input, init) =>
					Response.json(responseFor(init, invalid)),
				),
		}),
	).rejects.toThrow("Invalid JEV");
});

test("provider selection keeps endpoints and credentials separate without automatic fallback", async () => {
	expect(jevConfig({ OPENROUTER_API_KEY: "openrouter-only" })).toMatchObject({
		provider: "typesafe",
		apiKey: "",
		model: "jev-1.13.0",
	});
	expect(
		jevConfig({
			JEV_PROVIDER: "openrouter",
			OPENROUTER_API_KEY: "selected-key",
			TYPESAFE_API_KEY: "unselected-key",
		}).apiKey,
	).toBe("selected-key");
	expect(() => jevConfig({ JEV_PROVIDER: "unknown" })).toThrow("JEV_PROVIDER");
	const transport = vi
		.fn<typeof fetch>()
		.mockImplementation(async (_input, init) =>
			Response.json(responseFor(init)),
		);
	const result = await askJev("openrouter-test-key", state, {
		provider: "openrouter",
		fetch: transport,
	});
	const [url, init] = transport.mock.calls[0];
	expect(url).toBe(JEV_PROVIDERS.openrouter.endpoint);
	expect(JSON.parse(init?.body as string).model).toBe(
		JEV_PROVIDERS.openrouter.model,
	);
	expect(result.provider).toBe("openrouter");
	expect(JSON.stringify(result.request)).not.toContain("openrouter-test-key");
});

test.each([
	{ up: 0.26, right: 0.68, down: 0.05 },
	{ up: 0.3, right: 0.7, down: 0.01 },
])(
	"probability totals do not block or alter a valid decision: %j",
	async (probabilities) => {
		const response = structuredClone(answer);
		response.answers.direction.choice = "right";
		response.answers.direction.probabilities = probabilities;
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const decision = await askJev("unit-test-key", state, {
				fetch: vi
					.fn<typeof fetch>()
					.mockImplementation(async (_input, init) =>
						Response.json(responseFor(init, response)),
					),
			});
			expect(decision.choice).toBe("right");
			expect(decision.probabilities).toEqual(probabilities);
			expect(warning).toHaveBeenCalledOnce();
			expect(JSON.parse(warning.mock.calls[0][0])).toMatchObject({
				code: "probabilities_not_normalized",
				probabilities,
				choice: "right",
			});
		} finally {
			warning.mockRestore();
		}
	},
);

test("legacy plan bodies remain readable offline without a plan transport", () => {
	const before = structuredClone(legacyState);
	const request = planBody(legacyState);
	expect(planRequestSchema.parse(request)).toEqual(request);
	expect(Object.keys(request.questions.plan.criteria)).toHaveLength(16);
	expect(legacyState).toEqual(before);
});

test("response requests describe one real move with observed elapsed time and no fixed deadline", async () => {
	const responseState = structuredClone(state);
	responseState.config = {
		...responseState.config,
		stepMode: "response",
		decisionMode: "single_step",
		tickIntervalMs: null,
	};
	responseState.gameTimeMs = 120;
	responseState.tick = 1;
	const before = structuredClone(responseState);
	const transport = vi
		.fn<typeof fetch>()
		.mockImplementation(async (_input, init) =>
			Response.json(responseFor(init)),
		);
	const result = await askJev("response-test-key", responseState, {
		fetch: transport,
		timing: { elapsedGameTimeMs: 2470, deadlineInMs: null },
	});
	const body = JSON.parse(transport.mock.calls[0][1]?.body as string);
	expect(body.state.timing).toEqual({
		stateIsProjected: false,
		observedTick: 1,
		targetTick: 2,
		gameTimeMs: 2470,
		stepMode: "response",
		tickIntervalMs: null,
		deadlineInMs: null,
	});
	expect(body.questions.direction.instructions).toContain(
		"one offered absolute direction for the next move",
	);
	expect(body.state).not.toHaveProperty("rules");
	expect(result.request).toEqual(body);
	expect(responseState).toEqual(before);
	expect(JSON.stringify(result)).not.toContain("response-test-key");
	expect(() => planBody(responseState)).toThrow("cannot use two_step_fallback");
	expect(transport).toHaveBeenCalledOnce();
});

test("response API failures retain safe status and explicit cancellation retains its identity", async () => {
	const responseState = structuredClone(state);
	responseState.config = {
		...responseState.config,
		stepMode: "response",
		decisionMode: "single_step",
		tickIntervalMs: null,
	};
	await expect(
		askJev("secret", responseState, {
			fetch: vi
				.fn<typeof fetch>()
				.mockResolvedValue(
					new Response("upstream secret failed", { status: 503 }),
				),
		}),
	).rejects.toThrow("HTTP 503");
	const controller = new AbortController();
	const transport = vi.fn<typeof fetch>().mockImplementation(
		(_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(init.signal?.reason),
					{ once: true },
				);
			}),
	);
	const pending = askJev("secret", responseState, {
		fetch: transport,
		signal: controller.signal,
	});
	const cancelled = new DOMException("controller_stop", "AbortError");
	controller.abort(cancelled);
	await expect(pending).rejects.toBe(cancelled);
});

test("historical v4 request facts come from the observed corridor and share one first-action summary", () => {
	const observed = publicState(deadEndReplay());
	const before = structuredClone(observed);
	const single = decisionBodyV4(observed);
	expect(Object.keys(single.questions.direction.criteria)).toEqual(directions);
	expect(single.questions.direction.criteria.left.forcedPath).toEqual({
		outcome: "forced_collision",
		steps: 7,
	});
	expect(single.questions.direction.criteria.right.forcedPath?.outcome).toBe(
		"branch",
	);
	expect(JSON.stringify(single)).not.toMatch(
		/bodyHeadToTail|appleDistance|actionFacts/,
	);
	const plan = planBody(observed);
	expect(Object.keys(plan.state.firstActions)).toEqual(directions);
	expect(Object.keys(plan.questions.plan.criteria)).toHaveLength(16);
	expect(plan.questions.plan.criteria.right_down).toMatchObject({
		first: "right",
		second: "down",
		secondStatus: "known",
	});
	expect(plan.questions.plan.criteria.down_right).toEqual({
		first: "down",
		second: "right",
		secondStatus: "not_executed_first_blocked",
		secondFacts: null,
	});
	expect(JSON.stringify(plan)).not.toMatch(
		/bodyHeadToTail|appleDistance|actionFacts/,
	);
	expect(observed).toEqual(before);
});

test("plans state growth uncertainty and board completion without invented second facts", () => {
	const growing = structuredClone(legacyState);
	growing.apple = { x: growing.snake[0].x + 1, y: growing.snake[0].y };
	const request = planBody(growing);
	expect(request.questions.plan.criteria.right_down).toEqual({
		first: "right",
		second: "down",
		secondStatus: "unknown_after_growth",
		secondFacts: {
			immediateCollision: null,
			reason: "new_apple_position_unknown",
		},
	});
	expect(planRequestSchema.safeParse(request).success).toBe(true);
	expect(
		planBody(publicState(nearComplete())).questions.plan.criteria.right_down,
	).toEqual({
		first: "right",
		second: "down",
		secondStatus: "not_executed_board_complete",
		secondFacts: null,
	});
});

test("UTF-8 bytes count the transmitted serialized request and build time excludes transport", async () => {
	const transport = vi
		.fn<typeof fetch>()
		.mockImplementation(async (_input, init) => {
			await new Promise((resolve) => setTimeout(resolve, 40));
			return Response.json(responseFor(init));
		});
	const result = await askJev("unit-test-secret", state, {
		fetch: transport,
		model: "jev-测试",
	});
	const body = transport.mock.calls[0][1]?.body as string;
	expect(result.requestBytes).toBe(Buffer.byteLength(body, "utf8"));
	expect(result.requestBytes).toBeGreaterThan(body.length);
	expect(result.requestMs).toBeGreaterThanOrEqual(35);
	expect(result.contextBuildMs).toBeGreaterThanOrEqual(0);
	expect(JSON.stringify(result.request)).toBe(body);
});

test("dynamic analysis is enabled by default and only an explicit false disables it", () => {
	expect(jevConfig({}).dynamicAnalysis).toBeUndefined();
	expect(
		jevConfig({ JEV_DYNAMIC_ANALYSIS: "true" }).dynamicAnalysis,
	).toBeUndefined();
	expect(jevConfig({ JEV_DYNAMIC_ANALYSIS: "false" }).dynamicAnalysis).toBe(
		false,
	);
	expect(() => jevConfig({ JEV_DYNAMIC_ANALYSIS: "0" })).toThrow(
		"JEV_DYNAMIC_ANALYSIS must be true or false",
	);
});
