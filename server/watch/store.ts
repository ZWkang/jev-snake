import type Database from "better-sqlite3";
import { z } from "zod";
import { configSchema } from "../../shared/snake/schema.js";
import {
	initialWatchState,
	watchReceiptSchema,
	watchSnapshotSchema,
	type WatchReceipt,
} from "../../shared/snake/watch.js";
import { GameError } from "../errors.js";

const recordSchema = z
	.object({
		snapshot: watchSnapshotSchema,
		generation: z.number().int().nonnegative(),
		config: configSchema.nullable(),
	})
	.strict();
export type WatchRecord = z.infer<typeof recordSchema>;

export function migrateWatch(db: Database.Database) {
	db.transaction(() => {
		db.exec(`
			CREATE TABLE watch_channels (id TEXT PRIMARY KEY CHECK (id='main'), state_json TEXT NOT NULL);
			CREATE TABLE watch_rounds (channel_id TEXT NOT NULL REFERENCES watch_channels(id), generation INTEGER NOT NULL, match_id TEXT NOT NULL UNIQUE REFERENCES matches(id), PRIMARY KEY(channel_id,generation));
			CREATE TABLE watch_commands (request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, receipt_json TEXT NOT NULL);
			PRAGMA user_version = 2;
		`);
		db.prepare("INSERT INTO watch_channels VALUES ('main', ?)").run(
			JSON.stringify({
				snapshot: initialWatchState(Date.now()),
				generation: 0,
				config: null,
			}),
		);
	}).immediate();
}

export class WatchStore {
	constructor(readonly db: Database.Database) {}
	read(): WatchRecord {
		const row = this.db
			.prepare("SELECT state_json FROM watch_channels WHERE id='main'")
			.get() as { state_json: string };
		return recordSchema.parse(JSON.parse(row.state_json));
	}
	write(record: WatchRecord) {
		recordSchema.parse(record);
		const changed = this.db
			.prepare(
				"UPDATE watch_channels SET state_json=? WHERE id='main' AND json_extract(state_json,'$.snapshot.revision')=?",
			)
			.run(JSON.stringify(record), record.snapshot.revision - 1);
		if (changed.changes !== 1)
			throw new GameError("channel_conflict", "Channel revision changed", 409);
	}
	assign(record: WatchRecord, id: string) {
		this.db
			.prepare("INSERT INTO watch_rounds VALUES ('main',?,?)")
			.run(record.generation, id);
		this.write(record);
	}
	owned(id: string) {
		return !!this.db
			.prepare("SELECT 1 FROM watch_rounds WHERE match_id=?")
			.get(id);
	}
	command(id: string): { hash: string; receipt: WatchReceipt } | null {
		const row = this.db
			.prepare(
				"SELECT request_hash,receipt_json FROM watch_commands WHERE request_id=?",
			)
			.get(id) as { request_hash: string; receipt_json: string } | undefined;
		return row
			? {
					hash: row.request_hash,
					receipt: watchReceiptSchema.parse(JSON.parse(row.receipt_json)),
				}
			: null;
	}
	remember(id: string, hash: string, receipt: WatchReceipt) {
		this.db
			.prepare("INSERT INTO watch_commands VALUES (?,?,?)")
			.run(id, hash, JSON.stringify(receipt));
	}
}
