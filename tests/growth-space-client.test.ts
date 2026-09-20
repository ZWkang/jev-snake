import { expect, test, vi } from "vitest";
import { createState } from "../server/game/engine.js";
import { askJev, decisionBodyV14 } from "../server/jev/client.js";
import type { LegalSpaceInput } from "../shared/snake/legal-space.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import { publicState, type Direction } from "../shared/snake/types.js";
import fixtures from "./fixtures/growth-space-cases.json";

test.each([
	["growth-trap-8af-323", "down", 3],
	["growth-trap-487-77", "right", 6],
] as const)(
	"%s sends the apple-crossing trap proof and preserves the actual answer",
	async (id, chosen, maxMoves) => {
		const fixture = fixtures.find((f) => f.id === id)!;
		const input = fixture.input as LegalSpaceInput;
		const state = createState(
			id,
			"test",
			null,
			{
				width: input.width,
				height: input.height,
				obstacleCount: 0,
				seed: id,
				stepMode: "response",
				tickIntervalMs: null,
			},
			"now",
		);
		Object.assign(state, {
			status: "running",
			tick: fixture.source.observedTick,
			snake: structuredClone(input.bodyHeadToTail),
			direction: input.direction,
			obstacles: structuredClone(input.obstacles),
			apple: structuredClone(input.apple),
			star: null,
		});
		const observed = publicState(state);
		const old = decisionBodyV14(observed, "test");
		expect(old.state.dynamicFacts[chosen]!.trap.status).toBe(
			"unknown_after_apple",
		);
		expect(old.state.dynamicFacts[chosen]!.apple.status).toBe(
			"route_with_exit",
		);
		expect(decisionRequestSchema.parse(old)).toEqual(old);
		const transport = vi
			.fn<typeof fetch>()
			.mockImplementation(async (_, init) => {
				const request = JSON.parse(String(init?.body));
				expect(request.state.contextVersion).toBe("compact-growth-v16");
				expect(request.state.dynamicFacts[chosen].trap).toMatchObject({
					status: "proven_trap",
					moves: maxMoves,
				});
				expect(request.state.dynamicFacts[chosen].apple.status).toBe(
					"no_qualifying_route_found",
				);
				expect(
					request.state.dynamicFacts[chosen].apple.rejectedTrapArrivals,
				).toBeGreaterThan(0);
				expect(
					request.state.moveFacts[chosen].nextLegalMoveCount,
				).toBeGreaterThan(0);
				expect(Object.keys(request.questions.direction.criteria)).toContain(
					chosen,
				);
				expect(request.questions.direction.instructions).toContain(
					request.state.board.ascii.map,
				);
				return Response.json({
					model: "actual-test-provider",
					answers: {
						direction: {
							type: "choice",
							choice: chosen,
							probabilities: Object.fromEntries(
								Object.keys(request.questions.direction.criteria).map((d) => [
									d,
									d === chosen ? 1 : 0,
								]),
							),
							confidence: 1,
						},
					},
				});
			});
		const result = await askJev("test-only-key", observed, {
			fetch: transport,
		});
		expect(transport).toHaveBeenCalledOnce();
		expect(result.choice).toBe(chosen as Direction);
		expect(result.request).toEqual(
			JSON.parse(String(transport.mock.calls[0][1]?.body)),
		);
		expect(decisionRequestSchema.parse(result.request)).toEqual(result.request);
	},
);
