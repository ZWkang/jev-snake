import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
	allControlSchema,
	type ControlInput,
	createSchema,
	forkSchema,
} from "../../shared/snake/schema.js";
import {
	type AppliedAction,
	type DecisionContext,
	isResponseMode,
	type MatchEvent,
	type MatchState,
	opposite,
	type PlanIntent,
	type PlanStep,
	publicState,
	type Receipt,
} from "../../shared/snake/types.js";
import type { RequestWrite, Store } from "../db/store.js";
import { GameError } from "../errors.js";
import { createState, expireStar, move, stateHash } from "../game/engine.js";
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
					this.finishPlanStep(
						s,
						plan,
						index,
						"cancelled",
						events,
						writes,
						code,
					);
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
		if (!parsed.success)
			throw new GameError("invalid_request", parsed.error.message);
		const c = parsed.data;
		const hash = digest(
			JSON.stringify({ ...c, controlToken: digest(c.controlToken) }),
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
			nextTickAt:
				state.status === "running" && !isResponseMode(state.config)
					? serverTime +
						(state.tick + 1) * state.config.tickIntervalMs -
						elapsedGameTimeMs
					: null,
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
		const next = Math.min(
			isResponseMode(s.config)
				? Infinity
				: (s.tick + 1) * s.config.tickIntervalMs,
			s.star?.expiresAt ?? Infinity,
		);
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
		const writes: RequestWrite[] = [];
		if (isResponseMode(s.config)) {
			if (s.star && s.star.expiresAt <= elapsed) {
				s.gameTimeMs = s.star.expiresAt;
				expireStar(s, s.gameTimeMs);
				this.event(s, events, "star_expired", {});
				this.commit(s, events);
			}
			this.schedule(id);
			return;
		}
		while (s.status === "running") {
			const nextTickAt = (s.tick + 1) * s.config.tickIntervalMs;
			const expiry = s.star?.expiresAt ?? Infinity;
			if (Math.min(nextTickAt, expiry) > elapsed) break;
			if (expiry <= nextTickAt) {
				s.gameTimeMs = expiry;
				expireStar(s, expiry);
				this.event(s, events, "star_expired", {});
				continue;
			}
			s.gameTimeMs = nextTickAt;
			if (s.config.decisionMode === "two_step_fallback") {
				this.advancePlan(s, events, writes, elapsed - nextTickAt);
				continue;
			}
			const target = s.tick + 1;
			const intent = s.pending.find((p) => p.targetTick === target);
			s.pending = s.pending.filter((p) => p.targetTick !== target);
			let direction = s.direction;
			let applied = false;
			if (intent) {
				if (
					intent.expectedStateHash !== stateHash(s) ||
					intent.direction === opposite[s.direction]
				) {
					if (s.lastDecision?.requestId === intent.requestId)
						s.lastDecision.outcome = "cancelled";
					const e = this.event(s, events, "action_cancelled", {
						code: "stale_state",
						requestId: intent.requestId,
						targetTick: target,
					});
					writes.push({
						id: intent.requestId,
						receipt: {
							requestId: intent.requestId,
							status: "cancelled",
							code: "stale_state",
							targetTick: target,
							seq: e.seq,
						},
					});
				} else {
					direction = intent.direction;
					applied = true;
					if (s.lastDecision?.requestId === intent.requestId)
						s.lastDecision.outcome = "applied";
				}
			}
			const result = move(s, direction);
			if (s.status !== "running") s.endedAt = new Date().toISOString();
			const e = this.event(s, events, result.type, {
				...result.data,
				schedulerLagMs: elapsed - nextTickAt,
				...(applied && intent
					? { requestId: intent.requestId, actionStatus: "applied" }
					: {}),
			});
			if (applied && intent)
				writes.push({
					id: intent.requestId,
					receipt: {
						requestId: intent.requestId,
						status: "applied",
						targetTick: target,
						seq: e.seq,
					},
				});
			if (s.status !== "running") this.cancel(s, events, writes, "match_ended");
		}
		if (events.length) this.commit(s, events, writes);
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
		if (s.status !== "running")
			throw new GameError("not_running", "Match is not running", 409);
		const targetTick = s.tick + 1;
		if (
			s.pending.length ||
			s.plans?.some((p) => p.receipt.steps[0].status === "queued")
		)
			throw new GameError(
				"tick_action_conflict",
				"The upcoming movement already has a decision",
				409,
			);
		return {
			observedSeq: s.seq,
			targetTick,
			expectedStateHash: stateHash(s),
			state: publicState(s),
			progress: this.getProgress(id, s.seq).snapshot(s),
			deadlineInMs: isResponseMode(s.config)
				? null
				: targetTick * s.config.tickIntervalMs - this.elapsed(id),
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
		const expectedProtocol =
			s.config.decisionMode === "two_step_fallback" ? 2 : 1;
		if (command.protocolVersion !== expectedProtocol)
			throw new GameError(
				"decision_mode_mismatch",
				"Control protocol does not match this match's decision mode",
				409,
			);
		if (command.type === "plan")
			return this.acceptPlan(
				s,
				command,
				hash,
				receivedGameTimeMs,
				receivedAtIso,
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
			if (command.type === "start") {
				this.beforeStart?.(id);
				if (s.status !== "ready")
					throw new GameError("not_ready", "Only a ready match can start", 409);
				s.status = "running";
				s.startedAt = new Date().toISOString();
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
				if (!isResponseMode(s.config))
					s.pending.push({ ...command, receivedGameTimeMs: s.gameTimeMs });
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
				if (isResponseMode(s.config)) {
					if (s.lastMoveGameTimeMs === undefined)
						throw new Error("Response match is missing its last movement time");
					const stepDurationMs = s.gameTimeMs - s.lastMoveGameTimeMs;
					const observedTick = s.tick;
					const result = move(s, command.direction);
					s.lastStepDurationMs = stepDurationMs;
					s.lastMoveGameTimeMs = s.gameTimeMs;
					s.lastAppliedAction = {
						source: "primary",
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
		if (isResponseMode(s.config) && c.targetTick <= s.tick)
			throw new GameError(
				"stale_state",
				"Observed position has already advanced",
				409,
			);
		if (
			!isResponseMode(s.config) &&
			(c.targetTick <= s.tick ||
				c.targetTick * s.config.tickIntervalMs <= s.gameTimeMs)
		)
			throw new GameError(
				"late_action",
				"Target tick deadline has passed",
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
		if (
			s.pending.some((p) => p.targetTick === c.targetTick) ||
			s.plans?.some(
				(p) =>
					p.receipt.steps[0].status === "queued" &&
					p.targetTick === c.targetTick,
			)
		)
			throw new GameError(
				"tick_action_conflict",
				"Target tick already has an accepted direction",
				409,
			);
		if (stateHash(s) !== c.expectedStateHash)
			throw new GameError(
				"stale_state",
				"Expected game state has changed",
				409,
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
	private finishPlanStep(
		s: MatchState,
		plan: PlanIntent,
		index: 0 | 1,
		status: PlanStep["status"],
		events: MatchEvent[],
		writes: RequestWrite[],
		reason?: string,
		replacementRequestId?: string,
	) {
		const step = plan.receipt.steps[index];
		Object.assign(step, {
			status,
			seq: s.seq + 1,
			...(reason ? { reason } : {}),
			...(replacementRequestId ? { replacementRequestId } : {}),
		});
		this.planWrite(s, plan, writes);
		this.event(s, events, `plan_step_${status}`, {
			requestId: plan.requestId,
			stepIndex: index,
			targetTick: step.targetTick,
			direction: step.direction,
			observedTick: plan.observedTick,
			code: reason,
			replacementRequestId,
			steps: structuredClone(plan.receipt.steps),
		});
	}
	private advancePlan(
		s: MatchState,
		events: MatchEvent[],
		writes: RequestWrite[],
		schedulerLagMs: number,
	) {
		const targetTick = s.tick + 1;
		const plans = s.plans as PlanIntent[];
		let invalid = false;
		// Retire expired items without rebinding them to this movement.
		for (const p of plans)
			for (const i of [0, 1] as const) {
				const step = p.receipt.steps[i];
				if (
					(step.status === "queued" || step.status === "standby") &&
					step.targetTick < targetTick
				) {
					this.finishPlanStep(
						s,
						p,
						i,
						"expired",
						events,
						writes,
						"target_expired",
					);
					invalid = true;
				}
			}
		let primary = plans.find(
			(p) =>
				p.targetTick === targetTick && p.receipt.steps[0].status === "queued",
		);
		const backup = plans.find(
			(p) =>
				p.receipt.steps[1].targetTick === targetTick &&
				p.receipt.steps[1].status === "standby",
		);
		if (
			primary &&
			(primary.expectedStateHash !== stateHash(s) ||
				primary.directions[0] === opposite[s.direction])
		) {
			this.finishPlanStep(
				s,
				primary,
				0,
				"cancelled",
				events,
				writes,
				"stale_state",
			);
			this.finishPlanStep(
				s,
				primary,
				1,
				"cancelled",
				events,
				writes,
				"parent_not_applied",
			);
			primary = undefined;
			invalid = true;
		}
		let selected: PlanIntent | undefined = primary;
		let stepIndex: 0 | 1 = 0;
		if (primary && backup)
			this.finishPlanStep(
				s,
				backup,
				1,
				"superseded",
				events,
				writes,
				"fresh_decision",
				primary.requestId,
			);
		else if (backup) {
			const parent = backup.receipt.steps[0];
			if (
				parent.status === "applied" &&
				parent.targetTick === s.tick &&
				s.lastAppliedAction?.requestId === backup.requestId &&
				s.lastAppliedAction.stepIndex === 0 &&
				backup.directions[1] !== opposite[s.direction]
			) {
				selected = backup;
				stepIndex = 1;
			} else {
				this.finishPlanStep(
					s,
					backup,
					1,
					"cancelled",
					events,
					writes,
					"parent_not_applied",
				);
				invalid = true;
			}
		}
		const action: AppliedAction = selected
			? {
					source: stepIndex === 0 ? "primary" : "fallback",
					direction: selected.directions[stepIndex],
					tick: targetTick,
					targetTick,
					requestId: selected.requestId,
					stepIndex,
					observedTick: selected.observedTick,
				}
			: {
					source: "coast",
					direction: s.direction,
					tick: targetTick,
					targetTick,
					reason:
						invalid || s.lastPlanOutcome === "invalid"
							? "backup_invalid"
							: s.lastPlanOutcome
								? "backup_exhausted"
								: "no_plan",
				};
		s.lastAppliedAction = action;
		const result = move(s, action.direction);
		if (s.status !== "running") s.endedAt = new Date().toISOString();
		if (selected) {
			Object.assign(selected.receipt.steps[stepIndex], {
				status: "applied",
				seq: s.seq + 1,
			});
			this.planWrite(s, selected, writes);
			s.lastPlanOutcome = "consumed";
		} else if (invalid) s.lastPlanOutcome = "invalid";
		this.event(s, events, result.type, {
			...result.data,
			schedulerLagMs,
			actionSource: action,
			...(selected
				? {
						requestId: selected.requestId,
						stepIndex,
						actionStatus: "applied",
						steps: structuredClone(selected.receipt.steps),
					}
				: {}),
		});
		if (s.status !== "running") this.cancel(s, events, writes, "match_ended");
		else
			s.plans = plans.filter((p) =>
				p.receipt.steps.some(
					(step) => step.status === "queued" || step.status === "standby",
				),
			);
	}
	private acceptPlan(
		s: MatchState,
		command: Extract<ControlInput, { type: "plan" }>,
		hash: string,
		receivedGameTimeMs: number | null,
		receivedAt: string,
	): Receipt {
		const events: MatchEvent[] = [];
		const steps: [PlanStep, PlanStep] = [0, 1].map((i) => ({
			targetTick: command.targetTick + i,
			direction: command.directions[i],
			status: i === 0 ? "queued" : "standby",
			seq: s.seq + 1,
		})) as [PlanStep, PlanStep];
		const receipt: Receipt & { steps: [PlanStep, PlanStep] } = {
			protocolVersion: 2,
			requestId: command.requestId,
			status: "accepted",
			targetTick: command.targetTick,
			seq: s.seq + 1,
			steps,
		};
		if (s.status === "running")
			s.gameTimeMs = Math.max(s.gameTimeMs, receivedGameTimeMs as number);
		let code: string | undefined;
		let message: string | undefined;
		try {
			this.validateAction(s, {
				...command,
				type: "action",
				protocolVersion: 1,
				direction: command.directions[0],
				decision: undefined,
			});
			const request = command.decision.request;
			if (
				command.decision.choice !== command.directions.join("_") ||
				request.state.timing.observedTick !== s.tick ||
				request.state.timing.targetTick !== command.targetTick ||
				request.state.targetTicks[0] !== command.targetTick ||
				request.state.targetTicks[1] !== command.targetTick + 1
			)
				throw new GameError(
					"invalid_plan",
					"Plan choice, observation and targets must agree",
				);
			if (command.directions[1] === opposite[command.directions[0]])
				throw new GameError(
					"invalid_direction",
					"Backup cannot reverse the first move",
				);
		} catch (error) {
			if (!(error instanceof GameError)) throw error;
			code = error.code;
			message = error.message;
			receipt.status = "rejected";
			receipt.code = code;
			for (const step of steps) {
				step.status = "rejected";
				step.reason = code;
			}
		}
		s.lastDecision = {
			...command.decision,
			requestId: command.requestId,
			targetTick: command.targetTick,
			outcome: code ?? "accepted",
			steps: structuredClone(steps),
		};
		if (!code)
			(s.plans as PlanIntent[]).push({
				requestId: command.requestId,
				observedSeq: command.observedSeq,
				observedTick: s.tick,
				targetTick: command.targetTick,
				expectedStateHash: command.expectedStateHash,
				directions: command.directions,
				decision: command.decision,
				receipt,
			});
		const observed = this.store.events(s.id, command.observedSeq - 1, 1)
			.events[0];
		this.event(s, events, code ? "plan_rejected" : "plan_accepted", {
			requestId: command.requestId,
			observedSeq: command.observedSeq,
			observedTick: command.decision.request.state.timing.observedTick,
			targetTick: command.targetTick,
			targetTicks: steps.map((step) => step.targetTick),
			directions: command.directions,
			expectedStateHash: command.expectedStateHash,
			decision: command.decision,
			steps: structuredClone(steps),
			code,
			message,
			receivedAt,
			receivedGameTimeMs,
			reactionMs:
				observed && receivedGameTimeMs !== null
					? receivedGameTimeMs - observed.gameTimeMs
					: null,
		});
		this.commit(s, events, [{ id: command.requestId, hash, receipt }]);
		this.schedule(s.id);
		return receipt;
	}

	close() {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.listeners.clear();
		this.anchors.clear();
		this.progress.clear();
	}
}
