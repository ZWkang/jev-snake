import {
	nonReverseStrategyGuide,
	spaceDecisionPriorities,
} from "../shared/snake/model-strategies.js";
import { repositoryDecisionGuide } from "../shared/snake/repository-strategies.js";
import type { DecisionRequestV12 } from "../shared/snake/types.js";
import { applePromptVariants } from "./apple-prompt-variants.js";

// Freeze the previous live prompt for fair comparisons even after promotion.
export function spaceBaselineRequest(request: DecisionRequestV12) {
	const previous = applePromptVariants(request).find(
		(variant) => variant.name === "apple_neighbor_cells",
	)!.request;
	const marker =
		"Any move that survives this step must rank above a move that ends the game immediately.";
	const offset = previous.questions.direction.instructions.indexOf(marker);
	if (offset < 0) throw new Error("The frozen neighbor prompt has changed");
	previous.state.strategyGuide = nonReverseStrategyGuide;
	previous.questions.direction.instructions =
		previous.questions.direction.instructions.slice(0, offset) +
		spaceDecisionPriorities;
	return previous;
}

export function repositoryStrategyRequest(request: DecisionRequestV12) {
	const result = spaceBaselineRequest(request);
	const current = result.questions.direction.instructions;
	if (!current.endsWith(spaceDecisionPriorities))
		throw new Error("The frozen space-priority prompt has changed");
	result.state.strategyGuide = repositoryDecisionGuide;
	result.questions.direction.instructions =
		current.slice(0, -spaceDecisionPriorities.length) + repositoryDecisionGuide;
	return result;
}
