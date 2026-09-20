import { expect, test } from "vitest";
import { createState, move } from "../server/game/engine.js";
import { jevConfig } from "../server/jev/config.js";
import { ProgressHistory } from "../server/jev/progress.js";
import {
	defaultStagnationSettings,
	evaluateStagnation,
	parseStagnationSettings,
} from "../server/jev/stagnation.js";
import {
	directions,
	publicState,
	type DecisionProgress,
	type Direction,
	type PublicState,
} from "../shared/snake/types.js";

function state() {
	const s = createState(
		"stagnation",
		"test",
		null,
		{
			width: 7,
			height: 5,
			obstacleCount: 0,
			seed: "stagnation-tests",
			stepMode: "response",
			tickIntervalMs: null,
		},
		"now",
	);
	s.status = "running";
	s.snake = [
		{ x: 1, y: 1 },
		{ x: 1, y: 2 },
		{ x: 2, y: 2 },
		{ x: 2, y: 1 },
	];
	s.direction = "up";
	s.apple = { x: 1, y: 0 };
	return s;
}

function progress(
	s: Pick<PublicState, "tick">,
	moves: number,
	visits = 1,
): DecisionProgress {
	return {
		historyVersion: "progress-v1",
		historyStartTick: 0,
		throughTick: s.tick,
		lastAppleTick: s.tick - moves,
		movesSinceApple: moves,
		positionVisits: visits,
		previousVisitTick: null,
		repeatAfterMoves: null,
		actions: Object.fromEntries(
			directions.map((d) => [
				d,
				{ timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
			]),
		) as DecisionProgress["actions"],
	};
}

test("the third visit triggers exactly at the configured limit and takes precedence", () => {
	const s = state();
	s.tick = 70;
	expect(evaluateStagnation(s, progress(s, 8, 2))).toBeNull();
	expect(evaluateStagnation(s, progress(s, 8, 3))).toEqual({
		reason: "stagnation_loop",
		observedTick: 70,
		movesSinceApple: 8,
		positionVisits: 3,
		maxPositionVisits: 3,
		maxMovesWithoutApple: 70,
	});
	expect(evaluateStagnation(s, progress(s, 70, 3))!.reason).toBe(
		"stagnation_loop",
	);
	expect(
		evaluateStagnation(s, progress(s, 8, 3), {
			...defaultStagnationSettings,
			maxPositionVisits: 4,
		}),
	).toBeNull();
	expect(
		evaluateStagnation(s, progress(s, 8, 4), {
			...defaultStagnationSettings,
			maxPositionVisits: 4,
		})!.reason,
	).toBe("stagnation_loop");
});

test.each([
	[7, 4, 0, 64],
	[8, 8, 1, 126],
	[10, 8, 2, 156],
] as const)(
	"automatic no-apple limit follows %sx%s traversable area",
	(width, height, count, expected) => {
		const s = state();
		s.config = { ...s.config, width, height, obstacleCount: 99 };
		s.obstacles = Array.from({ length: count }, (_, x) => ({ x: x + 4, y: 3 }));
		s.tick = expected;
		expect(evaluateStagnation(s, progress(s, expected - 1))).toBeNull();
		expect(evaluateStagnation(s, progress(s, expected))).toEqual({
			reason: "stagnation_no_apple",
			observedTick: expected,
			movesSinceApple: expected,
			positionVisits: 1,
			maxPositionVisits: 3,
			maxMovesWithoutApple: expected,
		});
	},
);

test("explicit no-apple limit overrides board size and can be disabled", () => {
	const s = state();
	s.tick = 200;
	const settings = { ...defaultStagnationSettings, maxMovesWithoutApple: 17 };
	expect(evaluateStagnation(s, progress(s, 16), settings)).toBeNull();
	expect(evaluateStagnation(s, progress(s, 17), settings)).toMatchObject({
		reason: "stagnation_no_apple",
		maxMovesWithoutApple: 17,
	});
	expect(
		evaluateStagnation(s, progress(s, 200, 20), {
			...settings,
			enabled: false,
		}),
	).toBeNull();
});

test("a mismatched observation is an explicit integrity error, including when disabled", () => {
	const s = state();
	s.tick = 4;
	const stale = progress({ tick: 3 }, 3);
	expect(() => evaluateStagnation(s, stale)).toThrow(
		"does not match observed tick",
	);
	expect(() =>
		evaluateStagnation(s, stale, {
			...defaultStagnationSettings,
			enabled: false,
		}),
	).toThrow("does not match observed tick");
});

test("environment settings are explicit and absent settings preserve the existing config shape", () => {
	expect(parseStagnationSettings({})).toEqual({
		enabled: true,
		maxPositionVisits: 3,
		maxMovesWithoutApple: null,
	});
	expect(jevConfig({})).not.toHaveProperty("stagnationGuard");
	expect(jevConfig({ JEV_STAGNATION_GUARD: "true" }).stagnationGuard).toEqual(
		defaultStagnationSettings,
	);
	expect(jevConfig({ JEV_STAGNATION_GUARD: "false" }).stagnationGuard).toEqual({
		...defaultStagnationSettings,
		enabled: false,
	});
	expect(
		jevConfig({
			JEV_STAGNATION_MAX_VISITS: "5",
			JEV_STAGNATION_MAX_NO_APPLE_MOVES: "240",
		}).stagnationGuard,
	).toEqual({ enabled: true, maxPositionVisits: 5, maxMovesWithoutApple: 240 });
});

test.each([
	["JEV_STAGNATION_GUARD", "0"],
	["JEV_STAGNATION_GUARD", "FALSE"],
	["JEV_STAGNATION_MAX_VISITS", "1"],
	["JEV_STAGNATION_MAX_VISITS", "3.5"],
	["JEV_STAGNATION_MAX_VISITS", "3e0"],
	["JEV_STAGNATION_MAX_VISITS", " 3"],
	["JEV_STAGNATION_MAX_NO_APPLE_MOVES", "0"],
	["JEV_STAGNATION_MAX_NO_APPLE_MOVES", ""],
	["JEV_STAGNATION_MAX_NO_APPLE_MOVES", "-5"],
	["JEV_STAGNATION_MAX_NO_APPLE_MOVES", "9007199254740992"],
])(
	"invalid %s=%s fails configuration rather than silently disabling protection",
	(key, value) => {
		expect(() => parseStagnationSettings({ [key]: value })).toThrow(key);
		expect(() => jevConfig({ [key]: value })).toThrow(key);
	},
);

test("disabled protection still rejects malformed supplied thresholds", () => {
	expect(() =>
		parseStagnationSettings({
			JEV_STAGNATION_GUARD: "false",
			JEV_STAGNATION_MAX_VISITS: "0",
		}),
	).toThrow("JEV_STAGNATION_MAX_VISITS");
});

test("real repeated body visits count once per tick, and eating clears stagnation", () => {
	const s = state();
	const history = new ProgressHistory();
	history.observe(publicState(s));
	history.observe(publicState(s));
	expect(history.snapshot(publicState(s)).positionVisits).toBe(1);
	const cycle: Direction[] = ["right", "down", "left", "up"];
	for (let i = 0; i < 8; i++) {
		move(s, cycle[i % cycle.length]);
		history.observe(publicState(s));
		history.observe(publicState(s));
		const p = history.snapshot(publicState(s));
		if (i < 7) expect(evaluateStagnation(s, p)).toBeNull();
	}
	const p = history.snapshot(publicState(s));
	expect(p).toMatchObject({
		throughTick: 8,
		movesSinceApple: 8,
		positionVisits: 3,
		previousVisitTick: 4,
		repeatAfterMoves: 4,
	});
	expect(evaluateStagnation(s, p)!.reason).toBe("stagnation_loop");
	move(s, "up");
	expect(s.applesEaten).toBe(1);
	history.observe(publicState(s));
	const reset = history.snapshot(publicState(s));
	expect(reset).toMatchObject({
		throughTick: 9,
		lastAppleTick: 9,
		movesSinceApple: 0,
		positionVisits: 1,
		previousVisitTick: null,
		repeatAfterMoves: null,
	});
	expect(evaluateStagnation(s, reset)).toBeNull();
});

test("rebuilding history from committed snapshots preserves the same stop evidence", () => {
	const s = state();
	const original = new ProgressHistory();
	const snapshots: PublicState[] = [];
	function record() {
		const p = publicState(s);
		snapshots.push(p, structuredClone(p));
		original.observe(p);
		original.observe(p);
	}
	record();
	const cycle: Direction[] = ["right", "down", "left", "up"];
	for (let i = 0; i < 8; i++) {
		move(s, cycle[i % 4]);
		record();
	}
	const restored = new ProgressHistory();
	for (const snapshot of snapshots) restored.observe(snapshot);
	expect(restored.snapshot(publicState(s))).toEqual(
		original.snapshot(publicState(s)),
	);
	expect(evaluateStagnation(s, restored.snapshot(publicState(s)))).toEqual(
		evaluateStagnation(s, original.snapshot(publicState(s))),
	);
	expect(
		evaluateStagnation(s, restored.snapshot(publicState(s))),
	).toMatchObject({ reason: "stagnation_loop", observedTick: 8 });
});

test("evaluation reads history without changing the state, counters, or selected action", () => {
	const s = publicState(state());
	s.tick = 80;
	const p = progress(s, 80, 3);
	const before = structuredClone({ s, p });
	Object.freeze(s.config);
	Object.freeze(s.obstacles);
	Object.freeze(s);
	Object.freeze(p);
	evaluateStagnation(s, p);
	expect({ s, p }).toEqual(before);
});
