import { expect, test } from "vitest";
import { decisionBodyV12 as decisionBody } from "../server/jev/board-context.js";
import { repositoryDecisionGuide } from "../shared/snake/repository-strategies.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import type { DecisionRequestV12, PublicState } from "../shared/snake/types.js";
import stagnantApple from "./fixtures/jev-apple-stagnation.json";
import fixtures from "./fixtures/jev-prompt-cases.json";
import evaluatedRepository from "./fixtures/jev-repository-strategy-cases.json";
import evaluatedSpace from "./fixtures/jev-space-prompt-cases.json";

test.each(evaluatedRepository.cases)(
	"historical v12 builder exactly matches the evaluated repository-strategy request for $id",
	({ observation, expectedRequest }) => {
		const expected = expectedRequest as DecisionRequestV12;
		const before = structuredClone({ observation, expectedRequest });
		const actual = decisionBody(
			observation as PublicState,
			expected.model,
			{
				elapsedGameTimeMs: expected.state.timing.gameTimeMs,
				deadlineInMs: expected.state.timing.deadlineInMs,
			},
			expected.state.progress,
		);
		expect(actual).toEqual(expected);
		expect(decisionRequestSchema.parse(actual)).toEqual(expected);
		expect(actual.questions.direction.criteria).toEqual(
			expected.questions.direction.criteria,
		);
		expect({ observation, expectedRequest }).toEqual(before);
	},
);

test.each([
	...fixtures.cases,
	stagnantApple,
	...evaluatedSpace.cases.map(({ id, observation, expectedRequest }) => ({
		id,
		observation,
		request: expectedRequest,
	})),
])(
	"historical v12 repository prompt changes only strategy guidance in archived state and preserves options for $id",
	({ observation, request }) => {
		const archived = request as DecisionRequestV12;
		const before = structuredClone({ observation, request });
		const actual = decisionBody(
			observation as PublicState,
			archived.model,
			{
				elapsedGameTimeMs: archived.state.timing.gameTimeMs,
				deadlineInMs: null,
			},
			archived.state.progress,
		);
		expect(actual.state).toEqual({
			...archived.state,
			strategyGuide: repositoryDecisionGuide,
		});
		expect(actual.questions.direction.criteria).toEqual(
			archived.questions.direction.criteria,
		);
		expect({ observation, request }).toEqual(before);
	},
);

test.each(evaluatedSpace.cases)(
	"historical space-priority request is parsed without rewriting its strategy for $id",
	({ expectedRequest }) => {
		const before = structuredClone(expectedRequest);
		expect(decisionRequestSchema.parse(expectedRequest)).toEqual(before);
		expect(expectedRequest).toEqual(before);
		expect(expectedRequest.state.strategyGuide).not.toBe(
			repositoryDecisionGuide,
		);
	},
);
