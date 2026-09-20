import { expect, test } from "vitest";
import { createState } from "../server/game/engine.js";
import {
	gameConfig,
	randomBoardSizes,
	watchGameConfig,
	watchBoardSizes,
} from "../server/jev/game-config.js";
import { vectors, type MatchState } from "../shared/snake/types.js";

function verifyWatchLayout(state: MatchState) {
	const { width, height, obstacleCount } = state.config;
	const key = (point: { x: number; y: number }) => `${point.x},${point.y}`;
	const obstacles = new Set(state.obstacles.map(key));
	expect(state.config.layoutVersion).toBe(3);
	expect(state.obstacles).toHaveLength(obstacleCount);
	expect(obstacles.size).toBe(obstacleCount);
	expect(state.snake).toHaveLength(4);
	expect(state.apple).not.toBeNull();
	const occupants = [...state.snake, ...state.obstacles, state.apple!];
	expect(new Set(occupants.map(key)).size).toBe(occupants.length);
	for (const point of occupants) {
		expect(point.x).toBeGreaterThanOrEqual(0);
		expect(point.x).toBeLessThan(width);
		expect(point.y).toBeGreaterThanOrEqual(0);
		expect(point.y).toBeLessThan(height);
	}
	const forward = vectors[state.direction];
	for (const step of [1, 2, 3]) {
		const point = {
			x: state.snake[0].x + forward.x * step,
			y: state.snake[0].y + forward.y * step,
		};
		expect(
			point.x >= 0 && point.x < width && point.y >= 0 && point.y < height,
		).toBe(true);
		expect(obstacles.has(key(point))).toBe(false);
	}
	const colors = [
		Math.ceil((width * height) / 2),
		Math.floor((width * height) / 2),
	];
	for (const point of state.obstacles) colors[(point.x + point.y) % 2]--;
	expect(Math.abs(colors[0] - colors[1])).toBeLessThanOrEqual(1);
	const queue = [state.snake[0]];
	const visited = new Set(queue.map(key));
	for (let index = 0; index < queue.length; index++)
		for (const vector of Object.values(vectors)) {
			const point = {
				x: queue[index].x + vector.x,
				y: queue[index].y + vector.y,
			};
			if (
				point.x < 0 ||
				point.x >= width ||
				point.y < 0 ||
				point.y >= height ||
				obstacles.has(key(point)) ||
				visited.has(key(point))
			)
				continue;
			visited.add(key(point));
			queue.push(point);
		}
	expect(visited.size).toBe(width * height - obstacleCount);
}

test("seeded defaults cover every board size and produce valid repeatable layouts", () => {
	const counts = new Map<string, number>();
	for (let i = 0; i < 600; i++) {
		const env = { SNAKE_SEED: `size-distribution-${i}` };
		const config = gameConfig(env);
		expect(config.layoutVersion).toBe(3);
		expect(gameConfig(env)).toEqual(config);
		const key = `${config.width}x${config.height}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
		const state = createState("test", "test", null, config, "now");
		expect(state.obstacles).toHaveLength(config.obstacleCount);
		expect(state.snake).toHaveLength(4);
		expect(state.apple).not.toBeNull();
		const colors = [
			Math.ceil((config.width * config.height) / 2),
			Math.floor((config.width * config.height) / 2),
		];
		for (const point of state.obstacles) colors[(point.x + point.y) % 2]--;
		expect(Math.abs(colors[0] - colors[1])).toBeLessThanOrEqual(1);
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

test("continuous watch covers six repeatable size tiers with valid v3 layouts", () => {
	const counts = new Map<string, number>();
	expect(watchBoardSizes).toEqual([
		{ width: 8, height: 6 },
		{ width: 8, height: 8 },
		{ width: 10, height: 8 },
		{ width: 12, height: 9 },
		{ width: 14, height: 10 },
		{ width: 16, height: 12 },
	]);
	for (let i = 0; i < 600; i++) {
		const env = { SNAKE_SEED: `watch-gradient-${i}` };
		const config = watchGameConfig(env);
		expect(watchGameConfig(env)).toEqual(config);
		expect(watchBoardSizes).toContainEqual({
			width: config.width,
			height: config.height,
		});
		expect(config.obstacleCount).toBe(
			Math.floor((config.width * config.height) / 36),
		);
		const state = createState("watch-gradient", "test", null, config, "now");
		verifyWatchLayout(state);
		expect(createState("watch-gradient", "test", null, config, "now")).toEqual(
			state,
		);
		const key = `${config.width}x${config.height}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	expect([...counts.keys()].sort()).toEqual([
		"10x8",
		"12x9",
		"14x10",
		"16x12",
		"8x6",
		"8x8",
	]);
	for (const count of counts.values()) {
		expect(count).toBeGreaterThan(60);
		expect(count).toBeLessThan(140);
	}
});

test("watch keeps explicit overrides and the CLI retains its independent original pool", () => {
	const env = {
		SNAKE_SEED: "watch-explicit",
		SNAKE_WIDTH: "24",
		SNAKE_HEIGHT: "18",
		SNAKE_OBSTACLES: "12",
	};
	expect(watchGameConfig(env)).toMatchObject({
		width: 24,
		height: 18,
		obstacleCount: 12,
		seed: "watch-explicit",
	});
	expect(watchGameConfig(env)).toEqual(watchGameConfig(env));
	expect(randomBoardSizes).toEqual([
		{ width: 8, height: 6 },
		{ width: 10, height: 8 },
		{ width: 12, height: 9 },
		{ width: 16, height: 12 },
		{ width: 20, height: 15 },
		{ width: 24, height: 18 },
	]);
});
