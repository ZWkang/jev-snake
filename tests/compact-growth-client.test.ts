import { expect, test } from "vitest";
import { createState } from "../server/game/engine.js";
import {
	buildDecisionContextV15,
	decisionBody,
} from "../server/jev/board-context.js";
import { liveGrowthLimits } from "../shared/snake/growth-space-analysis.js";
import type { LegalSpaceInput } from "../shared/snake/legal-space.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import { publicState } from "../shared/snake/types.js";
import fixtures from "./fixtures/growth-space-cases.json";

function observation(id: string, input?: LegalSpaceInput) {
	const state = createState(
		id,
		"test",
		null,
		{
			width: input?.width ?? 16,
			height: input?.height ?? 12,
			obstacleCount: 0,
			seed: id,
			stepMode: "response",
			tickIntervalMs: null,
		},
		"now",
	);
	state.status = "running";
	state.tick = 42;
	if (input)
		Object.assign(state, {
			snake: structuredClone(input.bodyHeadToTail),
			direction: input.direction,
			obstacles: structuredClone(input.obstacles),
			apple: structuredClone(input.apple),
			star: input.star
				? { point: structuredClone(input.star), expiresAt: 3000 }
				: null,
		});
	return publicState(state);
}

test.each([
	...fixtures.map((f) => ({ id: f.id, input: f.input as LegalSpaceInput })),
	{ id: "compact-medium-board", input: undefined },
])(
	"$id keeps every observation and proof while removing at least 35% of request bytes",
	({ id, input }) => {
		const state = observation(id, input);
		const before = structuredClone(state);
		const old = buildDecisionContextV15(
			state,
			undefined,
			undefined,
			undefined,
			{
				limits: liveGrowthLimits,
			},
		).request;
		const compact = decisionBody(state);
		expect(compact.state.contextVersion).toBe("compact-growth-v16");
		const {
			contextVersion: _oldVersion,
			rules: _rules,
			factsSemantics: _factsSemantics,
			dynamicSemantics: _dynamicSemantics,
			...oldFacts
		} = old.state;
		const { contextVersion: _newVersion, ...newFacts } = compact.state;
		expect(newFacts).toEqual(oldFacts);
		expect(compact.state.player.bodyHeadToTail).toEqual(state.snake);
		expect(compact.questions.direction.instructions).toContain(
			compact.state.board.ascii!.map,
		);
		expect(compact.questions.direction.instructions).toContain(
			compact.state.board.ascii!.legend,
		);
		expect(Object.keys(compact.questions.direction.criteria)).toEqual(
			Object.keys(old.questions.direction.criteria),
		);
		expect(decisionRequestSchema.parse(old)).toEqual(old);
		expect(decisionRequestSchema.parse(compact)).toEqual(compact);
		expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(
			Buffer.byteLength(JSON.stringify(old)) * 0.65,
		);
		expect(state).toEqual(before);
	},
);
