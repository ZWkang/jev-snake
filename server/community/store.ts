import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
	AdminFeedback,
	FeedbackPage,
} from "../../shared/snake/community.js";
import { GameError } from "../errors.js";

type FeedbackRow = {
	id: string;
	body: string;
	created_at: string;
	visible: number;
};
export class CommunityStore {
	constructor(
		readonly db: Database.Database,
		private now: () => number = Date.now,
	) {}
	receipt<T>(namespace: string, id: string, hash: string): T | undefined {
		const row = this.db
			.prepare(
				"SELECT request_hash,receipt_json FROM community_requests WHERE namespace=? AND request_id=?",
			)
			.get(namespace, id) as
			| { request_hash: string; receipt_json: string }
			| undefined;
		if (!row) return;
		if (row.request_hash !== hash)
			throw new GameError(
				"request_conflict",
				"同一请求标识不能用于不同内容",
				409,
			);
		return JSON.parse(row.receipt_json) as T;
	}
	remember(namespace: string, id: string, hash: string, receipt: unknown) {
		this.db
			.prepare("INSERT INTO community_requests VALUES (?,?,?,?)")
			.run(namespace, id, hash, JSON.stringify(receipt));
	}
	create(requestId: string, body: string): { id: string; createdAt: string } {
		const hash = createHash("sha256").update(body).digest("hex");
		return this.db
			.transaction(() => {
				const existing = this.receipt<{ id: string; createdAt: string }>(
					"feedback",
					requestId,
					hash,
				);
				if (existing) return existing;
				const result = {
					id: randomUUID(),
					createdAt: new Date(this.now()).toISOString(),
				};
				this.db
					.prepare("INSERT INTO community_feedback VALUES (?,?,?,1,?)")
					.run(result.id, body, result.createdAt, result.createdAt);
				this.remember("feedback", requestId, hash, result);
				return result;
			})
			.immediate();
	}
	list(
		cursor?: string,
		admin = false,
	): FeedbackPage | { items: AdminFeedback[]; nextCursor: string | null } {
		let after: { time: string; id: string } | null = null;
		if (cursor) {
			try {
				const data: unknown = JSON.parse(
					Buffer.from(cursor, "base64url").toString(),
				);
				if (
					typeof data !== "object" ||
					data === null ||
					!("time" in data) ||
					typeof data.time !== "string" ||
					!("id" in data) ||
					typeof data.id !== "string"
				)
					throw new Error();
				after = { time: data.time, id: data.id };
			} catch {
				throw new GameError("invalid_cursor", "反馈分页标识不正确");
			}
		}
		const rows = this.db
			.prepare(
				`SELECT id,body,created_at,visible FROM community_feedback WHERE ${admin ? "1=1" : "visible=1"} ${after ? "AND (created_at < @time OR (created_at = @time AND id < @id))" : ""} ORDER BY created_at DESC,id DESC LIMIT 21`,
			)
			.all(after ?? {}) as FeedbackRow[];
		const selected = rows.slice(0, 20),
			last = selected.at(-1);
		return {
			items: selected.map((row) => ({
				id: row.id,
				body: row.body,
				createdAt: row.created_at,
				...(admin ? { visible: !!row.visible } : {}),
			})),
			nextCursor:
				rows.length > 20 && last
					? Buffer.from(
							JSON.stringify({ time: last.created_at, id: last.id }),
						).toString("base64url")
					: null,
		};
	}
	visibility(
		id: string,
		requestId: string,
		visible: boolean,
	): { id: string; visible: boolean } {
		const hash = JSON.stringify([id, visible]);
		return this.db
			.transaction(() => {
				const existing = this.receipt<{ id: string; visible: boolean }>(
					"visibility",
					requestId,
					hash,
				);
				if (existing) return existing;
				const changed = this.db
					.prepare(
						"UPDATE community_feedback SET visible=?,updated_at=? WHERE id=?",
					)
					.run(Number(visible), new Date(this.now()).toISOString(), id);
				if (changed.changes !== 1)
					throw new GameError("not_found", "反馈不存在", 404);
				const result = { id, visible };
				this.remember("visibility", requestId, hash, result);
				return result;
			})
			.immediate();
	}
}
