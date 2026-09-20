import { expect, test, vi } from "vitest";
import { decisionBodyV6 } from "../server/jev/board-context.js";
import { sendJevRequest } from "../server/jev/client.js";
import {
	decisionBodyV8 as decisionBody,
	decisionBodyV7,
} from "../server/jev/search-context.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import type { PublicState, DecisionProgress } from "../shared/snake/types.js";
import cases from "./fixtures/global-view-73882.json";
vi.mock("../server/jev/analysis-context.js", () => {
	throw new Error("Offline planner loaded");
});
vi.mock("../server/jev/branch-death.js", () => {
	throw new Error("Death search loaded");
});
vi.mock("../server/jev/apple-alternatives.js", () => {
	throw new Error("Body-state search loaded");
});
vi.mock("../server/jev/positive-evidence.js", () => {
	throw new Error("Route search loaded");
});

test("the reported branching position exposes whole-board regions without distance cues", () => {
	const sample = cases[0];
	const state = sample.state as PublicState;
	const before = structuredClone(state);
	const r = decisionBody(
		state,
		undefined,
		undefined,
		sample.progress as DecisionProgress,
	);
	expect(r.state.contextVersion).toBe("global-view-v8");
	expect(r.state.observedSpace.moves.up.region).toEqual({
		cells: 11,
		containsApple: false,
	});
	expect(r.state.observedSpace.moves.down.region).toEqual({
		cells: 73,
		containsApple: true,
	});
	for (const f of Object.values(r.state.immediateMoves)) {
		expect(f).not.toHaveProperty("appleProgress");
		expect(f.description).not.toMatch(/closer|farther/);
	}
	expect(decisionRequestSchema.parse(r)).toEqual(r);
	expect(state).toEqual(before);
});

test("both tick153 choices stay legal and their observed room stays separate from a death claim", () => {
	const sample = cases[2];
	const r = decisionBody(sample.state as PublicState);
	expect(r.state.immediateMoves.up.legal).toBe(true);
	expect(r.state.immediateMoves.left.legal).toBe(true);
	expect(r.state.observedSpace.moves.up).toMatchObject({
		region: { cells: 7, containsApple: false },
		openAdjacentCells: 1,
	});
	expect(r.state.observedSpace.moves.left).toMatchObject({
		region: { cells: 7, containsApple: false },
		openAdjacentCells: 2,
	});
	expect(Object.keys(r.questions.direction.criteria)).toEqual([
		"up",
		"right",
		"down",
		"left",
	]);
	expect(r.questions.direction.instructions.uncertainty).toContain(
		"not simulated next states or death/safety proofs",
	);
});

test("previous coordinate and local-distance requests retain their saved meanings", () => {
	const state = cases[0].state as PublicState;
	const v6 = decisionBodyV6(state);
	const v7 = decisionBodyV7(state);
	expect(decisionRequestSchema.parse(v6)).toEqual(v6);
	expect(decisionRequestSchema.parse(v7)).toEqual(v7);
	expect(v6.state).not.toHaveProperty("immediateMoves");
	expect(v7.state.immediateMoves.up.appleProgress).toBe("closer");
	expect(v7.state).not.toHaveProperty("observedSpace");
});

test("even at the reported fork the model's returned direction is never replaced", async () => {
	const state = cases[2].state as PublicState;
	const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
		Response.json({
			model: "test-original-choice",
			answers: {
				direction: {
					type: "choice",
					choice: "up",
					probabilities: { up: 1, right: 0, down: 0, left: 0 },
					confidence: 1,
				},
			},
		}),
	);
	const { decision: d } = await sendJevRequest(
		"test-only",
		decisionBody(state),
		{ fetch },
	);
	expect(d.choice).toBe("up");
	expect(d).not.toHaveProperty("evidence");
	expect(fetch).toHaveBeenCalledOnce();
});
