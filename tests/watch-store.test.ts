import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { Store } from "../server/db/store.js";
import { gameConfig } from "../server/jev/game-config.js";
import { MatchService } from "../server/matches/service.js";
import { WatchStore } from "../server/watch/store.js";
import {
	initialWatchState,
	watchCommandSchema,
	watchSnapshotSchema,
} from "../shared/snake/watch.js";

test("channel schema rejects contradictory phases and secret fields", () => {
	const s = initialWatchState(0);
	expect(watchSnapshotSchema.parse(s)).toEqual(s);
	for (const bad of [
		{ ...s, phase: "running" },
		{ ...s, nextStartAt: 1 },
		{ ...s, enabled: true },
		{ ...s, controlToken: "private" },
	])
		expect(watchSnapshotSchema.safeParse(bad).success).toBe(false);
	expect(
		watchCommandSchema.safeParse({ requestId: "one", enabled: true }).success,
	).toBe(true);
	expect(
		watchCommandSchema.safeParse({ requestId: "one", toggle: true }).success,
	).toBe(false);
});

test("v1 migration preserves old single, plan and response JSON and runs once", () => {
	const dir = mkdtempSync(join(tmpdir(), "watch-migration-")),
		file = join(dir, "game.sqlite");
	try {
		const original = new Store(file),
			service = new MatchService(original, () => 0, false);
		for (const [i, config] of [
			gameConfig({}, { "decision-mode": "single_step" }),
			gameConfig({}),
			gameConfig({ SNAKE_STEP_MODE: "response" }),
		].entries())
			service.create({
				requestId: `old-${i}`,
				controlToken: "s".repeat(32),
				agentName: "old",
				config,
			});
		const states = original.db
				.prepare("SELECT * FROM matches ORDER BY id")
				.all(),
			events = original.db
				.prepare("SELECT * FROM match_events ORDER BY match_id,seq")
				.all();
		original.db.exec(
			"DROP TABLE watch_commands; DROP TABLE watch_rounds; DROP TABLE watch_channels; PRAGMA user_version=1;",
		);
		service.close();
		original.close();
		for (let i = 0; i < 2; i++) {
			const upgraded = new Store(file);
			expect(upgraded.db.pragma("user_version", { simple: true })).toBe(2);
			expect(
				upgraded.db.prepare("SELECT * FROM matches ORDER BY id").all(),
			).toEqual(states);
			expect(
				upgraded.db
					.prepare("SELECT * FROM match_events ORDER BY match_id,seq")
					.all(),
			).toEqual(events);
			expect(new WatchStore(upgraded.db).read().snapshot).toMatchObject({
				enabled: false,
				phase: "stopped",
			});
			upgraded.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("migration failure rolls back instead of replacing the old database", () => {
	const dir = mkdtempSync(join(tmpdir(), "watch-migration-failure-")),
		file = join(dir, "game.sqlite");
	try {
		const old = new Database(file);
		old.exec(
			"PRAGMA user_version=1; CREATE TABLE watch_rounds (old_value TEXT); INSERT INTO watch_rounds VALUES ('keep');",
		);
		old.close();
		expect(() => new Store(file)).toThrow();
		const inspect = new Database(file);
		expect(inspect.pragma("user_version", { simple: true })).toBe(1);
		expect(inspect.prepare("SELECT * FROM watch_rounds").all()).toEqual([
			{ old_value: "keep" },
		]);
		expect(
			inspect
				.prepare("SELECT name FROM sqlite_master WHERE name='watch_channels'")
				.get(),
		).toBeUndefined();
		inspect.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("match creation, channel claim and event roll back together before publication", () => {
	const store = new Store(":memory:"),
		service = new MatchService(store, () => 0, false),
		channel = new WatchStore(store.db);
	const state = channel.read();
	state.snapshot = {
		...state.snapshot,
		enabled: true,
		phase: "starting",
		revision: 1,
	};
	channel.write(state);
	let publications = 0;
	service.subscribe(() => publications++);
	store.db.exec(
		"CREATE TRIGGER fail_round BEFORE INSERT ON watch_rounds BEGIN SELECT RAISE(ABORT,'injected claim failure'); END;",
	);
	const input = {
		requestId: "claim",
		controlToken: "s".repeat(32),
		agentName: "channel",
		config: gameConfig({}),
	};
	const claim = (id: string) =>
		channel.assign(
			{
				...state,
				generation: 1,
				config: input.config,
				snapshot: { ...state.snapshot, currentMatchId: id, revision: 2 },
			},
			id,
		);
	expect(() => service.create(input, claim)).toThrow("injected claim failure");
	expect(store.list().matches).toHaveLength(0);
	expect(publications).toBe(0);
	expect(channel.read().snapshot.revision).toBe(1);
	store.db.exec("DROP TRIGGER fail_round");
	const created = service.create(input, claim);
	expect(channel.read().snapshot.currentMatchId).toBe(created.id);
	expect(channel.owned(created.id)).toBe(true);
	expect(publications).toBe(1);
	service.close();
	store.close();
});

test("shared config preserves existing modes, overrides, seeds and validation", () => {
	expect(gameConfig({})).toMatchObject({
		stepMode: "fixed",
		decisionMode: "two_step_fallback",
		tickIntervalMs: 300,
	});
	expect(
		gameConfig({ SNAKE_STEP_MODE: "response", SNAKE_TICK_MS: "bad" }),
	).toMatchObject({
		stepMode: "response",
		decisionMode: "single_step",
		tickIntervalMs: null,
	});
	expect(gameConfig({ SNAKE_SEED: "fixed" }).seed).toBe("fixed");
	expect(gameConfig({}).seed).not.toBe(gameConfig({}).seed);
	expect(gameConfig({ SNAKE_WIDTH: "12" }, { width: "9" }).width).toBe(9);
	expect(() =>
		gameConfig({ SNAKE_STEP_MODE: "response" }, { "tick-ms": "100" }),
	).toThrow("cannot be combined");
	expect(() =>
		gameConfig(
			{ SNAKE_STEP_MODE: "response" },
			{ "decision-mode": "two_step_fallback" },
		),
	).toThrow("cannot use");
	expect(() => gameConfig({ SNAKE_WIDTH: "bad" })).toThrow();
});
