import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
	allControlSchema,
	type ControlInput,
	createSchema,
	legacyCreateSchema,
	forkSchema,
} from "../../shared/snake/schema.js";
import {
	type DecisionContext,
	directions,
	isResponseMode,
	type MatchEvent,
	type MatchState,
	opposite,
	type PlanIntent,
	publicState,
	type Receipt,
} from "../../shared/snake/types.js";
import type { RequestWrite, Store } from "../db/store.js";
import { GameError } from "../errors.js";
import {
	createState,
	expireStar,
	inspectMove,
	move,
	stateHash,
} from "../game/engine.js";
import { ProgressHistory } from "../jev/progress.js";
import { restoreMatchAt } from "./restore.js";

export const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");
export function secretEqual(value: string, hash: string) {
	return timingSafeEqual(
		Buffer.from(digest(value), "hex"),
		Buffer.from(hash, "hex"),
	);
}
export class MatchService {
	beforeStart?: (id: string) => void;
	private anchors = new Map<string, number>();
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private listeners = new Set<(id: string) => void>();
	private progress = new Map<
		string,
		{ cursor: number; history: ProgressHistory }
	>();
	fault: string | null = null;
	constructor(
		readonly store: Store,
		readonly clock: () => number = () => performance.now(),
		private automatic = true,
	) {
		for (const s of store.active()) {
			const events: MatchEvent[] = [];
			const writes: RequestWrite[] = [];
			s.status = "interrupted";
			s.endReason = "server_restart";
			s.endedAt = new Date().toISOString();
			this.cancel(s, events, writes, "server_restart");
			this.event(s, events, "interrupted", { reason: "server_restart" });
			store.commit(s, events, writes);
		}
	}
	private event(
		s: MatchState,
		events: MatchEvent[],
		type: string,
		data: Record<string, unknown>,
	) {
		s.seq++;
		const event: MatchEvent = {
			matchId: s.id,
			seq: s.seq,
			tick: s.tick,
			gameTimeMs: s.gameTimeMs,
			createdAt: new Date().toISOString(),
			type,
			data,
			state: publicState(s),
		};
		events.push(event);
		return event;
	}
	private cancel(
		s: MatchState,
		events: MatchEvent[],
		writes: RequestWrite[],
		code: string,
	) {
		for (const p of s.pending) {
			if (s.lastDecision?.requestId === p.requestId)
				s.lastDecision.outcome = "cancelled";
			const e = this.event(s, events, "action_cancelled", {
				requestId: p.requestId,
				targetTick: p.targetTick,
				code,
			});
			writes.push({
				id: p.requestId,
				receipt: {
					requestId: p.requestId,
					status: "cancelled",
					code,
					targetTick: p.targetTick,
					seq: e.seq,
				},
			});
		}
		for (const plan of s.plans ?? []) {
			for (const index of [0, 1] as const) {
				if (["queued", "standby"].includes(plan.receipt.steps[index].status))
					this.cancelPlanStep(s, plan, index, events, writes, code);
			}
		}
		s.plans = s.plans ? [] : undefined;
		s.pending = [];
	}
	subscribe(listener: (id: string) => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private publish(id: string) {
		for (const listener of this.listeners) listener(id);
	}
	private assertHealthy() {
		if (this.fault) throw new GameError("service_failed", this.fault, 503);
	}
	fail(error: unknown) {
		this.fault = error instanceof Error ? error.message : String(error);
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		console.error("[game service stopped]", this.fault);
		for (const listener of this.listeners) listener("");
	}
	private commit(
		s: MatchState,
		events: MatchEvent[],
		writes: RequestWrite[] = [],
	) {
		try {
			this.store.commit(s, events, writes);
		} catch (error) {
			this.fail(error);
			throw error;
		}
		if (s.status !== "ready" && s.status !== "running")
			this.progress.delete(s.id);
		this.publish(s.id);
	}
	create(input: unknown, createdInTransaction?: (id: string) => void) {
		this.assertHealthy();
		const parsed = createSchema.safeParse(input);
		const legacy = legacyCreateSchema.safeParse(input);
		// Parsing old inputs here is solely for their stored idempotency hashes.
		const candidate = parsed.success ? parsed.data : legacy.data;
		if (!candidate)
			throw new GameError("invalid_request", parsed.error!.message);
		const creationHash = (c: typeof candidate) =>
			digest(JSON.stringify({ ...c, controlToken: digest(c.controlToken) }));
		const existing = this.store.byCreation(candidate.requestId);
		if (existing) {
			const hashes = [creationHash(candidate)];
			if (legacy.success) hashes.push(creationHash(legacy.data));
			if (!hashes.includes(existing.create_hash))
				throw new GameError(
					"request_id_conflict",
					"Creation request ID was already used with different content",
					409,
				);
			return publicState(this.store.get(existing.id));
		}
		if (!parsed.success)
			throw new GameError("invalid_request", parsed.error.message);
		const c = parsed.data;
		const hash = creationHash(c);
		const s = createState(
			randomUUID(),
			c.agentName,
			c.model,
			c.config,
			new Date().toISOString(),
		);
		const events: MatchEvent[] = [];
		this.event(s, events, "created", { seed: s.config.seed });
		this.store.create(
			s,
			digest(c.controlToken),
			c.requestId,
			hash,
			events[0],
			createdInTransaction,
		);
		this.publish(s.id);
		return publicState(s);
	}
	fork(sourceMatchId: string, input: unknown) {
		this.assertHealthy();
		const parsed = forkSchema.safeParse(input);
		if (!parsed.success)
			throw new GameError("invalid_request", parsed.error.message);
		const c = parsed.data;
		const hash = digest(
			JSON.stringify({
				sourceMatchId,
				...c,
				controlToken: digest(c.controlToken),
			}),
		);
		const existing = this.store.byCreation(c.requestId);
		if (existing) {
			if (existing.create_hash !== hash)
				throw new GameError(
					"request_id_conflict",
					"Creation request ID was already used with different content",
					409,
				);
			return publicState(this.store.get(existing.id));
		}
		const prefix = this.store.events(sourceMatchId, -1, c.sourceSeq + 1).events;
		const s = restoreMatchAt(prefix, c.sourceSeq);
		if (!isResponseMode(s.config))
			throw new GameError(
				"mode_retired",
				"Only response single-step matches can be forked; this historical match remains available for replay",
				409,
			);
		const forkedFrom = {
			matchId: sourceMatchId,
			seq: c.sourceSeq,
			tick: s.tick,
			gameTimeMs: s.gameTimeMs,
		};
		s.id = randomUUID();
		s.agentName = c.agentName;
		s.model = c.model;
		s.createdAt = new Date().toISOString();
		s.status = "ready";
		s.startedAt = null;
		s.endedAt = null;
		s.endReason = null;
		s.pending = [];
		if (s.plans) s.plans = [];
		s.lastDecision = null;
		delete s.lastAppliedAction;
		delete s.lastPlanOutcome;
		s.forkedFrom = forkedFrom;
		const events = prefix.map((event) => ({
			...event,
			matchId: s.id,
			state: { ...event.state, id: s.id, forkedFrom },
		}));
		this.event(s, events, "forked", forkedFrom);
		this.store.createFork(s, digest(c.controlToken), c.requestId, hash, events);
		this.publish(s.id);
		return publicState(s);
	}
	authorize(id: string, token: string) {
		if (!token || !secretEqual(token, this.store.controlHash(id)))
			throw new GameError(
				"unauthorized",
				"Valid match control credential required",
				401,
			);
	}
	// Internal channel recovery only; never exposed as an unauthenticated route.
	resume(id: string, controlToken: string, resumedInTransaction: () => void) {
		this.assertHealthy();
		const s = this.store.get(id);
		if (!isResponseMode(s.config))
			throw new GameError(
				"mode_retired",
				"Only response matches can resume",
				409,
			);
		if (
			s.status !== "ready" &&
			!(
				s.status === "interrupted" &&
				["server_restart", "server_shutdown"].includes(s.endReason ?? "")
			)
		)
			throw new GameError(
				"not_resumable",
				"Match was not interrupted by a server restart",
				409,
			);
		if (controlToken.length < 32)
			throw new GameError(
				"invalid_credential",
				"Recovery requires a new control credential",
			);
		const reason = s.endReason;
		s.status = "ready";
		s.endReason = null;
		s.endedAt = null;
		const events: MatchEvent[] = [];
		this.event(s, events, "resumed", { reason, fromTick: s.tick });
		try {
			this.store.resume(s, events, digest(controlToken), resumedInTransaction);
		} catch (error) {
			this.fail(error);
			throw error;
		}
		this.progress.delete(id);
		this.publish(id);
		return publicState(s);
	}
	elapsed(id: string) {
		const anchor = this.anchors.get(id);
		if (anchor === undefined) return this.store.get(id).gameTimeMs;
		return Math.max(0, this.clock() - anchor);
	}
	timing(id: string) {
		const state = this.store.get(id);
		const serverTime = Date.now();
		const elapsedGameTimeMs =
			state.status === "running" ? this.elapsed(id) : state.gameTimeMs;
		return {
			serverTime,
			elapsedGameTimeMs,
			stepMode: state.config.stepMode ?? "fixed",
			nextTick: state.status === "running" ? state.tick + 1 : null,
			nextTickAt: null,
		};
	}
	private schedule(id: string) {
		const timer = this.timers.get(id);
		if (timer) clearTimeout(timer);
		this.timers.delete(id);
		if (!this.automatic || this.fault) return;
		const s = this.store.get(id);
		if (s.status !== "running") {
			return;
		}
		const next = s.star?.expiresAt ?? Infinity;
		if (!Number.isFinite(next)) return;
		// Node timers have a signed 32-bit delay. Chunk a long wait without changing game speed.
		const delay = Math.min(2147483647, Math.max(0, next - this.elapsed(id)));
		this.timers.set(
			id,
			setTimeout(() => {
				this.timers.delete(id);
				try {
					this.advance(id);
				} catch (error) {
					if (!this.fault) this.fail(error);
				}
			}, delay),
		);
	}
	advance(id: string, at = this.clock()) {
		this.assertHealthy();
		const s = this.store.get(id);
		if (s.status !== "running") return;
		const anchor = this.anchors.get(id);
		if (anchor === undefined)
			throw new Error("Running match has no clock anchor");
		const elapsed = Math.max(0, at - anchor);
		const events: MatchEvent[] = [];
		if (!isResponseMode(s.config))
			throw new GameError(
				"mode_retired",
				"Fixed-step matches can no longer run",
				409,
			);
		if (s.star && s.star.expiresAt <= elapsed) {
			s.gameTimeMs = s.star.expiresAt;
			expireStar(s, s.gameTimeMs);
			this.event(s, events, "star_expired", {});
			this.commit(s, events);
		}
		this.schedule(id);
	}

	private getProgress(id: string, throughSeq: number): ProgressHistory {
		let cached = this.progress.get(id);
		if (!cached) {
			cached = { cursor: -1, history: new ProgressHistory() };
			this.progress.set(id, cached);
		}
		if (cached.cursor > throughSeq)
			throw new Error("Progress history is ahead of the observed sequence");
		while (cached.cursor < throughSeq) {
			const page = this.store.events(
				id,
				cached.cursor,
				Math.min(200, throughSeq - cached.cursor),
			);
			if (!page.events.length)
				throw new Error("Progress history event sequence is incomplete");
			for (const event of page.events) {
				cached.history.observe(event.state);
				cached.cursor = event.seq;
			}
		}
		return cached.history;
	}
	decisionContext(id: string): DecisionContext {
		this.assertHealthy();
		this.advance(id);
		const s = this.store.get(id);
		if (s.status === "running") {
			const blockedDirections = Object.fromEntries(
				directions.map((direction) => [
					direction,
					inspectMove(s, direction).immediateCollision,
				]),
			);
			if (
				directions.every((direction) => blockedDirections[direction] !== null)
			) {
				s.gameTimeMs = Math.max(s.gameTimeMs, this.elapsed(id));
				s.status = "gameover";
				s.endReason = "no_legal_moves";
				s.endedAt = new Date().toISOString();
				const events: MatchEvent[] = [];
				this.event(s, events, "trapped", {
					reason: s.endReason,
					blockedDirections,
				});
				this.commit(s, events);
				this.schedule(id);
			}
		}
		if (s.status !== "running")
			throw new GameError("not_running", "Match is not running", 409);
		const targetTick = s.tick + 1;
		return {
			observedSeq: s.seq,
			targetTick,
			expectedStateHash: stateHash(s),
			state: publicState(s),
			progress: this.getProgress(id, s.seq).snapshot(s),
			deadlineInMs: null,
			elapsedGameTimeMs: this.elapsed(id),
		};
	}
	command(id: string, input: unknown, receivedAt = this.clock()): Receipt {
		this.assertHealthy();
		const parsed = allControlSchema.safeParse(input);
		if (!parsed.success)
			throw new GameError("invalid_message", parsed.error.message);
		const command = parsed.data;
		const anchor = this.anchors.get(id);
		const receivedGameTimeMs =
			anchor === undefined ? null : Math.max(0, receivedAt - anchor);
		const receivedAtIso = new Date().toISOString();
		this.advance(id, receivedAt);
		const s = this.store.get(id);
		const hash = digest(JSON.stringify(command));
		const previous = this.store.request(id, command.requestId);
		if (previous) {
			if (previous.hash !== hash)
				throw new GameError(
					"request_id_conflict",
					"Request ID already used with different content",
					409,
				);
			return previous.receipt;
		}
		if (command.protocolVersion !== 1)
			throw new GameError(
				"unsupported_protocol",
				"Only single-step control protocol v1 is supported",
				409,
			);
		const events: MatchEvent[] = [];
		const writes: RequestWrite[] = [];
		let receipt: Receipt;
		if (s.status === "running")
			s.gameTimeMs = Math.max(
				s.gameTimeMs,
				receivedAt - (this.anchors.get(id) as number),
			);
		try {
			if (command.type !== "stop" && !isResponseMode(s.config))
				throw new GameError(
					"mode_retired",
					"Fixed-step matches are read-only; only response single-step matches can run",
					409,
				);
			if (command.type === "start") {
				this.beforeStart?.(id);
				if (s.status !== "ready")
					throw new GameError("not_ready", "Only a ready match can start", 409);
				s.status = "running";
				s.startedAt ??= new Date().toISOString();
				const e = this.event(s, events, "started", {});
				receipt = {
					requestId: command.requestId,
					status: "applied",
					seq: e.seq,
				};
			} else if (command.type === "stop") {
				if (s.status !== "ready" && s.status !== "running")
					throw new GameError("match_ended", "Match already ended", 409);
				s.status = "interrupted";
				s.endReason = command.reason;
				s.endedAt = new Date().toISOString();
				this.cancel(s, events, writes, command.reason);
				const e = this.event(s, events, "interrupted", {
					reason: command.reason,
				});
				receipt = {
					requestId: command.requestId,
					status: "applied",
					seq: e.seq,
				};
			} else {
				this.validateAction(s, command);
				if (command.decision)
					s.lastDecision = {
						...command.decision,
						requestId: command.requestId,
						targetTick: command.targetTick,
						outcome: "accepted",
					};
				const observed = this.store.events(id, command.observedSeq - 1, 1)
					.events[0];
				const e = this.event(s, events, "action_accepted", {
					requestId: command.requestId,
					direction: command.direction,
					targetTick: command.targetTick,
					expectedStateHash: command.expectedStateHash,
					observedSeq: command.observedSeq,
					receivedAt: receivedAtIso,
					receivedGameTimeMs,
					reactionMs: s.gameTimeMs - observed.gameTimeMs,
					decision: command.decision ?? null,
				});
				receipt = {
					requestId: command.requestId,
					status: "accepted",
					targetTick: command.targetTick,
					seq: e.seq,
				};
				{
					if (s.lastMoveGameTimeMs === undefined)
						throw new Error("Response match is missing its last movement time");
					const stepDurationMs = s.gameTimeMs - s.lastMoveGameTimeMs;
					const observedTick = s.tick;
					const result = move(s, command.direction);
					s.lastStepDurationMs = stepDurationMs;
					s.lastMoveGameTimeMs = s.gameTimeMs;
					s.lastAppliedAction = {
						source: "primary",
						stepIndex: 0,
						direction: command.direction,
						tick: s.tick,
						targetTick: command.targetTick,
						requestId: command.requestId,
						observedTick,
					};
					if (s.lastDecision?.requestId === command.requestId)
						s.lastDecision.outcome = "applied";
					if (s.status !== "running") s.endedAt = new Date().toISOString();
					const movement = this.event(s, events, result.type, {
						...result.data,
						requestId: command.requestId,
						actionStatus: "applied",
						stepDurationMs,
						receivedGameTimeMs,
						receivedAt: receivedAtIso,
					});
					receipt = {
						requestId: command.requestId,
						status: "applied",
						targetTick: command.targetTick,
						seq: movement.seq,
					};
				}
			}
		} catch (error) {
			if (!(error instanceof GameError)) throw error;
			const observed =
				command.type === "action"
					? this.store.events(id, command.observedSeq - 1, 1).events[0]
					: undefined;
			if (command.type === "action" && command.decision)
				s.lastDecision = {
					...command.decision,
					requestId: command.requestId,
					targetTick: command.targetTick,
					outcome: error.code,
				};
			const e = this.event(s, events, "action_rejected", {
				requestId: command.requestId,
				code: error.code,
				message: error.message,
				receivedAt: receivedAtIso,
				receivedGameTimeMs,
				reactionMs:
					observed && receivedGameTimeMs !== null
						? receivedGameTimeMs - observed.gameTimeMs
						: null,
				...(command.type === "action"
					? {
							targetTick: command.targetTick,
							observedSeq: command.observedSeq,
							direction: command.direction,
							decision: command.decision ?? null,
						}
					: {}),
			});
			receipt = {
				requestId: command.requestId,
				status: "rejected",
				code: error.code,
				seq: e.seq,
				...(command.type === "action"
					? { targetTick: command.targetTick }
					: {}),
			};
		}
		writes.push({ id: command.requestId, hash, receipt });
		if (command.type === "start" && receipt.status === "applied")
			this.anchors.set(id, this.clock() - s.gameTimeMs);
		this.commit(s, events, writes);
		this.schedule(id);
		return receipt;
	}
	private validateAction(
		s: MatchState,
		c: Extract<ControlInput, { type: "action" }>,
	) {
		if (s.status !== "running")
			throw new GameError("not_running", "Match is not running", 409);
		if (
			c.observedSeq > s.seq ||
			!this.store.events(s.id, c.observedSeq - 1, 1).events.length
		)
			throw new GameError(
				"invalid_observation",
				"Observation does not belong to this match",
			);
		if (c.targetTick <= s.tick)
			throw new GameError(
				"stale_state",
				"Observed position has already advanced",
				409,
			);
		if (c.targetTick !== s.tick + 1)
			throw new GameError(
				"invalid_target_tick",
				"Only the immediately upcoming movement may be controlled",
				409,
			);
		const observation = this.store.events(s.id, c.observedSeq - 1, 1).events[0];
		if (observation.tick !== s.tick)
			throw new GameError(
				"stale_state",
				"Observed position has already advanced; the action cannot be retargeted",
				409,
			);
		if (stateHash(s) !== c.expectedStateHash)
			throw new GameError(
				"stale_state",
				"Expected game state has changed",
				409,
			);
		if (c.decision && c.decision.choice !== c.direction)
			throw new GameError(
				"invalid_decision",
				"Submitted direction must match the original model choice",
			);
		if (c.direction === opposite[s.direction])
			throw new GameError(
				"invalid_direction",
				"Direct reversal is not allowed",
			);
	}
	private planWrite(s: MatchState, plan: PlanIntent, writes: RequestWrite[]) {
		if (s.lastDecision?.requestId === plan.requestId)
			s.lastDecision.steps = structuredClone(plan.receipt.steps);
		const existing = writes.find((w) => w.id === plan.requestId);
		if (existing) existing.receipt = structuredClone(plan.receipt);
		else
			writes.push({
				id: plan.requestId,
				receipt: structuredClone(plan.receipt),
			});
	}
	private cancelPlanStep(
		s: MatchState,
		plan: PlanIntent,
		index: 0 | 1,
		events: MatchEvent[],
		writes: RequestWrite[],
		reason?: string,
	) {
		const step = plan.receipt.steps[index];
		Object.assign(step, {
			status: "cancelled",
			seq: s.seq + 1,
			...(reason ? { reason } : {}),
		});
		this.planWrite(s, plan, writes);
		this.event(s, events, "plan_step_cancelled", {
			requestId: plan.requestId,
			stepIndex: index,
			targetTick: step.targetTick,
			direction: step.direction,
			observedTick: plan.observedTick,
			code: reason,
			steps: structuredClone(plan.receipt.steps),
		});
	}

	close() {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.listeners.clear();
		this.anchors.clear();
		this.progress.clear();
	}
}
