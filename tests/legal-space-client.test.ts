import { expect, test, vi } from "vitest";
import { createState, move } from "../server/game/engine.js";
import { askJev, decisionBody } from "../server/jev/client.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import { publicState, type Direction } from "../shared/snake/types.js";
import fixture from "./fixtures/legal-space-down51.json";

function state() {
	const s = createState(
		"legal-client",
		"test",
		null,
		{
			width: 8,
			height: 8,
			obstacleCount: 1,
			seed: "legal-client",
			stepMode: "response",
			tickIntervalMs: null,
		},
		"now",
	);
	Object.assign(s, {
		status: "running",
		tick: 218,
		applesEaten: 26,
		snake: structuredClone(fixture.input.bodyHeadToTail),
		direction: fixture.input.direction as Direction,
		obstacles: structuredClone(fixture.input.obstacles),
		apple: structuredClone(fixture.input.apple),
		star: null,
	});
	return s;
}

test("sends static evidence for the real down-51 trap without replacing the model's choice", async () => {
	const original = state();
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockImplementation(async (_, init) => {
			const sent = JSON.parse(String(init?.body));
			expect(sent.state.contextVersion).toBe("growth-space-v15");
			expect(Object.keys(sent.questions.direction.criteria)).toEqual([
				"up",
				"down",
			]);
			expect(sent.questions.direction.criteria.down).toContain("NO_NEXT_MOVE");
			expect(sent.questions.direction.criteria.down).toContain("PROVEN_TRAP");
			expect(sent.state.dynamicFacts.down.trap.status).toBe("proven_trap");
			expect(sent.state.moveFacts.down).toMatchObject({
				reachableFreeCells: 0,
				nextLegalMoveCount: 0,
				deadEndRisk: true,
			});
			expect(sent.state).not.toHaveProperty("strategyGuide");
			expect(sent.questions.direction.instructions).toContain(
				sent.state.board.ascii.map,
			);
			return Response.json({
				model: "test-model",
				answers: {
					direction: {
						type: "choice",
						choice: "down",
						probabilities: { up: 0.49, down: 0.51 },
						confidence: 0.25,
					},
				},
			});
		});
	const decision = await askJev("test-only", publicState(original), { fetch });
	expect(decision.choice).toBe("down");
	expect(decision.probabilities).toEqual({ up: 0.49, down: 0.51 });
	expect(decision.request).toEqual(
		JSON.parse(String(fetch.mock.calls[0][1]?.body)),
	);
	expect(decisionRequestSchema.parse(decision.request)).toEqual(
		decision.request,
	);
	expect(fetch).toHaveBeenCalledOnce();
});

test("a single legal direction still records a real transport response", async () => {
	const s = state();
	s.snake = [3, 2, 1, 0].map((x) => ({ x, y: 0 }));
	s.direction = "right";
	s.obstacles = [{ x: 3, y: 1 }];
	s.apple = { x: 7, y: 7 };
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockImplementation(async (_, init) => {
			const sent = JSON.parse(String(init?.body));
			expect(Object.keys(sent.questions.direction.criteria)).toEqual(["right"]);
			return Response.json({
				model: "actual-test-transport",
				answers: {
					direction: {
						type: "choice",
						choice: "right",
						probabilities: { right: 1 },
						confidence: 1,
					},
				},
			});
		});
	const result = await askJev("test-only", publicState(s), { fetch });
	expect(fetch).toHaveBeenCalledOnce();
	expect(result.model).toBe("actual-test-transport");
	expect(result.probabilities).toEqual({ right: 1 });
});

test("a removed direction is an explicit model error, never a substituted move or retry", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
		Response.json({
			model: "test-model",
			answers: {
				direction: {
					type: "choice",
					choice: "left",
					probabilities: { up: 0.5, down: 0.5 },
					confidence: 0,
				},
			},
		}),
	);
	await expect(
		askJev("test-only", publicState(state()), { fetch }),
	).rejects.toThrow("chosen direction was not offered");
	expect(fetch).toHaveBeenCalledOnce();
});

test("no legal direction is exposed as an error before any model call", async () => {
	const trapped = state();
	move(trapped, "down");
	expect(() => decisionBody(publicState(trapped))).toThrow(
		"No legal directions remain",
	);
	const fetch = vi.fn<typeof globalThis.fetch>();
	await expect(async () =>
		askJev("test-only", publicState(trapped), { fetch }),
	).rejects.toThrow("No legal directions remain");
	expect(fetch).not.toHaveBeenCalled();
});

test("explicitly disabling dynamic analysis keeps the V13 request and the real model call", async () => {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockImplementation(async (_, init) => {
			const request = JSON.parse(String(init?.body));
			expect(request.state.contextVersion).toBe("legal-space-v13");
			expect(request.state).not.toHaveProperty("dynamicFacts");
			return Response.json({
				model: "configured-v13",
				answers: {
					direction: {
						type: "choice",
						choice: "up",
						probabilities: { up: 1, down: 0 },
						confidence: 1,
					},
				},
			});
		});
	const result = await askJev("test-only", publicState(state()), {
		fetch,
		dynamicAnalysis: false,
	});
	expect(fetch).toHaveBeenCalledOnce();
	expect(result.model).toBe("configured-v13");
	expect(result.choice).toBe("up");
});
