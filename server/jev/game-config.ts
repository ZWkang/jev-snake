import { randomUUID } from "node:crypto";
import { newConfigSchema } from "../../shared/snake/schema.js";
import type { ResponseGameConfig } from "../../shared/snake/types.js";

export function gameConfig(
	env: Record<string, string | undefined>,
	values: Record<string, string | undefined> = {},
): ResponseGameConfig {
	const stepMode = values["step-mode"] ?? env.SNAKE_STEP_MODE ?? "response";
	if (stepMode !== "response")
		throw new Error(
			"Only response step-mode is supported; remove fixed configuration",
		);
	if (values["tick-ms"] !== undefined)
		throw new Error(
			"--tick-ms is retired; response mode has no fixed interval",
		);
	const decisionMode = values["decision-mode"] ?? "single_step";
	if (decisionMode !== "single_step")
		throw new Error(
			"Only single_step decision-mode is supported; two_step_fallback is retired",
		);
	warnDeprecatedTickConfig(env);
	return newConfigSchema.parse({
		layoutVersion: 2,
		stepMode,
		decisionMode,
		width: Number(values.width ?? env.SNAKE_WIDTH ?? 24),
		height: Number(values.height ?? env.SNAKE_HEIGHT ?? 18),
		obstacleCount: Number(values.obstacles ?? env.SNAKE_OBSTACLES ?? 12),
		tickIntervalMs: null,
		seed: values.seed ?? env.SNAKE_SEED ?? randomUUID(),
	});
}

export function warnDeprecatedTickConfig(
	env: Record<string, string | undefined>,
) {
	if (env.SNAKE_TICK_MS !== undefined)
		console.warn(
			"SNAKE_TICK_MS is deprecated and unused in response mode; remove it to silence this notice.",
		);
}
