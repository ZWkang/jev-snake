import type Database from "better-sqlite3";
import type {
	CommunityError,
	CommunityProvider,
	ContributionReceipt,
	CredentialStatus,
} from "../../shared/snake/community.js";
import { GameError } from "../errors.js";
import type { SealedKey } from "./crypto.js";

export type CredentialRecord = {
	id: string;
	provider: CommunityProvider;
	fingerprint: string;
	model: string;
	maskedKey: string;
	secret: SealedKey | null;
	status: CredentialStatus;
	revision: number;
	createdAt: string;
	verifiedAt: string | null;
	lastError: CommunityError | null;
};
type CredentialRow = {
	id: string;
	provider: CommunityProvider;
	fingerprint: string;
	model: string;
	masked_key: string;
	secret_json: string | null;
	status: CredentialStatus;
	revision: number;
	created_at: string;
	verified_at: string | null;
	last_error_json: string | null;
};
export type Attempt = {
	id: string;
	purpose: "validation" | "watch";
	credentialRef: string;
	matchId: string | null;
	startedAt: string;
	finishedAt: string | null;
	status: "started" | "succeeded" | "failed" | "cancelled" | "unconfirmed";
	observedSeq?: number;
	targetTick?: number;
	actionRequestId?: string;
	actionStatus?: string;
	provider: CommunityProvider;
	model: string;
	actualModel?: string;
	requestMs?: number;
	inputTokens?: number;
	error: CommunityError | null;
};
export class CredentialStore {
	constructor(readonly db: Database.Database) {}
	private decode(row: CredentialRow | undefined): CredentialRecord | null {
		return row
			? {
					id: row.id,
					provider: row.provider,
					fingerprint: row.fingerprint,
					model: row.model,
					maskedKey: row.masked_key,
					secret: row.secret_json ? JSON.parse(row.secret_json) : null,
					status: row.status,
					revision: row.revision,
					createdAt: row.created_at,
					verifiedAt: row.verified_at,
					lastError: row.last_error_json
						? JSON.parse(row.last_error_json)
						: null,
				}
			: null;
	}
	get(id: string) {
		return this.decode(
			this.db
				.prepare("SELECT * FROM contributed_credentials WHERE id=?")
				.get(id) as CredentialRow | undefined,
		);
	}
	find(provider: CommunityProvider, fingerprint: string) {
		return this.decode(
			this.db
				.prepare(
					"SELECT * FROM contributed_credentials WHERE provider=? AND fingerprint=?",
				)
				.get(provider, fingerprint) as CredentialRow | undefined,
		);
	}
	all() {
		return (
			this.db
				.prepare("SELECT * FROM contributed_credentials ORDER BY created_at,id")
				.all() as CredentialRow[]
		).map((row) => this.decode(row)!);
	}
	save(c: CredentialRecord) {
		this.db
			.prepare(
				"INSERT INTO contributed_credentials VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET model=excluded.model,masked_key=excluded.masked_key,secret_json=excluded.secret_json,status=excluded.status,revision=excluded.revision,verified_at=excluded.verified_at,last_error_json=excluded.last_error_json",
			)
			.run(
				c.id,
				c.provider,
				c.fingerprint,
				c.model,
				c.maskedKey,
				c.secret ? JSON.stringify(c.secret) : null,
				c.status,
				c.revision,
				c.createdAt,
				c.verifiedAt,
				c.lastError ? JSON.stringify(c.lastError) : null,
			);
	}
	verification(id: string, hash?: string): ContributionReceipt | null {
		const row = this.db
			.prepare(
				"SELECT request_hash,result_json FROM credential_verifications WHERE request_id=?",
			)
			.get(id) as { request_hash: string; result_json: string } | undefined;
		if (!row) return null;
		if (hash !== undefined && row.request_hash !== hash)
			throw new GameError(
				"request_conflict",
				"同一请求标识不能用于不同的贡献内容",
				409,
			);
		return JSON.parse(row.result_json) as ContributionReceipt;
	}
	register(hash: string, c: CredentialRecord, result: ContributionReceipt) {
		this.db
			.prepare(
				"INSERT INTO credential_verifications VALUES (?,?,?,?,?,?,?,?,?,?)",
			)
			.run(
				result.requestId,
				hash,
				c.fingerprint,
				c.id,
				result.provider,
				result.model,
				result.status,
				c.createdAt,
				JSON.stringify(result),
				"watch-keys-v1",
			);
	}
	finishVerifications(
		id: string,
		result: Pick<ContributionReceipt, "status" | "verifiedAt" | "error">,
	) {
		const rows = this.db
			.prepare(
				"SELECT request_id,result_json FROM credential_verifications WHERE credential_id=? AND status='validating'",
			)
			.all(id) as { request_id: string; result_json: string }[];
		for (const row of rows)
			this.db
				.prepare(
					"UPDATE credential_verifications SET status=?,result_json=? WHERE request_id=?",
				)
				.run(
					result.status,
					JSON.stringify({ ...JSON.parse(row.result_json), ...result }),
					row.request_id,
				);
	}
	attempt(a: Attempt) {
		this.db
			.prepare(
				"INSERT INTO credential_attempts VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json",
			)
			.run(
				a.id,
				a.purpose,
				a.credentialRef,
				a.matchId,
				a.startedAt,
				JSON.stringify(a),
			);
	}
	attempts(ref?: string): Attempt[] {
		const rows = (
			ref
				? this.db
						.prepare(
							"SELECT data_json FROM credential_attempts WHERE credential_ref=? ORDER BY started_at,id",
						)
						.all(ref)
				: this.db
						.prepare(
							"SELECT data_json FROM credential_attempts ORDER BY started_at,id",
						)
						.all()
		) as { data_json: string }[];
		return rows.map((row) => JSON.parse(row.data_json) as Attempt);
	}
	recover() {
		this.db
			.transaction(() => {
				const rows = this.db
					.prepare(
						"SELECT DISTINCT credential_id FROM credential_verifications WHERE status='validating'",
					)
					.all() as { credential_id: string }[];
				for (const row of rows)
					this.finishVerifications(row.credential_id, {
						status: "unconfirmed",
						verifiedAt: null,
						error: {
							code: "verification_unconfirmed",
							message: "上次验证结果未确认，可能已产生费用；不会自动重试",
						},
					});
				const pending = this.db
					.prepare(
						"SELECT data_json FROM credential_attempts WHERE json_extract(data_json,'$.status')='started' OR (json_extract(data_json,'$.status')='succeeded' AND json_extract(data_json,'$.actionRequestId') IS NOT NULL AND json_extract(data_json,'$.actionStatus') IS NULL)",
					)
					.all() as { data_json: string }[];
				for (const row of pending) {
					const attempt = JSON.parse(row.data_json) as Attempt;
					{
						let actionStatus = attempt.actionStatus;
						if (attempt.matchId && attempt.actionRequestId) {
							const receipt = this.db
								.prepare(
									"SELECT receipt_json FROM control_requests WHERE match_id=? AND request_id=?",
								)
								.get(attempt.matchId, attempt.actionRequestId) as
								| { receipt_json: string }
								| undefined;
							if (receipt)
								actionStatus = (
									JSON.parse(receipt.receipt_json) as { status: string }
								).status;
						}
						this.attempt({
							...attempt,
							status:
								attempt.status === "started" ? "unconfirmed" : attempt.status,
							...(actionStatus ? { actionStatus } : {}),
							error: {
								code: "request_unconfirmed",
								message:
									attempt.status === "started"
										? "服务重启，上游调用结果未确认；未重放请求"
										: "上游已成功，游戏提交以持久回执为准；未重放请求",
							},
						});
					}
				}
			})
			.immediate();
	}
}
