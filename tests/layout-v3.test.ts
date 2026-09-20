import { afterEach, expect, test } from "vitest";
import { Store } from "../server/db/store.js";
import { createState } from "../server/game/engine.js";
import { gameConfig, randomBoardSizes } from "../server/jev/game-config.js";
import { digest, MatchService } from "../server/matches/service.js";
import { configSchema, newConfigSchema } from "../shared/snake/schema.js";
import {
	publicState,
	vectors,
	type GameConfig,
	type MatchEvent,
	type MatchState,
} from "../shared/snake/types.js";

const dispose: (() => void)[] = [];
afterEach(() => {
	for (const close of dispose.splice(0).reverse()) close();
});

function config(layoutVersion?: 2 | 3): GameConfig {
	return {
		width: 10,
		height: 8,
		obstacleCount: 2,
		seed: "size-distribution-1",
		stepMode: "response",
		tickIntervalMs: null,
		...(layoutVersion ? { layoutVersion } : {}),
	};
}
function geometry(state: MatchState) {
	return {
		snake: state.snake,
		direction: state.direction,
		obstacles: state.obstacles,
		apple: state.apple,
		rngState: state.rngState,
	};
}
function colorCounts(state: MatchState) {
	const obstacle = new Set(state.obstacles.map((p) => `${p.x},${p.y}`));
	const colors = [0, 0];
	for (let y = 0; y < state.config.height; y++)
		for (let x = 0; x < state.config.width; x++)
			if (!obstacle.has(`${x},${y}`)) colors[(x + y) % 2]++;
	return colors;
}
function verifyLayout(state: MatchState) {
	const { width, height, obstacleCount } = state.config;
	const obstacle = new Set(state.obstacles.map((p) => `${p.x},${p.y}`));
	expect(state.obstacles).toHaveLength(obstacleCount);
	expect(obstacle.size).toBe(obstacleCount);
	const [even, odd] = colorCounts(state);
	expect(Math.abs(even - odd)).toBeLessThanOrEqual(1);
	const vector = vectors[state.direction];
	const protectedCells = [
		...state.snake,
		...[1, 2, 3].map((step) => ({
			x: state.snake[0].x + vector.x * step,
			y: state.snake[0].y + vector.y * step,
		})),
	];
	for (const point of protectedCells)
		expect(obstacle.has(`${point.x},${point.y}`)).toBe(false);
	for (const point of state.obstacles) {
		expect(point.x).toBeGreaterThan(0);
		expect(point.x).toBeLessThan(width - 1);
		expect(point.y).toBeGreaterThan(0);
		expect(point.y).toBeLessThan(height - 1);
	}
	const visited = new Set(["0,0"]);
	const queue = [{ x: 0, y: 0 }];
	for (let index = 0; index < queue.length; index++)
		for (const vector of Object.values(vectors)) {
			const point = {
				x: queue[index].x + vector.x,
				y: queue[index].y + vector.y,
			};
			const key = `${point.x},${point.y}`;
			if (
				point.x < 0 ||
				point.y < 0 ||
				point.x >= width ||
				point.y >= height ||
				obstacle.has(key) ||
				visited.has(key)
			)
				continue;
			visited.add(key);
			queue.push(point);
		}
	expect(visited.size).toBe(width * height - obstacleCount);
}

test("missing and v2 layouts retain their exact historical geometry and RNG", () => {
	expect(geometry(createState("old", "test", null, config(), "now"))).toEqual({
		snake: [
			{ x: 3, y: 4 },
			{ x: 2, y: 4 },
			{ x: 1, y: 4 },
			{ x: 0, y: 4 },
		],
		direction: "right",
		obstacles: [
			{ x: 4, y: 5 },
			{ x: 7, y: 5 },
		],
		apple: { x: 5, y: 7 },
		rngState: 4168666661,
	});
	expect(geometry(createState("old", "test", null, config(2), "now"))).toEqual({
		snake: [
			{ x: 6, y: 4 },
			{ x: 6, y: 3 },
			{ x: 6, y: 2 },
			{ x: 6, y: 1 },
		],
		direction: "down",
		obstacles: [
			{ x: 3, y: 1 },
			{ x: 8, y: 2 },
		],
		apple: { x: 9, y: 3 },
		rngState: 1073429508,
	});
});

test("v3 excludes the proven color-imbalanced map without claiming a winning strategy", () => {
	const old = createState("old", "test", null, config(2), "now");
	expect(colorCounts(old)).toEqual([38, 40]);
	const current = createState("new", "test", null, config(3), "now");
	expect(colorCounts(current)).toEqual([39, 39]);
	expect(current.snake).toEqual(old.snake);
	expect(current.direction).toBe(old.direction);
	verifyLayout(current);
	expect(
		geometry(createState("repeat", "test", null, config(3), "later")),
	).toEqual(geometry(current));
});

