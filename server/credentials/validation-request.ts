import { publicState } from "../../shared/snake/types.js";
import { createState } from "../game/engine.js";
import { buildDecisionContext } from "../jev/board-context.js";

// A separate deterministic fixture: never registers a match or consumes its RNG.
export function validationRequest(model: string) {
	const state = publicState(
		createState(
			"key-validation",
			"Key validation",
			model,
			{
				width: 8,
				height: 6,
				obstacleCount: 0,
				seed: "key-validation-v1",
				layoutVersion: 3,
				stepMode: "response",
				decisionMode: "single_step",
				tickIntervalMs: null,
			},
			"2000-01-01T00:00:00.000Z",
		),
	);
	return buildDecisionContext(state, model).request;
}
