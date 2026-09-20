import { createHash, randomUUID } from "node:crypto";
import { newConfigSchema } from "../../shared/snake/schema.js";
import type { ResponseGameConfig } from "../../shared/snake/types.js";

export const randomBoardSizes = [
	{ width: 8, height: 6 },
	{ width: 10, height: 8 },
	{ width: 12, height: 9 },
	{ width: 16, height: 12 },
	{ width: 20, height: 15 },
	{ width: 24, height: 18 },
] as const;

export const watchBoardSizes = [
	{ width: 8, height: 6 },
	{ width: 8, height: 8 },
	{ width: 10, height: 8 },
	{ width: 12, height: 9 },
	{ width: 14, height: 10 },
	{ width: 16, height: 12 },
] as const;

export function watchGameConfig(
	env: Record<string, string | undefined>,
): ResponseGameConfig {
	return gameConfig(env, {}, watchBoardSizes);
}

export function gameConfig(
	env: Record<string, string | undefined>,
	values: Record<string, string | undefined> = {},
	boardSizes: readonly { width: number; height: number }[] = randomBoardSizes,
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
	const seed = values.seed ?? env.SNAKE_SEED ?? randomUUID();
	// Separate from the engine RNG: a seed reproduces both size and layout.
	const sample =
		createHash("sha256")
			.update(`snake-board-size-v1:${seed}`)
			.digest()
			.readUInt32BE(0) / 0x100000000;
	const size = boardSizes[Math.floor(sample * boardSizes.length)];
	const width = Number(values.width ?? env.SNAKE_WIDTH ?? size.width);
	const height = Number(values.height ?? env.SNAKE_HEIGHT ?? size.height);
	return newConfigSchema.parse({
		layoutVersion: 3,
		stepMode,
		decisionMode,
		width,
		height,
		obstacleCount: Number(
			values.obstacles ??
				env.SNAKE_OBSTACLES ??
				Math.floor((width * height) / 36),
		),
		tickIntervalMs: null,
		seed,
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
