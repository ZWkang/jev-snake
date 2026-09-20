import { expect, test } from "vitest";
import { createState } from "../server/game/engine.js";
import {
	buildDecisionContext,
	decisionBodyV15,
} from "../server/jev/board-context.js";
import { askJev } from "../server/jev/client.js";
import { GrowthRouteMemory } from "../server/jev/growth-route-memory.js";
import {
	analyzeGrowthSpace,
	type GrowthRouteWitnesses,
	liveGrowthLimits,
} from "../shared/snake/growth-space-analysis.js";
import { analyzeLegalSpace } from "../shared/snake/legal-space-analysis.js";
import type { LegalSpaceInput } from "../shared/snake/legal-space.js";
import { inspectMove } from "../shared/snake/move-rules.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import { type Direction, publicState } from "../shared/snake/types.js";
import fixtures from "./fixtures/long-apple-detour.json";

const fixture = fixtures[0];
const input = () => structuredClone(fixture.input) as LegalSpaceInput;
const identity = { matchId: fixture.matchId, tick: fixture.tick };
function advance(
	board: LegalSpaceInput,
	direction: Direction,
): LegalSpaceInput {
	const step = inspectMove(
		{ config: board, snake: board.bodyHeadToTail, ...board },
		direction,
	);
	expect(step.immediateCollision).toBeNull();
	return {
		...board,
		direction,
		bodyHeadToTail: [
			step.target,
			...(step.eatsApple
				? board.bodyHeadToTail
				: board.bodyHeadToTail.slice(0, -1)),
		],
		apple: step.eatsApple ? null : board.apple,
	};
}
function observation(board: LegalSpaceInput, tick = fixture.tick) {
	const state = createState(
		fixture.matchId,
		"long-detour",
		null,
		{
			width: board.width,
			height: board.height,
			obstacleCount: 0,
			seed: "long-detour",
			stepMode: "response",
			decisionMode: "single_step",
			tickIntervalMs: null,
		},
		"now",
	);
	Object.assign(state, {
		status: "running",
		tick,
		snake: board.bodyHeadToTail,
		direction: board.direction,
		obstacles: board.obstacles,
		apple: board.apple,
		star: null,
	});
	return publicState(state);
}

test("live evidence sees 39/97-move alternatives and the final 86-move detour without changing archived v15 limits", () => {
	const state = observation(input());
	const legacy = decisionBodyV15(state);
	expect(legacy.state.analysisLimits.appleDepth).toBe(32);
	expect(legacy.state.dynamicFacts.right!.apple.moves).toBeNull();
	const request = buildDecisionContext(state).request;
	expect(request.state.analysisLimits).toEqual(liveGrowthLimits);
	expect(request.state.dynamicFacts.up!.apple.moves).toBe(97);
	expect(request.state.dynamicFacts.right!.apple.moves).toBe(39);
	expect(request.questions.direction.instructions).toContain(
		"prefer fewer apple.moves",
	);
	expect(decisionRequestSchema.parse(request)).toEqual(request);
	const last = analyzeGrowthSpace(
		fixtures[1].input as LegalSpaceInput,
		liveGrowthLimits,
	);
	expect(last.dynamicFacts.left!.apple).toMatchObject({
		status: "route_with_optimistic_continuation",
		moves: 86,
		postApple: { status: "optimistic_horizon_reached", moves: 8 },
	});
});

test("each confirmed move revalidates the retained route and decreases its length until the actual apple", () => {
	const routes: GrowthRouteWitnesses = {};
	analyzeGrowthSpace(input(), liveGrowthLimits, {
		onRouteFound: (d, path) => {
			routes[d] = path;
		},
	});
	const route = routes.right!;
	expect(route).toHaveLength(39);
	const memory = new GrowthRouteMemory();
	let board = input();
	for (const [i, direction] of route.entries()) {
		const before = structuredClone(board);
		const facts = memory.analyze(board, {
			...identity,
			tick: identity.tick + i,
		});
		expect(facts.dynamicFacts[direction]!.apple).toMatchObject({
			status: "route_with_optimistic_continuation",
			moves: route.length - i,
			postApple: { status: "optimistic_horizon_reached", moves: 8 },
		});
		expect(Object.keys(facts.dynamicFacts)).toEqual(
			Object.keys(analyzeLegalSpace(board).moveFacts),
		);
		for (const f of Object.values(facts.dynamicFacts)) {
			expect(f.apple.exploredNodes).toBeLessThanOrEqual(2048);
			expect(f.apple.postAppleNodes).toBeLessThanOrEqual(2048);
		}
		expect(board).toEqual(before);
		expect(JSON.stringify(facts)).not.toMatch(/"path"|"recommended"/);
		board = advance(board, direction);
	}
	expect(board.bodyHeadToTail).toHaveLength(59);
	expect(board.apple).toBeNull();
});

test.each(["match", "jump", "apple", "body"])(
	"%s changes invalidate prior candidates",
	(change) => {
		const memory = new GrowthRouteMemory();
		memory.analyze(input(), identity);
		let next = advance(input(), "right");
		const id = { ...identity, tick: identity.tick + 1 };
		if (change === "match") id.matchId = "another-match";
		if (change === "jump") id.tick++;
		if (change === "apple") next.apple = { x: 0, y: 7 };
		if (change === "body") next = advance(input(), "up");
		// This alternate body is not the observed one-step successor at this tick.
		if (change === "body") next = advance(next, "right");
		expect(memory.analyze(next, id)).toEqual(
			analyzeGrowthSpace(next, liveGrowthLimits),
		);
	},
);

test("retained candidates consume the same explicit budgets and cannot turn unknown into success", () => {
	const memory = new GrowthRouteMemory();
	memory.analyze(input(), identity);
	const result = memory.analyze(
		advance(input(), "right"),
		{ ...identity, tick: identity.tick + 1 },
		{
			...liveGrowthLimits,
			maxNodesPerSearch: 1,
		},
	);
	for (const f of Object.values(result.dynamicFacts)) {
		expect(f.apple.exploredNodes).toBeLessThanOrEqual(1);
		expect(f.apple.moves).toBeNull();
		expect(f.apple.termination).toBe("node_limit");
	}
});

test("the transport still submits the model choice even when a shorter candidate exists", async () => {
	const result = await askJev("test-key", observation(input()), {
		routeMemory: new GrowthRouteMemory(),
		fetch: (async (_url, init) => {
			const request = JSON.parse(init!.body as string);
			expect(request.state.analysisLimits.appleDepth).toBe(128);
			expect(request.state.dynamicFacts.right.apple.moves).toBe(39);
			expect(decisionRequestSchema.parse(request)).toEqual(request);
			return Response.json({
				model: "test-model",
				answers: {
					direction: {
						type: "choice",
						choice: "up",
						probabilities: { up: 1, right: 0 },
						confidence: 1,
					},
				},
			});
		}) as typeof fetch,
	});
	expect(result.choice).toBe("up");
});
