import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
	MatchEvent,
	MatchState,
	Receipt,
} from "../../shared/snake/types.js";
import { summary, supportedRecord } from "../../shared/snake/types.js";
import { migrateCommunity } from "../community/migration.js";
import { GameError } from "../errors.js";
import { migrateWatch } from "../watch/store.js";

type Row = { state_json: string };
export type SavedRequest = { hash: string; receipt: Receipt };
export type RequestWrite = { id: string; hash?: string; receipt: Receipt };
export class Store {
	readonly db: Database.Database;
	beforeMatchCommit?: (state: MatchState, events: MatchEvent[]) => void;
	constructor(readonly path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path);
		try {
			this.db.pragma("foreign_keys = ON");
			this.db.pragma("journal_mode = WAL");
			this.db.pragma("synchronous = FULL");
			const version = this.db.pragma("user_version", { simple: true });
			if (version !== 0 && version !== 1 && version !== 2 && version !== 3)
				throw new Error(
					`Unsupported database schema version: ${String(version)}`,
				);
			if (version === 0)
				this.db.transaction(() => {
					this.db.exec(
						[
							"CREATE TABLE matches (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, agent_name TEXT NOT NULL, state_json TEXT NOT NULL, control_hash TEXT NOT NULL, create_request_id TEXT NOT NULL UNIQUE, create_hash TEXT NOT NULL)",
							"CREATE TABLE match_events (match_id TEXT NOT NULL REFERENCES matches(id), seq INTEGER NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY (match_id,seq))",
							"CREATE TABLE control_requests (match_id TEXT NOT NULL REFERENCES matches(id), request_id TEXT NOT NULL, request_hash TEXT NOT NULL, receipt_json TEXT NOT NULL, PRIMARY KEY (match_id,request_id))",
							"CREATE INDEX match_history ON matches(created_at DESC,id DESC)",
							"CREATE INDEX match_status ON matches(status)",
							"PRAGMA user_version = 1",
						].join(";"),
					);
				})();
			if (version === 0 || version === 1) migrateWatch(this.db);
			if (version === 0 || version === 1 || version === 2)
				migrateCommunity(this.db);
		} catch (error) {
			this.db.close();
			throw error;
		}
	}
	private decode(row: Row): MatchState {
		const s = JSON.parse(row.state_json) as MatchState;
		if (!supportedRecord(s))
			throw new GameError(
				"unsupported_record",
				"Unsupported record or rules version",
				409,
			);
		return s;
	}
	get(id: string): MatchState {
		const row = this.db
			.prepare("SELECT state_json FROM matches WHERE id=?")
			.get(id) as Row | undefined;
		if (!row) throw new GameError("not_found", "Match not found", 404);
		return this.decode(row);
	}
	controlHash(id: string): string {
		const row = this.db
			.prepare("SELECT control_hash FROM matches WHERE id=?")
			.get(id) as { control_hash: string } | undefined;
		if (!row) throw new GameError("not_found", "Match not found", 404);
		return row.control_hash;
	}
	byCreation(requestId: string) {
		const row = this.db
			.prepare("SELECT id,create_hash FROM matches WHERE create_request_id=?")
			.get(requestId) as { id: string; create_hash: string } | undefined;
		return row;
	}
	create(
		s: MatchState,
		controlHash: string,
		requestId: string,
		createHash: string,
		event: MatchEvent,
		createdInTransaction?: (id: string) => void,
	) {
		this.createFork(
			s,
			controlHash,
			requestId,
			createHash,
			[event],
			createdInTransaction,
		);
	}
	createFork(
		s: MatchState,
		controlHash: string,
		requestId: string,
		createHash: string,
		events: MatchEvent[],
		createdInTransaction?: (id: string) => void,
	) {
		this.db
			.transaction(() => {
				this.db
					.prepare("INSERT INTO matches VALUES (?,?,?,?,?,?,?,?)")
					.run(
						s.id,
						s.createdAt,
						s.status,
						s.agentName,
						JSON.stringify(s),
						controlHash,
						requestId,
						createHash,
					);
				const insert = this.db.prepare(
					"INSERT INTO match_events VALUES (?,?,?)",
				);
				for (const event of events)
					insert.run(s.id, event.seq, JSON.stringify(event));
				createdInTransaction?.(s.id);
			})
			.immediate();
	}
	request(id: string, requestId: string): SavedRequest | null {
		const row = this.db
			.prepare(
				"SELECT request_hash,receipt_json FROM control_requests WHERE match_id=? AND request_id=?",
			)
			.get(id, requestId) as
			| { request_hash: string; receipt_json: string }
			| undefined;
		return row
			? {
					hash: row.request_hash,
					receipt: JSON.parse(row.receipt_json) as Receipt,
				}
			: null;
	}
	commit(s: MatchState, events: MatchEvent[], requests: RequestWrite[] = []) {
		this.db
			.transaction(() => {
				this.beforeMatchCommit?.(s, events);
				this.db
					.prepare("UPDATE matches SET status=?,state_json=? WHERE id=?")
					.run(s.status, JSON.stringify(s), s.id);
				const insert = this.db.prepare(
					"INSERT INTO match_events VALUES (?,?,?)",
				);
				for (const event of events)
					insert.run(s.id, event.seq, JSON.stringify(event));
				for (const request of requests) {
					if (request.hash !== undefined) {
						this.db
							.prepare("INSERT INTO control_requests VALUES (?,?,?,?)")
							.run(
								s.id,
								request.id,
								request.hash,
								JSON.stringify(request.receipt),
							);
					} else {
						const result = this.db
							.prepare(
								"UPDATE control_requests SET receipt_json=? WHERE match_id=? AND request_id=?",
							)
							.run(JSON.stringify(request.receipt), s.id, request.id);
						if (result.changes !== 1)
							throw new Error(`Missing persisted request: ${request.id}`);
					}
				}
			})
			.immediate();
	}
	resume(
		s: MatchState,
		events: MatchEvent[],
		controlHash: string,
		resumedInTransaction: () => void,
	) {
		this.db
			.transaction(() => {
				this.db
					.prepare("UPDATE matches SET control_hash=? WHERE id=?")
					.run(controlHash, s.id);
				this.commit(s, events);
				resumedInTransaction();
			})
			.immediate();
	}
	events(id: string, afterSeq: number, limit = 200) {
		const state = this.get(id);
		const rows = this.db
			.prepare(
				"SELECT event_json FROM match_events WHERE match_id=? AND seq>? ORDER BY seq LIMIT ?",
			)
			.all(id, afterSeq, limit) as { event_json: string }[];
		const events = rows.map((r) => JSON.parse(r.event_json) as MatchEvent);
		let expected = afterSeq + 1;
		for (const e of events) {
			if (
				e.seq !== expected++ ||
				e.matchId !== id ||
				e.state.id !== id ||
				e.state.seq !== e.seq ||
				!supportedRecord(e.state)
			)
				throw new GameError(
					"corrupt_record",
					"Event sequence is incomplete or incompatible",
					409,
				);
		}
		const nextSeq = events.at(-1)?.seq ?? afterSeq;
		if (nextSeq < state.seq && events.length < limit)
			throw new GameError(
				"corrupt_record",
				"Event sequence is incomplete",
				409,
			);
		return {
			events,
			nextSeq,
			hasMore: nextSeq < state.seq,
			latestSeq: state.seq,
		};
	}
	list(
		options: {
			status?: string;
			agent?: string;
			cursor?: string;
			limit?: number;
		} = {},
	) {
		const where: string[] = [];
		const args: (string | number)[] = [];
		if (options.status) {
			where.push("status=?");
			args.push(options.status);
		}
		if (options.agent) {
			where.push("agent_name=?");
			args.push(options.agent);
		}
		if (options.cursor) {
			let value: unknown;
			try {
				value = JSON.parse(Buffer.from(options.cursor, "base64url").toString());
			} catch {
				throw new GameError("invalid_cursor", "Invalid history cursor");
			}
			if (
				!Array.isArray(value) ||
				value.length !== 2 ||
				!value.every((v) => typeof v === "string")
			)
				throw new GameError("invalid_cursor", "Invalid history cursor");
			where.push("(created_at < ? OR (created_at = ? AND id < ?))");
			args.push(value[0], value[0], value[1]);
		}
		const limit = options.limit ?? 20;
		const rows = this.db
			.prepare(
				"SELECT state_json FROM matches" +
					(where.length ? ` WHERE ${where.join(" AND ")}` : "") +
					" ORDER BY created_at DESC,id DESC LIMIT ?",
			)
			.all(...args, limit + 1) as Row[];
		const states = rows.slice(0, limit).map((r) => this.decode(r));
		const last = states.at(-1);
		return {
			matches: states.map(summary),
			nextCursor:
				rows.length > limit && last
					? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString(
							"base64url",
						)
					: null,
		};
	}
	active(): MatchState[] {
		return (
			this.db
				.prepare("SELECT state_json FROM matches WHERE status='running'")
				.all() as Row[]
		).map((r) => this.decode(r));
	}
	agents(): string[] {
		return (
			this.db
				.prepare("SELECT DISTINCT agent_name FROM matches ORDER BY agent_name")
				.all() as { agent_name: string }[]
		).map((r) => r.agent_name);
	}
	close() {
		this.db.close();
	}
}
