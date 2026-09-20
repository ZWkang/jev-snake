import { expect, test } from "vitest";
import {
	decisionBodyV12 as decisionBody,
	decisionBodyV11,
} from "../server/jev/client.js";
import { repositoryDecisionGuide } from "../shared/snake/repository-strategies.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import type { PublicState } from "../shared/snake/types.js";
import cases from "./fixtures/global-view-73882.json";

test("historical v12 instructions and state share the complete strategy guide without supplying evaluated moves", () => {
	const first = decisionBody(cases[0].state as PublicState);
	const next = decisionBody(cases[2].state as PublicState);
	expect(first.questions.direction.instructions).toContain(
		"Read the cells directly adjacent to H",
	);
	expect(
		first.questions.direction.instructions.startsWith("This is a Snake game."),
	).toBe(true);
	for (const request of [first, next]) {
		expect(request.state.strategyGuide).toBe(repositoryDecisionGuide);
		expect(request.questions.direction.instructions).toContain(
			request.state.strategyGuide!,
		);
		expect(
			request.questions.direction.instructions.split(repositoryDecisionGuide),
		).toHaveLength(2);
		expect(request.state).not.toHaveProperty("localSearch");
		expect(request.state).not.toHaveProperty("immediateMoves");
		expect(request.state).not.toHaveProperty("observedSpace");
		for (const criterion of Object.values(request.questions.direction.criteria))
			expect(Object.keys(criterion)).toEqual(["meaning"]);
		expect(decisionRequestSchema.parse(request)).toEqual(request);
	}
});

test("historical v11 inputs without a guide or character map are not enriched", () => {
	const old = decisionBodyV11(cases[0].state as PublicState);
	delete old.state.strategyGuide;
	delete old.state.board.ascii;
	old.questions.direction.instructions = "Original recorded instruction.";
	const parsed = decisionRequestSchema.parse(old);
	expect(parsed).toEqual(old);
	expect(parsed.state).not.toHaveProperty("strategyGuide");
	expect(parsed.state).not.toHaveProperty("board.ascii");
});
