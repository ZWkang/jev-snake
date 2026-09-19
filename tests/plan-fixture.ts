import { planBody } from "../server/jev/client.js";
import {
	type DecisionContext,
	type PlanChoice,
	planChoices,
	planDirections,
} from "../shared/snake/types.js";

// Test-only structured model response. No production runner uses this fixture.
export function makePlan(
	context: DecisionContext,
	choice: PlanChoice = "right_down",
	requestId = "plan-A",
) {
	return {
		protocolVersion: 2 as const,
		type: "plan" as const,
		requestId,
		observedSeq: context.observedSeq,
		targetTick: context.targetTick,
		expectedStateHash: context.expectedStateHash,
		directions: planDirections(choice),
		decision: {
			kind: "plan" as const,
			provider: "openrouter" as const,
			model: "test-fixture-not-inference",
			choice,
			probabilities: Object.fromEntries(
				planChoices.map((c) => [c, c === choice ? 1 : 0]),
			) as Record<PlanChoice, number>,
			confidence: 1,
			requestMs: 10,
			request: planBody(context.state),
		},
	};
}
