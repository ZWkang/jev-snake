import { randomUUID } from "node:crypto";
import type {
	CommunityError,
	CommunityProvider,
} from "../../shared/snake/community.js";
import type { Decision, Receipt } from "../../shared/snake/types.js";
import { GameError } from "../errors.js";
import type { jevConfig } from "../jev/config.js";
import { ProviderError, providerPublicError } from "../jev/transport-error.js";
import type { CredentialService } from "./service.js";
import type { Attempt } from "./store.js";

type Candidate = { ref: string; order: string; fingerprint: string };
type Binding = {
	provider: CommunityProvider;
	model: string;
	credential_ref: string;
	reason: string;
};
type PoolState = {
	cursor: string | null;
	environment_fingerprint: string | null;
	environment_status: string;
	environment_error_json: string | null;
};
export type CredentialCall = {
	apiKey: string;
	attempt: Attempt;
	dispatched?: boolean;
};
export type WatchCredentialSource = {
	begin(context: {
		observedSeq: number;
		targetTick: number;
		actionRequestId: string;
	}): CredentialCall;
	started(call: CredentialCall): void;
	succeeded(call: CredentialCall, decision: Decision): void;
	failed(call: CredentialCall, error: unknown, cancelled: boolean): boolean;
	applied(call: CredentialCall, receipt: Receipt): void;
};
export class CredentialPool {
	constructor(
		readonly service: CredentialService,
		readonly jev: ReturnType<typeof jevConfig>,
	) {
		service.requireCrypto();
		const fingerprint = jev.apiKey
			? service.requireCrypto().fingerprint(jev.provider, jev.apiKey)
			: null;
		this.transaction(() => {
			const old = this.state();
			if (!old)
				this.db
					.prepare(
						"INSERT INTO credential_pool_state VALUES (?,NULL,?,'enabled',NULL)",
					)
					.run(jev.provider, fingerprint);
			else if (old.environment_fingerprint !== fingerprint)
				this.db
					.prepare(
						"UPDATE credential_pool_state SET environment_fingerprint=?,environment_status='enabled',environment_error_json=NULL WHERE provider=?",
					)
					.run(fingerprint, jev.provider);
		});
	}
	private get db() {
		return this.service.db;
	}
	private timestamp() {
		return new Date(this.service.now()).toISOString();
	}
	private transaction<T>(work: () => T): T {
		try {
			return this.db.transaction(work).immediate();
		} catch (error) {
			if (error instanceof GameError) throw error;
			throw new GameError(
				"credential_storage_error",
				"凭证池记录保存失败，已停止后续调用",
				503,
			);
		}
	}
	private state() {
		return this.db
			.prepare("SELECT * FROM credential_pool_state WHERE provider=?")
			.get(this.jev.provider) as PoolState | undefined;
	}
	private candidates(): Candidate[] {
		const state = this.state()!,
			env = state.environment_fingerprint;
		return [
			...(this.jev.apiKey && env && state.environment_status === "enabled"
				? [{ ref: `environment:${env}`, order: "0", fingerprint: env }]
				: []),
			...(
				this.db
					.prepare(
						"SELECT id,created_at,fingerprint FROM contributed_credentials WHERE provider=? AND model=? AND status='enabled' ORDER BY created_at,id",
					)
					.all(this.jev.provider, this.jev.model) as {
					id: string;
					created_at: string;
					fingerprint: string;
				}[]
			)
				.filter((c) => c.fingerprint !== env)
				.map((c) => ({
					ref: c.id,
					order: `1:${c.created_at}:${c.id}`,
					fingerprint: c.fingerprint,
				})),
		];
	}
	available() {
		return this.candidates().length > 0;
	}
	assertAvailable() {
		if (!this.available())
			throw new GameError(
				"credential_pool_exhausted",
				"当前服务商没有可用凭证，请补充 Key 后由管理员恢复连续观战",
				503,
			);
	}
	private pick(after: string | null): Candidate {
		const candidates = this.candidates();
		if (!candidates.length) {
			this.assertAvailable();
			throw new Error("Unreachable empty credential pool");
		}
		return (
			candidates.find((c) => after !== null && c.order > after) ?? candidates[0]
		);
	}
	private readKey(candidate: Candidate) {
		if (candidate.ref.startsWith("environment:")) return this.jev.apiKey;
		const c = this.service.store.get(candidate.ref)!;
		if (!c.secret)
			throw new GameError("credentials_decryption", "可用凭证缺少密文", 503);
		return this.service.requireCrypto().open(c.id, c.provider, c.secret);
	}
	bindNew(matchId: string) {
		this.transaction(() => {
			const selected = this.pick(this.state()!.cursor);
			this.readKey(selected);
			this.db
				.prepare("INSERT INTO watch_round_credentials VALUES (?,?,?,?,?)")
				.run(
					matchId,
					this.jev.provider,
					this.jev.model,
					selected.ref,
					"normal_round",
				);
			this.db
				.prepare("UPDATE credential_pool_state SET cursor=? WHERE provider=?")
				.run(selected.order, this.jev.provider);
		});
	}
	private binding(matchId: string) {
		return this.db
			.prepare("SELECT * FROM watch_round_credentials WHERE match_id=?")
			.get(matchId) as Binding | undefined;
	}
	ensureRound(matchId: string): Candidate {
		return this.transaction(() => {
			const saved = this.binding(matchId);
			if (
				saved &&
				(saved.provider !== this.jev.provider || saved.model !== this.jev.model)
			)
				throw new GameError(
					"credential_configuration_changed",
					"未完成对局的服务商或模型配置已改变，请恢复原配置",
					503,
				);
			const current = this.candidates().find(
				(c) => c.ref === saved?.credential_ref,
			);
			if (current) {
				this.readKey(current);
				return current;
			}
			let after: string | null = null;
			if (saved) {
				const previous = this.service.store.get(saved.credential_ref);
				after = saved.credential_ref.startsWith("environment:")
					? "0"
					: previous
						? `1:${previous.createdAt}:${previous.id}`
						: null;
			}
			const next = this.pick(after);
			this.readKey(next);
			this.db
				.prepare(
					"INSERT INTO watch_round_credentials VALUES (?,?,?,?,?) ON CONFLICT(match_id) DO UPDATE SET credential_ref=excluded.credential_ref,reason=excluded.reason",
				)
				.run(
					matchId,
					this.jev.provider,
					this.jev.model,
					next.ref,
					saved ? "credential_unavailable" : "legacy_round",
				);
			return next;
		});
	}
	forMatch(matchId: string): WatchCredentialSource {
		return {
			begin: (context) => {
				const selected = this.ensureRound(matchId),
					apiKey = this.readKey(selected);
				const attempt: Attempt = {
					id: randomUUID(),
					purpose: "watch",
					credentialRef: selected.ref,
					matchId,
					provider: this.jev.provider,
					model: this.jev.model,
					...context,
					startedAt: this.timestamp(),
					finishedAt: null,
					status: "started",
					error: null,
				};
				return { apiKey, attempt };
			},
			started: (call) => {
				this.transaction(() => this.service.store.attempt(call.attempt));
				call.dispatched = true;
			},
			succeeded: (call, decision) => {
				const next: Attempt = {
					...call.attempt,
					status: "succeeded",
					finishedAt: this.timestamp(),
					actualModel: decision.model,
					requestMs: decision.requestMs,
					...(decision.inputTokens === undefined
						? {}
						: { inputTokens: decision.inputTokens }),
				};
				this.transaction(() => this.service.store.attempt(next));
				call.attempt = next;
				call.apiKey = "";
			},
			failed: (call, error, cancelled) => {
				if (!call.dispatched) {
					call.apiKey = "";
					return false;
				}
				const safe: CommunityError = cancelled
					? { code: "request_cancelled", message: "模型请求已取消" }
					: providerPublicError(error);
				const rotate =
					!cancelled && error instanceof ProviderError && error.rotate;
				this.transaction(() => {
					this.service.store.attempt({
						...call.attempt,
						status: cancelled ? "cancelled" : "failed",
						finishedAt: this.timestamp(),
						error: safe,
					});
					if (rotate) {
						if (call.attempt.credentialRef.startsWith("environment:"))
							this.db
								.prepare(
									"UPDATE credential_pool_state SET environment_status='unusable',environment_error_json=? WHERE provider=?",
								)
								.run(JSON.stringify(safe), this.jev.provider);
						else {
							const c = this.service.store.get(call.attempt.credentialRef)!;
							if (c.status === "enabled")
								this.service.store.save({
									...c,
									status: "unusable",
									revision: c.revision + 1,
									lastError: safe,
								});
						}
					}
				});
				call.apiKey = "";
				return rotate;
			},
			applied: (call, receipt) => {
				const next = { ...call.attempt, actionStatus: receipt.status };
				this.transaction(() => this.service.store.attempt(next));
				call.attempt = next;
			},
		};
	}
}
