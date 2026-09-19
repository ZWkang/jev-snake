import { randomBytes, randomUUID } from "node:crypto";
import type { GameConfig, PublicState } from "../../shared/snake/types.js";
import {
	watchCommandSchema,
	type WatchCommandResult,
	type WatchReceipt,
	type WatchSnapshot,
} from "../../shared/snake/watch.js";
import { GameError } from "../errors.js";
import type { jevConfig } from "../jev/config.js";
import { runJevMatch, type RunJevOptions } from "../jev/runner.js";
import { digest, type MatchService } from "../matches/service.js";
import { WatchStore } from "./store.js";

export type WatchSettings = {
	jev: ReturnType<typeof jevConfig>;
	makeConfig: () => GameConfig;
	intermissionMs: number;
	now?: () => number;
	run?: (options: RunJevOptions) => Promise<PublicState>;
	log?: (message: string) => void;
};

export class WatchChannel {
	readonly store: WatchStore;
	private root: string | null = null;
	private closing = false;
	private recovering = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private task: Promise<void> | null = null;
	private controller: AbortController | null = null;
	private controlToken = "";
	private closeFailure: unknown;
	private listeners = new Set<() => void>();
	private unsubscribe: () => void;
	private publishedRevision = -1;
	private readonly now: () => number;
	constructor(
		readonly service: MatchService,
		readonly settings: WatchSettings,
	) {
		if (
			!Number.isSafeInteger(settings.intermissionMs) ||
			settings.intermissionMs < 0
		)
			throw new Error("WATCH_INTERMISSION_MS must be a nonnegative integer");
		this.now = settings.now ?? Date.now;
		this.store = new WatchStore(service.store.db);
		service.beforeStart = (id) => {
			if (!this.store.owned(id)) return;
			const { snapshot } = this.store.read();
			if (
				this.closing ||
				!snapshot.enabled ||
				snapshot.currentMatchId !== id ||
				snapshot.phase !== "starting"
			)
				throw new GameError(
					"channel_stopped",
					"This channel round is no longer allowed to start",
					409,
				);
		};
		service.store.beforeMatchCommit = (state, events) => {
			if (
				!events.some((e) => e.type === "started") ||
				!this.store.owned(state.id)
			)
				return;
			const record = this.store.read();
			record.snapshot = {
				...record.snapshot,
				phase: "running",
				revision: record.snapshot.revision + 1,
				serverTime: this.now(),
			};
			this.store.write(record);
		};
		this.unsubscribe = service.subscribe(() => {
			if (this.closing || this.recovering) return;
			if (service.fault) {
				clearTimeout(this.timer);
				this.publish();
				return;
			}
			const revision = this.store.read().snapshot.revision;
			if (revision !== this.publishedRevision) this.publish();
		});
	}
	activate(root: string) {
		this.root = root;
		this.recovering = true;
		try {
			const record = this.store.read(),
				s = record.snapshot;
			if (s.currentMatchId) {
				const current = this.service.store.get(s.currentMatchId);
				if (current.status === "ready" || current.status === "running")
					this.stopMatch(current, "server_restart");
			}
			if (s.currentMatchId || (s.enabled && s.phase !== "fault")) {
				record.generation++;
				record.snapshot = {
					...s,
					revision: s.revision + 1,
					currentMatchId: null,
					lastMatchId: s.currentMatchId ?? s.lastMatchId,
					phase:
						s.phase === "fault" ? "fault" : s.enabled ? "countdown" : "stopped",
					nextStartAt:
						s.enabled && s.phase !== "fault"
							? this.now() + this.settings.intermissionMs
							: null,
					serverTime: this.now(),
				};
				this.persist(() => this.store.write(record));
			}
		} finally {
			this.recovering = false;
		}
		this.publish();
		this.schedule();
	}
	snapshot(): WatchSnapshot {
		if (this.service.fault)
			throw new GameError("service_failed", this.service.fault, 503);
		return { ...this.store.read().snapshot, serverTime: this.now() };
	}
	subscribe(listener: () => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private publish() {
		if (!this.service.fault)
			this.publishedRevision = this.store.read().snapshot.revision;
		for (const listener of this.listeners) listener();
	}
	private persist<T>(work: () => T): T {
		try {
			return this.service.store.db.transaction(work).immediate();
		} catch (error) {
			if (!(error instanceof GameError)) this.service.fail(error);
			throw error;
		}
	}
	private validatedConfig() {
		if (!this.settings.jev.apiKey)
			throw new Error(
				`Set ${this.settings.jev.keyEnv} before starting continuous watch`,
			);
		return this.settings.makeConfig();
	}
	command(input: unknown): WatchCommandResult {
		if (this.closing || !this.root)
			throw new GameError(
				"channel_unavailable",
				"Channel service is not accepting commands",
				503,
			);
		this.snapshot();
		const parsed = watchCommandSchema.safeParse(input);
		if (!parsed.success)
			throw new GameError("invalid_request", parsed.error.message);
		const c = parsed.data,
			hash = digest(JSON.stringify(c)),
			previous = this.store.command(c.requestId);
		if (previous) {
			if (previous.hash !== hash)
				throw new GameError(
					"request_id_conflict",
					"Channel request ID already used with different content",
					409,
				);
			return { receipt: previous.receipt, state: this.snapshot() };
		}
		const record = this.store.read(),
			s = record.snapshot;
		if (c.enabled && (s.phase === "stopped" || s.phase === "fault")) {
			try {
				record.config = this.validatedConfig();
			} catch (error) {
				this.fail(error);
				throw new GameError("channel_configuration", this.message(error));
			}
		}
		let cancel: string | null = null;
		if (c.enabled) {
			if (s.phase === "stopped" || s.phase === "fault")
				record.snapshot = {
					...s,
					enabled: true,
					phase: "starting",
					currentMatchId: null,
					nextStartAt: null,
					error: null,
				};
			else if (s.phase === "draining")
				record.snapshot = { ...s, enabled: true, phase: "running" };
		} else if (s.enabled) {
			if (s.phase === "running" || s.phase === "draining")
				record.snapshot = { ...s, enabled: false, phase: "draining" };
			else if (s.phase === "fault") record.snapshot = { ...s, enabled: false };
			else {
				cancel = s.currentMatchId;
				record.generation++;
				record.snapshot = {
					...s,
					enabled: false,
					phase: "stopped",
					currentMatchId: null,
					lastMatchId: cancel ?? s.lastMatchId,
					nextStartAt: null,
				};
			}
		}
		if (record.snapshot !== s)
			record.snapshot = {
				...record.snapshot,
				revision: s.revision + 1,
				serverTime: this.now(),
			};
		const receipt: WatchReceipt = {
			requestId: c.requestId,
			enabled: c.enabled,
			revision: record.snapshot.revision,
			acceptedAt: this.now(),
		};
		this.persist(() => {
			if (record.snapshot !== s) this.store.write(record);
			this.store.remember(c.requestId, hash, receipt);
		});
		if (cancel) {
			this.stopMatch(this.service.store.get(cancel), "controller_stop");
			this.controller?.abort(new DOMException("controller_stop", "AbortError"));
		}
		this.publish();
		this.schedule();
		return { receipt, state: this.snapshot() };
	}
	private schedule() {
		clearTimeout(this.timer);
		if (this.closing || !this.root || this.service.fault) return;
		const s = this.store.read().snapshot;
		if (
			!s.enabled ||
			this.task ||
			s.currentMatchId ||
			(s.phase !== "countdown" && s.phase !== "starting")
		)
			return;
		const revision = s.revision;
		this.timer = setTimeout(
			() => {
				if (
					this.closing ||
					this.service.fault ||
					this.store.read().snapshot.revision !== revision
				)
					return;
				try {
					this.begin();
				} catch (error) {
					try {
						this.fail(error);
					} catch (failure) {
						this.service.fail(failure);
					}
				}
			},
			s.nextStartAt === null ? 0 : Math.max(0, s.nextStartAt - this.now()),
		);
	}
	private begin() {
		if (this.closing || this.task || !this.root) return;
		const record = this.store.read(),
			s = record.snapshot;
		if (
			!s.enabled ||
			s.currentMatchId ||
			!["starting", "countdown"].includes(s.phase)
		)
			return;
		const config =
			s.phase === "starting" && record.config
				? record.config
				: this.validatedConfig();
		const generation = record.generation + 1,
			controlToken = randomBytes(32).toString("hex");
		const state = this.service.create(
			{
				requestId: randomUUID(),
				controlToken,
				agentName: `JEV 连续观战 · ${this.settings.jev.provider}`,
				model: this.settings.jev.model,
				config,
			},
			(id) => {
				this.store.assign(
					{
						generation,
						config,
						snapshot: {
							...s,
							revision: s.revision + 1,
							phase: "starting",
							currentMatchId: id,
							nextStartAt: null,
							serverTime: this.now(),
						},
					},
					id,
				);
			},
		);
		this.controlToken = controlToken;
		this.controller = new AbortController();
		this.task = Promise.resolve()
			.then(() =>
				(this.settings.run ?? runJevMatch)({
					root: this.root as string,
					state,
					controlToken,
					jev: this.settings.jev,
					signal: this.controller?.signal,
					log: this.settings.log,
				}),
			)
			.then((result) => this.finished(generation, state.id, result))
			.catch((error) => {
				if (this.closing) {
					if (error !== this.controller?.signal.reason)
						this.closeFailure = error;
					return;
				}
				try {
					if (this.store.read().generation !== generation) {
						if (error !== this.controller?.signal.reason)
							console.error(
								"[retired watch round failed]",
								this.message(error),
							);
						return;
					}
					this.fail(error);
				} catch (failure) {
					this.service.fail(failure);
				}
			})
			.finally(() => {
				this.task = null;
				this.controller = null;
				this.controlToken = "";
				this.schedule();
			});
		this.publish();
	}
	private finished(generation: number, id: string, result: PublicState) {
		if (this.closing) return;
		const record = this.store.read(),
			s = record.snapshot;
		if (record.generation !== generation || s.currentMatchId !== id) return;
		const actual = this.service.store.get(id);
		if (
			result.id !== id ||
			result.seq !== actual.seq ||
			result.status !== actual.status ||
			!["gameover", "won"].includes(actual.status)
		)
			throw new Error(
				`Channel round ended unexpectedly: ${actual.status} / ${actual.endReason}`,
			);
		record.snapshot = {
			...s,
			revision: s.revision + 1,
			currentMatchId: null,
			lastMatchId: id,
			phase: s.enabled ? "countdown" : "stopped",
			nextStartAt: s.enabled ? this.now() + this.settings.intermissionMs : null,
			serverTime: this.now(),
		};
		this.persist(() => this.store.write(record));
		this.publish();
	}
	private message(error: unknown) {
		let text = error instanceof Error ? error.message : String(error);
		for (const secret of [this.settings.jev.apiKey, this.controlToken])
			if (secret) text = text.replaceAll(secret, "[redacted]");
		return text;
	}
	private fail(error: unknown) {
		clearTimeout(this.timer);
		const message = this.message(error);
		console.error("[watch channel failed]", message);
		if (this.service.fault) return;
		const record = this.store.read(),
			s = record.snapshot;
		if (s.currentMatchId) {
			const current = this.service.store.get(s.currentMatchId);
			if (current.status === "ready" || current.status === "running")
				this.stopMatch(current, "model_error");
		}
		record.snapshot = {
			...s,
			revision: s.revision + 1,
			phase: "fault",
			currentMatchId: null,
			lastMatchId: s.currentMatchId ?? s.lastMatchId,
			nextStartAt: null,
			serverTime: this.now(),
			error: {
				code: error instanceof GameError ? error.code : "channel_error",
				message,
			},
		};
		this.persist(() => this.store.write(record));
		this.publish();
	}
	private stopMatch(match: PublicState, reason: string) {
		const receipt = this.service.command(match.id, {
			protocolVersion: 1,
			requestId: randomUUID(),
			type: "stop",
			reason,
		});
		if (receipt.status !== "applied")
			throw new Error(`Channel cleanup rejected: ${receipt.code}`);
	}
	async close() {
		this.closing = true;
		clearTimeout(this.timer);
		this.controller?.abort(new DOMException("server_shutdown", "AbortError"));
		await this.task;
		const current = this.store.read().snapshot.currentMatchId;
		if (current && !this.service.fault) {
			const match = this.service.store.get(current);
			if (match.status === "ready" || match.status === "running")
				this.stopMatch(match, "server_shutdown");
		}
		this.unsubscribe();
		this.listeners.clear();
		this.service.beforeStart = undefined;
		this.service.store.beforeMatchCommit = undefined;
		if (this.closeFailure) throw this.closeFailure;
	}
}
