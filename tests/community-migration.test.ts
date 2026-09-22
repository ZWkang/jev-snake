import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { Store } from "../server/db/store.js";
import { gameConfig } from "../server/jev/game-config.js";
import { MatchService } from "../server/matches/service.js";
import { removeCommunityFixtureTables } from "./community-fixture";

test("v2 community migration preserves matches, events, channels and receipts", () => {
	const dir = mkdtempSync(join(tmpdir(), "community-migration-")),
		path = join(dir, "game.sqlite");
	try {
		const old = new Store(path),
			service = new MatchService(old, () => 0, false);
		service.create({
			requestId: "migration",
			controlToken: "s".repeat(32),
			agentName: "saved",
			config: gameConfig({}),
		});
		const tables = [
			"matches",
			"match_events",
			"control_requests",
			"watch_channels",
			"watch_rounds",
			"watch_commands",
		];
		const before = tables.map((t) =>
			old.db.prepare(`SELECT * FROM ${t}`).all(),
		);
		removeCommunityFixtureTables(old.db);
		service.close();
		old.close();
		for (let i = 0; i < 2; i++) {
			const upgraded = new Store(path);
			expect(upgraded.db.pragma("user_version", { simple: true })).toBe(3);
			expect(
				tables.map((t) => upgraded.db.prepare(`SELECT * FROM ${t}`).all()),
			).toEqual(before);
			expect(
				upgraded.db.prepare("SELECT * FROM contributed_credentials").all(),
			).toEqual([]);
			upgraded.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
test("failed v3 migration is atomic and keeps the v2 database", () => {
	const dir = mkdtempSync(join(tmpdir(), "community-failed-")),
		path = join(dir, "game.sqlite");
	try {
		const old = new Store(path);
		removeCommunityFixtureTables(old.db);
		old.db.exec(
			"CREATE TABLE credential_attempts (value TEXT); INSERT INTO credential_attempts VALUES ('keep');",
		);
		old.close();
		expect(() => new Store(path)).toThrow();
		const db = new Database(path);
		expect(db.pragma("user_version", { simple: true })).toBe(2);
		expect(db.prepare("SELECT * FROM credential_attempts").all()).toEqual([
			{ value: "keep" },
		]);
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE name='community_feedback'",
				)
				.get(),
		).toBeUndefined();
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