test.each([
	...randomBoardSizes,
	{ width: 7, height: 7 },
	{ width: 7, height: 1 },
])(
	"v3 keeps color balance, connectivity and protected spawn across seeds on $width x $height",
	({ width, height }) => {
		for (let index = 0; index < 24; index++) {
			const options = gameConfig(
				{},
				{
					width: String(width),
					height: String(height),
					seed: `balanced-${index}`,
				},
			);
			expect(options.layoutVersion).toBe(3);
			const state = createState("new", "test", null, options, "now");
			verifyLayout(state);
			expect(
				geometry(createState("repeat", "test", null, options, "later")),
			).toEqual(geometry(state));
		}
	},
);

test("unfulfillable obstacle requests fail instead of reducing the requested map", () => {
	const impossible: GameConfig = {
		...config(3),
		width: 7,
		height: 1,
		obstacleCount: 1,
	};
	const original = structuredClone(impossible);
	expect(() => createState("bad", "test", null, impossible, "now")).toThrow(
		"Obstacle count exceeds available interior cells",
	);
	expect(impossible).toEqual(original);
});

test("v3 reports an impossible connected layout without dropping obstacles", () => {
	// 352 interior cells minus the seven protected runway/body cells leaves
	// 345 requested obstacles. The protected cells lie away from the perimeter,
	// so removing all other interior cells would disconnect that runway.
	const impossible: GameConfig = {
		...config(3),
		width: 24,
		height: 18,
		obstacleCount: 345,
		seed: "disconnected-0",
	};
	const original = structuredClone(impossible);
	expect(() => createState("bad", "test", null, impossible, "now")).toThrow(
		"Cannot satisfy obstacle count, checkerboard balance and connectivity",
	);
	expect(impossible).toEqual(original);
});

test("new API/CLI defaults are v3 while historical config parsing does not add a version", () => {
	expect(configSchema.parse(config())).not.toHaveProperty("layoutVersion");
	expect(configSchema.parse(config(2)).layoutVersion).toBe(2);
	expect(newConfigSchema.parse(config()).layoutVersion).toBe(3);
	expect(newConfigSchema.parse(config(2)).layoutVersion).toBe(2);
	expect(gameConfig({ SNAKE_SEED: "size-distribution-1" }).layoutVersion).toBe(
		3,
	);
	const store = new Store(":memory:");
	const service = new MatchService(store, () => 0, false);
	dispose.push(() => {
		service.close();
		store.close();
	});
	const state = service.create({
		requestId: "new-api-default",
		controlToken: "new-api-token".repeat(3),
		agentName: "New API",
		config: config(),
	});
	expect(state.config.layoutVersion).toBe(3);
	verifyLayout(store.get(state.id));
});

test("old response creation retries and forks preserve missing layout version and RNG", () => {
	const store = new Store(":memory:");
	const token = "historical-response-token".repeat(2);
	const creation = {
		requestId: "old-response-create",
		controlToken: token,
		agentName: "Historical agent",
		config: config(),
	};
	// Exact normalized order/defaults used before layout v3. In particular,
	// decisionMode was defaulted while layoutVersion remained absent.
	const oldNormalized = {
		requestId: creation.requestId,
		controlToken: digest(token),
		agentName: creation.agentName,
		model: null,
		config: {
			stepMode: "response" as const,
			decisionMode: "single_step" as const,
			width: 10,
			height: 8,
			obstacleCount: 2,
			tickIntervalMs: null,
			seed: "size-distribution-1",
		},
	};
	const state = createState(
		"historical-missing-layout",
		creation.agentName,
		null,
		oldNormalized.config,
		"then",
	);
	state.seq = 0;
	const event: MatchEvent = {
		matchId: state.id,
		seq: 0,
		tick: 0,
		gameTimeMs: 0,
		createdAt: "then",
		type: "created",
		data: { seed: state.config.seed },
		state: publicState(state),
	};
	store.create(
		state,
		digest(token),
		creation.requestId,
		digest(JSON.stringify(oldNormalized)),
		event,
	);
	const service = new MatchService(store, () => 0, false);
	dispose.push(() => {
		service.close();
		store.close();
	});
	const before = structuredClone(store.get(state.id));
	expect(service.create(creation)).toEqual(publicState(before));
	expect(store.get(state.id)).toEqual(before);
	expect(() =>
		service.create({
			...creation,
			config: { ...creation.config, layoutVersion: 3 },
		}),
	).toThrow("different content");
	const fork = service.fork(state.id, {
		requestId: "historical-fork",
		controlToken: "fork-token".repeat(4),
		agentName: "Fork",
		sourceSeq: 0,
	});
	expect(fork.config).not.toHaveProperty("layoutVersion");
	expect(geometry(store.get(fork.id))).toEqual(geometry(before));
	expect(store.get(state.id)).toEqual(before);
});
