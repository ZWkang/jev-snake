import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
	AdminCredential,
	CommunityConfig,
	ContributionInput,
	ContributionReceipt,
	CommunityProvider,
} from "../../shared/snake/community.js";
import type { CommunitySettings } from "../community/config.js";
import { CommunityStore } from "../community/store.js";
import { GameError } from "../errors.js";
import { sendJevRequest } from "../jev/client.js";
import { ProviderError, providerPublicError } from "../jev/transport-error.js";
import { CredentialCrypto, maskKey } from "./crypto.js";
import {
	CredentialStore,
	type CredentialRecord,
	type Attempt,
} from "./store.js";
import { validationRequest } from "./validation-request.js";

export class CredentialService {
	readonly store: CredentialStore;
	readonly crypto: CredentialCrypto | null;
	private requests: CommunityStore;
	private active = new Map<
		string,
		{ controller: AbortController; task: Promise<void> }
	>();
	private closing = false;
	constructor(
		readonly db: Database.Database,
		readonly settings: CommunitySettings,
		readonly config: CommunityConfig,
		private transport: typeof fetch = fetch,
		readonly now: () => number = Date.now,
	) {
		if (
			(settings.contributionsEnabled || settings.poolEnabled) &&
			!settings.masterKey
		)
			throw new GameError(
				"credentials_configuration",
				"启用贡献或凭证池需要 CREDENTIALS_MASTER_KEY",
				503,
			);
		this.crypto = settings.masterKey
			? new CredentialCrypto(settings.masterKey)
			: null;
		this.store = new CredentialStore(db);
		this.requests = new CommunityStore(db, now);
		this.store.recover();
	}
	requireCrypto() {
		if (!this.crypto)
			throw new GameError(
				"credentials_configuration",
				"贡献凭证的加密配置不可用",
				503,
			);
		return this.crypto;
	}
	private timestamp() {
		return new Date(this.now()).toISOString();
	}
	private accepting() {
		if (this.closing)
			throw new GameError("service_closing", "服务正在关闭，未发起验证", 503);
	}
	status(requestId: string) {
		const result = this.store.verification(requestId);
		if (!result) throw new GameError("not_found", "没有找到该验证请求", 404);
		return result;
	}
	async contribute(input: ContributionInput): Promise<ContributionReceipt> {
		this.accepting();
		if (!this.settings.contributionsEnabled)
			throw new GameError("contributions_disabled", "Key 贡献暂未开放", 503);
		return this.verify(input.requestId, input.provider, input.apiKey, false);
	}
	private async verify(
		requestId: string,
		provider: CommunityProvider,
		apiKey: string,
		admin: boolean,
		adminCommandHash?: string,
	): Promise<ContributionReceipt> {
		this.accepting();
		const crypto = this.requireCrypto(),
			model = this.config.models[provider],
			fingerprint = crypto.fingerprint(provider, apiKey),
			hash = crypto.hash([provider, apiKey, model, admin]);
		const old = this.store.verification(requestId, hash);
		if (old) return old;
		let member!: CredentialRecord;
		const initial = this.db
			.transaction(() => {
				const existing = this.store.find(provider, fingerprint),
					active = this.active.has(fingerprint);
				member = existing ?? {
					id: randomUUID(),
					provider,
					fingerprint,
					model,
					maskedKey: maskKey(apiKey),
					secret: null,
					status: "unconfirmed",
					revision: 0,
					createdAt: this.timestamp(),
					verifiedAt: null,
					lastError: null,
				};
				let result: ContributionReceipt = {
					requestId,
					provider,
					model,
					status: "validating",
					created: !existing || existing.status === "revoked",
					verifiedAt: null,
					error: null,
				};
				if (existing?.status === "disabled" && !admin)
					result = {
						...result,
						status: "disabled",
						error: {
							code: "credential_disabled",
							message: "此 Key 已被管理员停用，重复贡献不会重新启用",
						},
					};
				else if (
					existing?.status === "enabled" &&
					existing.model === model &&
					!admin
				)
					result = {
						...result,
						status: "enabled",
						created: false,
						verifiedAt: existing.verifiedAt,
					};
				else if (!active) {
					member = {
						...member,
						model,
						status: admin ? "disabled" : "unconfirmed",
						revision: member.revision + 1,
						lastError: null,
					};
					this.store.save(member);
				} else result.created = false;
				this.store.register(hash, member, result);
				if (adminCommandHash)
					this.requests.remember(
						"credential-command",
						requestId,
						adminCommandHash,
						{ verificationId: requestId },
					);
				return result;
			})
			.immediate();
		if (initial.status !== "validating") return initial;
		const running = this.active.get(fingerprint);
		if (running) {
			await running.task;
			return this.status(requestId);
		}
		const controller = new AbortController();
		// Defer work until the registry exists so same-key submissions share one call.
		const task = Promise.resolve().then(() =>
			this.perform(member, apiKey, controller),
		);
		this.active.set(fingerprint, { controller, task });
		try {
			await task;
			return this.status(requestId);
		} catch (error) {
			try {
				this.db
					.transaction(() =>
						this.store.finishVerifications(member.id, {
							status: "unconfirmed",
							verifiedAt: null,
							error: {
								code: "verification_persistence",
								message:
									"验证结果未能持久确认，可能已计费；请检查服务状态后显式重试",
							},
						}),
					)
					.immediate();
			} catch (saveError) {
				throw new AggregateError(
					[error, saveError],
					"Verification persistence failed",
				);
			}
			throw error;
		} finally {
			this.active.delete(fingerprint);
		}
	}
	private async perform(
		member: CredentialRecord,
		apiKey: string,
		controller: AbortController,
	) {
		const current = this.store.get(member.id)!;
		if (current.revision !== member.revision) return;
		let dispatched = false;
		const attempt: Attempt = {
			id: randomUUID(),
			purpose: "validation",
			credentialRef: member.id,
			matchId: null,
			provider: member.provider,
			model: member.model,
			startedAt: this.timestamp(),
			finishedAt: null,
			status: "started",
			error: null,
		};
		let result: Awaited<ReturnType<typeof sendJevRequest>> | undefined;
		let failure: ContributionReceipt["error"] = null,
			unconfirmed = false;
		try {
			const candidate = await sendJevRequest(
				apiKey,
				validationRequest(member.model),
				{
					provider: member.provider,
					signal: controller.signal,
					fetch: this.transport,
					onRequestStarted: () => {
						this.store.attempt(attempt);
						dispatched = true;
					},
				},
			);
			controller.signal.throwIfAborted();
			result = candidate;
		} catch (error) {
			unconfirmed =
				controller.signal.aborted && error === controller.signal.reason;
			failure = unconfirmed
				? {
						code: "verification_unconfirmed",
						message: "验证已中断，结果未确认，可能已产生费用",
					}
				: providerPublicError(error);
			if (!(error instanceof ProviderError) && !unconfirmed) throw error;
		}
		this.db
			.transaction(() => {
				if (dispatched)
					this.store.attempt({
						...attempt,
						finishedAt: this.timestamp(),
						status: unconfirmed
							? "unconfirmed"
							: result
								? "succeeded"
								: "failed",
						error: failure,
						...(result
							? {
									actualModel: result.decision.model,
									requestMs: result.decision.requestMs,
									...(result.decision.inputTokens === undefined
										? {}
										: { inputTokens: result.decision.inputTokens }),
								}
							: {}),
					});
				const current = this.store.get(member.id)!;
				if (current.revision !== member.revision) {
					this.store.finishVerifications(member.id, {
						status: current.status === "revoked" ? "revoked" : "disabled",
						verifiedAt: null,
						error: {
							code: "credential_changed",
							message: "验证期间贡献已撤回或停用，未启用",
						},
					});
					return;
				}
				if (result) {
					const verifiedAt = this.timestamp();
					this.store.save({
						...current,
						secret: this.requireCrypto().seal(
							current.id,
							current.provider,
							apiKey,
						),
						status: "enabled",
						verifiedAt,
						lastError: null,
					});
					this.db
						.prepare(
							"UPDATE credential_pool_state SET environment_status='enabled',environment_error_json=NULL WHERE provider=? AND environment_fingerprint=?",
						)
						.run(current.provider, current.fingerprint);
					this.store.finishVerifications(member.id, {
						status: "enabled",
						verifiedAt,
						error: null,
					});
				} else {
					this.store.save({
						...current,
						status: current.secret ? "disabled" : "unconfirmed",
						lastError: failure,
					});
					this.store.finishVerifications(member.id, {
						status: unconfirmed ? "unconfirmed" : "failed",
						verifiedAt: null,
						error: failure,
					});
				}
			})
			.immediate();
	}
	revoke(requestId: string, provider: CommunityProvider, apiKey: string) {
		const crypto = this.requireCrypto(),
			fingerprint = crypto.fingerprint(provider, apiKey),
			hash = crypto.hash([provider, apiKey]);
		return this.db
			.transaction(() => {
				const prior = this.requests.receipt<{ revoked: true }>(
					"revoke",
					requestId,
					hash,
				);
				if (prior) return prior;
				const c = this.store.find(provider, fingerprint);
				if (!c)
					throw new GameError("not_found", "没有找到这把 Key 的贡献记录", 404);
				this.store.save({
					...c,
					status: "revoked",
					secret: null,
					revision: c.revision + 1,
					lastError: null,
				});
				this.store.finishVerifications(c.id, {
					status: "revoked",
					verifiedAt: null,
					error: { code: "credential_revoked", message: "贡献已撤回" },
				});
				const result = { revoked: true as const };
				this.requests.remember("revoke", requestId, hash, result);
				return result;
			})
			.immediate();
	}
	async command(
		id: string,
		requestId: string,
		action: "disable" | "revalidate-and-enable",
	) {
		this.accepting();
		const c = this.store.get(id);
		if (!c) throw new GameError("not_found", "凭证不存在", 404);
		const hash = JSON.stringify([id, action]);
		const previous = this.requests.receipt<
			{ disabled: true } | { verificationId: string }
		>("credential-command", requestId, hash);
		if (previous)
			return "verificationId" in previous
				? this.status(previous.verificationId)
				: previous;
		if (action === "disable")
			return this.db
				.transaction(() => {
					this.store.save({
						...c,
						status: c.status === "revoked" ? "revoked" : "disabled",
						revision: c.revision + 1,
					});
					this.store.finishVerifications(c.id, {
						status: c.status === "revoked" ? "revoked" : "disabled",
						verifiedAt: null,
						error: { code: "credential_disabled", message: "凭证已停用" },
					});
					const result = { disabled: true as const };
					this.requests.remember("credential-command", requestId, hash, result);
					return result;
				})
				.immediate();
		if (!c.secret || c.status === "revoked")
			throw new GameError(
				"credential_revoked",
				"该 Key 没有活动密文，需由持有人重新贡献",
				409,
			);
		const key = this.requireCrypto().open(c.id, c.provider, c.secret);
		return this.verify(requestId, c.provider, key, true, hash);
	}
	list(): AdminCredential[] {
		return this.store.all().map((c) => {
			const usage = this.db
				.prepare(
					"SELECT count(CASE WHEN purpose='watch' THEN 1 END) AS watchCalls,count(CASE WHEN purpose='validation' THEN 1 END) AS validationCalls,max(CASE WHEN purpose='watch' THEN started_at END) AS lastUsedAt,sum(CASE WHEN purpose='watch' THEN json_extract(data_json,'$.inputTokens') END) AS inputTokens FROM credential_attempts WHERE credential_ref=?",
				)
				.get(c.id) as {
				watchCalls: number;
				validationCalls: number;
				lastUsedAt: string | null;
				inputTokens: number | null;
			};
			const latest = this.db
				.prepare(
					"SELECT data_json FROM credential_attempts WHERE credential_ref=? ORDER BY started_at DESC,id DESC LIMIT 1",
				)
				.get(c.id) as { data_json: string } | undefined;
			const switchRow = this.db
				.prepare(
					"SELECT reason FROM watch_round_credentials WHERE credential_ref=? ORDER BY rowid DESC LIMIT 1",
				)
				.get(c.id) as { reason: string } | undefined;
			return {
				id: c.id,
				provider: c.provider,
				model: c.model,
				maskedKey: c.maskedKey,
				status: c.status,
				createdAt: c.createdAt,
				verifiedAt: c.verifiedAt,
				...usage,
				currentPool:
					this.settings.poolEnabled &&
					c.status === "enabled" &&
					c.provider === this.config.currentProvider &&
					c.model === this.config.models[c.provider],
				lastError:
					c.lastError ??
					(latest ? (JSON.parse(latest.data_json) as Attempt).error : null),
				lastSwitchReason: switchRow?.reason ?? null,
			};
		});
	}
	async close() {
		this.closing = true;
		const pending = [...this.active.values()];
		for (const item of pending)
			item.controller.abort(new DOMException("service_shutdown", "AbortError"));
		const results = await Promise.allSettled(pending.map((p) => p.task));
		const failed = results
			.filter((r) => r.status === "rejected")
			.map((r) => r.reason);
		if (failed.length)
			throw new AggregateError(
				failed,
				"Credential verification shutdown failed",
			);
	}
}
