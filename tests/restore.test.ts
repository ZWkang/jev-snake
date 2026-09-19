import { describe, expect, test } from "vitest";
import { GameError } from "../server/errors.js";
import { createState, expireStar, move } from "../server/game/engine.js";
import { restoreMatchAt } from "../server/matches/restore.js";
import {
	type Direction,
	type GameConfig,
	isResponseMode,
	type MatchEvent,
	type MatchState,
	publicState,
} from "../shared/snake/types.js";

const responseConfig: GameConfig = {
	width: 8,
	height: 6,
	obstacleCount: 0,
	seed: "restore-random-rewards",
	stepMode: "response",
	tickIntervalMs: null,
};

function history(config = responseConfig) {
	const state = createState(
		"source",
		"Original agent",
		"jev-test",
		config,
		"now",
	);
	const events: MatchEvent[] = [];
	function emit(type: string, data: Record<string, unknown> = {}) {
		state.seq++;
		events.push({
			matchId: state.id,
			seq: state.seq,
			tick: state.tick,
			gameTimeMs: state.gameTimeMs,
			createdAt: `event-${state.seq}`,
			type,
			data,
			state: publicState(state),
		});
	}
	function step(direction: Direction, at = state.gameTimeMs + 137) {
		if (state.star && state.star.expiresAt <= at) {
			state.gameTimeMs = state.star.expiresAt;
			expireStar(state, state.gameTimeMs);
			emit("star_expired");
		}
		state.gameTimeMs = at;
		const result = move(state, direction);
		if (isResponseMode(state.config)) {
			state.lastStepDurationMs = at - (state.lastMoveGameTimeMs as number);
			state.lastMoveGameTimeMs = at;
		}
		emit(result.type, result.data);
	}
	function start() {
		state.status = "running";
		state.startedAt = "started";
		emit("started");
	}
	emit("created", { seed: state.config.seed });
	return { state, events, emit, step, start };
}

// A test-only Hamiltonian cycle exercises real randomized rewards without
// injecting food, changing the seed, or making assumptions about its location.
function cycleDirection(state: MatchState): Direction {
	const { x, y } = state.snake[0];
	const { width, height } = state.config;
	if (x === 0) return y === height - 1 ? "right" : "down";
	if (y % 2 === 1) return x === width - 1 ? "up" : "right";
	return x === 1 ? (y === 0 ? "left" : "up") : "left";
}

function reachApples(f: ReturnType<typeof history>, count: number) {
	while (f.state.applesEaten < count && f.state.tick < 2000) {
		f.step(cycleDirection(f.state));
		expect(f.state.status).toBe("running");
	}
	expect(f.state.applesEaten).toBe(count);
}

