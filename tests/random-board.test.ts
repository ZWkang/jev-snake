import { expect, test } from "vitest";
import { createState } from "../server/game/engine.js";
import { gameConfig, randomBoardSizes } from "../server/jev/game-config.js";

test("seeded defaults cover every board size and produce valid repeatable layouts", () => {
	const counts = new Map<string, number>();
	for (let i = 0; i < 600; i++) {
		const env = { SNAKE_SEED: `size-distribution-${i}` };
		const config = gameConfig(env);
		expect(gameConfig(env)).toEqual(config);
		const key = `${config.width}x${config.height}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
		const state = createState("test", "test", null, config, "now");
		expect(state.obstacles).toHaveLength(config.obstacleCount);
		expect(state.snake).toHaveLength(4);
		expect(state.apple).not.toBeNull();
	}
	expect(counts.size).toBe(randomBoardSizes.length);
	for (const count of counts.values()) {
		expect(count).toBeGreaterThan(60);
		expect(count).toBeLessThan(140);
	}
});

test("explicit sizes and obstacle counts override randomized defaults", () => {
	expect(
		gameConfig(
			{ SNAKE_WIDTH: "24", SNAKE_HEIGHT: "18", SNAKE_OBSTACLES: "12" },
			{ width: "12", height: "9", obstacles: "3" },
		),
	).toMatchObject({ width: 12, height: 9, obstacleCount: 3 });
	expect(gameConfig({ SNAKE_WIDTH: "7", SNAKE_HEIGHT: "1" })).toMatchObject({
		width: 7,
		height: 1,
		obstacleCount: 0,
	});
});
