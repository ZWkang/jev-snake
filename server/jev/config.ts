import type { JevProvider } from "../../shared/snake/types.js";
import { parseStagnationSettings } from "./stagnation.js";

export const JEV_PROVIDERS = {
	typesafe: {
		endpoint: "https://api.typesafe.ai/v1/systemone",
		model: "jev-1.13.0",
		keyEnv: "TYPESAFE_API_KEY",
	},
	openrouter: {
		endpoint: "https://openrouter.ai/api/alpha/decisions",
		model: "typesafe/jev-1.13",
		keyEnv: "OPENROUTER_API_KEY",
	},
} as const;

export function jevConfig(
	env: Record<string, string | undefined> = process.env,
) {
	if (
		env.JEV_DYNAMIC_ANALYSIS !== undefined &&
		!["true", "false"].includes(env.JEV_DYNAMIC_ANALYSIS)
	)
		throw new Error("JEV_DYNAMIC_ANALYSIS must be true or false");
	const provider = env.JEV_PROVIDER ?? "typesafe";
	if (provider !== "typesafe" && provider !== "openrouter")
		throw new Error("JEV_PROVIDER must be typesafe or openrouter");
	const config = JEV_PROVIDERS[provider];
	return {
		...config,
		provider: provider as JevProvider,
		model: env.JEV_MODEL || config.model,
		apiKey: env[config.keyEnv] ?? "",
		...(env.JEV_DYNAMIC_ANALYSIS === "false" ? { dynamicAnalysis: false } : {}),
		...(env.JEV_STAGNATION_GUARD !== undefined ||
		env.JEV_STAGNATION_MAX_VISITS !== undefined ||
		env.JEV_STAGNATION_MAX_NO_APPLE_MOVES !== undefined
			? { stagnationGuard: parseStagnationSettings(env) }
			: {}),
	};
}