describe("historical match restoration", () => {
	test("reconstructs RNG and exact response time through random rewards and star expiration", () => {
		const f = history();
		f.start();
		reachApples(f, 5);
		expect(f.state.star).not.toBeNull();
		const lastMoveAt = f.state.gameTimeMs;
		f.state.gameTimeMs = f.state.star!.expiresAt;
		expireStar(f.state, f.state.gameTimeMs);
		f.emit("star_expired");
		const originalEvents = structuredClone(f.events);
		const restored = restoreMatchAt(f.events, f.state.seq);
		expect(publicState(restored)).toEqual(publicState(f.state));
		expect(restored.rngState).toBe(f.state.rngState);
		expect(restored.lastMoveGameTimeMs).toBe(lastMoveAt);
		expect(restored.lastMoveGameTimeMs).not.toBe(restored.gameTimeMs);
		expect(f.events).toEqual(originalEvents);

		const rngBefore = restored.rngState;
		while (f.state.applesEaten < 8) {
			const direction = cycleDirection(f.state);
			const at = f.state.gameTimeMs + 173;
			if (restored.star) expireStar(restored, at);
			restored.gameTimeMs = at;
			const result = move(restored, direction);
			f.step(direction, at);
			expect(result.type).toBe(f.events.at(-1)!.type);
			expect(restored).toMatchObject({
				snake: f.state.snake,
				apple: f.state.apple,
				star: f.state.star,
				score: f.state.score,
				rngState: f.state.rngState,
			});
		}
		expect(restored.rngState).not.toBe(rngBefore);
		restored.config.seed = "changed clone";
		expect(f.events[0].state.config.seed).toBe(responseConfig.seed);
	});

	test.each<GameConfig>([
		{ ...responseConfig },
		{ ...responseConfig, stepMode: "fixed", tickIntervalMs: 250 },
		{
			...responseConfig,
			stepMode: "fixed",
			tickIntervalMs: 250,
			decisionMode: "two_step_fallback",
		},
	])(
		"supports original record modes and clears scheduled controls: %j",
		(config) => {
			const f = history(config);
			f.start();
			f.step("right", 250);
			f.events.at(-1)!.state.scheduledActions = [
				{
					requestId: "old-control",
					targetTick: 2,
					direction: "up",
					eligible: true,
				},
			];
			const restored = restoreMatchAt(f.events, f.state.seq);
			expect(restored.pending).toEqual([]);
			expect(restored.plans).toEqual(
				config.decisionMode === "two_step_fallback" ? [] : undefined,
			);
			expect(restored).not.toHaveProperty("scheduledActions");
			expect(restored.lastMoveGameTimeMs).toBe(
				isResponseMode(config) ? 250 : undefined,
			);
			expect(restored.rngState).toBe(f.state.rngState);
		},
	);

	test("preserves target metadata and supports a remapped prefix containing forked", () => {
		const f = history();
		f.start();
		f.step("right", 300);
		f.state.status = "ready";
		f.state.agentName = "Fork agent";
		f.state.startedAt = null;
		f.emit("forked", { sourceMatchId: "source", sourceSeq: 2 });
		const prefix = structuredClone(f.events);
		for (const event of prefix) {
			event.matchId = "fork";
			event.state.id = "fork";
		}
		const restored = restoreMatchAt(prefix, prefix.length - 1);
		expect(restored).toMatchObject({
			id: "fork",
			agentName: "Fork agent",
			status: "ready",
			startedAt: null,
			gameTimeMs: 300,
			lastMoveGameTimeMs: 300,
			rngState: f.state.rngState,
		});
	});

	test("restores the live prefix before a collision and rejects terminal targets", () => {
		const f = history();
		f.start();
		while (f.state.status === "running") f.step("right");
		expect(f.events.at(-1)!.type).toBe("gameover");
		const livePrefix = f.events.slice(0, -1);
		const restored = restoreMatchAt(livePrefix, livePrefix.length - 1);
		expect(restored.status).toBe("running");
		expect(() => restoreMatchAt(f.events, f.state.seq)).toThrow(
			"Cannot resume a gameover event",
		);
		const forged = structuredClone(f.events);
		forged.at(-1)!.state.status = "running";
		expect(() => restoreMatchAt(forged, forged.length - 1)).toThrow(
			"movement outcome",
		);
	});

	test("replays legacy winning events without a data direction before rejecting the terminal target", () => {
		const f = history();
		f.start();
		while (f.state.status === "running" && f.state.tick < 4000)
			f.step(cycleDirection(f.state));
		expect(f.state.status).toBe("won");
		expect(f.events.at(-1)!.data).not.toHaveProperty("direction");
		expect(() => restoreMatchAt(f.events, f.state.seq)).toThrow(
			"Cannot resume a won event",
		);
	});

	test("rejects missing, duplicated, cross-match, or mismatched event sequences", () => {
		const f = history();
		f.start();
		f.step("right");
		for (const target of [-1, 0.5, Number.NaN])
			expect(() => restoreMatchAt(f.events, target)).toThrow(GameError);
		expect(() => restoreMatchAt(f.events.slice(1), 2)).toThrow(
			"complete prefix",
		);
		for (const alter of [
			(event: MatchEvent) => (event.seq = 1),
			(event: MatchEvent) => (event.state.seq = 1),
			(event: MatchEvent) => (event.matchId = "different"),
			(event: MatchEvent) => (event.tick = 99),
			(event: MatchEvent) => (event.gameTimeMs = -1),
		]) {
			const corrupt = structuredClone(f.events);
			alter(corrupt[2]);
			expect(() => restoreMatchAt(corrupt, 2)).toThrow(GameError);
		}
	});

	test("reports the exact divergent field and unknown versions without replacing RNG", () => {
		const f = history();
		f.start();
		f.step("right");
		for (const [field, value] of [
			["apple", { x: -1, y: -1 }],
			["score", 999],
			["applesEaten", 999],
			["direction", "up"],
			["config", { ...responseConfig, seed: "different" }],
			["rulesVersion", 999],
		] as const) {
			const corrupt = structuredClone(f.events);
			Object.assign(corrupt[2].state, { [field]: value });
			expect(() => restoreMatchAt(corrupt, 2)).toThrow(
				`event 2 does not reproduce ${field}`,
			);
		}
		const unsupported = structuredClone(f.events);
		Object.assign(unsupported[0].state, { recordVersion: 99 });
		expect(() => restoreMatchAt(unsupported, 2)).toThrow(
			"unsupported record or rules version",
		);
		const invalidMove = structuredClone(f.events);
		invalidMove[2].data.direction = "left";
		expect(() => restoreMatchAt(invalidMove, 2)).toThrow(
			"cannot replay movement",
		);
		const falseExpiry = structuredClone(f.events);
		falseExpiry[2].type = "star_expired";
		expect(() => restoreMatchAt(falseExpiry, 2)).toThrow(
			"does not expire an existing star",
		);
	});
});
