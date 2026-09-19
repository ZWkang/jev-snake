import { expect, test } from "vitest";
import { createDeathAnalyzer } from "../server/jev/branch-death.js";
import { advanceGeometry } from "../server/jev/context-v3.js";
import { type PublicState, publicState } from "../shared/snake/types.js";
import { nearComplete } from "./context-fixture.js";
import edge from "./fixtures/edge-branch-trap.json" with { type: "json" };

test("a cached trap proof is shared by equivalent snapshots but not an opened board", () => {
	const analyzer = createDeathAnalyzer();
	const state = advanceGeometry(
		structuredClone(edge.state) as PublicState,
		"right",
	);
	const proof = analyzer.continuation(state);
	expect(proof).not.toBeNull();
	expect(analyzer.continuation(structuredClone(state))).toBe(proof);
	const width = state.config.width;
	state.config.width = 13;
	expect(analyzer.continuation(state)).toBeNull();
	state.config.width = width;
	expect(analyzer.continuation(state)).toBe(proof);
});

test("a possible apple win is not contaminated by a cached no-growth death", () => {
	const analyzer = createDeathAnalyzer();
	const state = publicState(nearComplete());
	const apple = state.apple;
	expect(analyzer.continuation(state)).toBeNull();
	state.apple = null;
	expect(analyzer.continuation(state)).not.toBeNull();
	state.apple = apple;
	expect(analyzer.continuation(state)).toBeNull();
});
