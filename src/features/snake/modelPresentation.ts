import {
	isJevModel,
	type ModelDecision,
	type PublicState,
} from "../../../shared/snake/types";

export function modelName(model: string | null | undefined) {
	if (!model) return "玩家";
	if (isJevModel(model)) return "JEV";
	if (model === "laya-typed-decisions") return "Laya";
	return model;
}

export function decisionModelName(
	state: Pick<PublicState, "model"> & {
		lastDecision?: Pick<ModelDecision, "model"> | null;
	},
) {
	return modelName(state.lastDecision?.model ?? state.model);
}

export function providerName(provider: string) {
	return (
		{
			typesafe: "Typesafe 直连",
			openrouter: "OpenRouter",
			laya: "Laya 本地服务",
		}[provider] ?? provider
	);
}
