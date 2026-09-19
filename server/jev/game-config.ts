import { randomUUID } from "node:crypto";
import { configSchema } from "../../shared/snake/schema.js";
import {
	decisionModes,
	type DecisionMode,
	type GameConfig,
} from "../../shared/snake/types.js";

export function gameConfig(
	env: Record<string, string | undefined>,
	values: Record<string, string | undefined> = {},
): GameConfig {
	const stepMode = values["step-mode"] ?? env.SNAKE_STEP_MODE ?? "fixed";
	if (stepMode !== "fixed" && stepMode !== "response")
		throw new Error("step-mode must be fixed or response");
	if (stepMode === "response" && values["tick-ms"] !== undefined)
		throw new Error("response step-mode cannot be combined with --tick-ms");
	const decisionMode =
		values["decision-mode"] ??
		(stepMode === "response" ? "single_step" : "two_step_fallback");
	if (!decisionModes.includes(decisionMode as DecisionMode))
		throw new Error("decision-mode must be single_step or two_step_fallback");
	if (stepMode === "response" && decisionMode === "two_step_fallback")
		throw new Error("response step-mode cannot use two_step_fallback");
	return configSchema.parse({
		stepMode,
		decisionMode,
		width: Number(values.width ?? env.SNAKE_WIDTH ?? 24),
		height: Number(values.height ?? env.SNAKE_HEIGHT ?? 18),
		obstacleCount: Number(values.obstacles ?? env.SNAKE_OBSTACLES ?? 12),
		tickIntervalMs:
			stepMode === "response"
				? null
				: Number(values["tick-ms"] ?? env.SNAKE_TICK_MS ?? 300),
		seed: values.seed ?? env.SNAKE_SEED ?? randomUUID(),
	});
}
