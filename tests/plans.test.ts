import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Store } from "../server/db/store.js";
import { MatchService } from "../server/matches/service.js";
import { allControlSchema } from "../shared/snake/schema.js";
import { type MatchState, publicState } from "../shared/snake/types.js";
import { makePlan } from "./plan-fixture.js";

const disposers: (() => void)[] = [];
afterEach(() => {
	for (const close of disposers.splice(0).reverse()) close();
	vi.restoreAllMocks();
});
function fixture(configureReady?: (state: MatchState) => void) {
	const dir = mkdtempSync(join(tmpdir(), "snake-plans-"));
	const path = join(dir, "game.sqlite");
	const store = new Store(path);
	let now = 0;
	const service = new MatchService(store, () => now, false);
	disposers.push(() => {
		service.close();
		if (store.db.open) store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const creation = {
		requestId: "create",
		controlToken: "test-token".repeat(4),
		agentName: "Test only",
		config: {
			width: 24,
			height: 18,
			obstacleCount: 0,
			tickIntervalMs: 500,
			seed: "plans",
			decisionMode: "two_step_fallback",
		},
	};
	const match = service.create(creation);
	if (configureReady) {
		const ready = store.get(match.id);
		configureReady(ready);
		store.commit(ready, []);
	}
	service.command(match.id, {
		protocolVersion: 2,
		requestId: "start",
		type: "start",
	});
	return {
		path,
		store,
		service,
		match,
		creation,
		context: () => service.decisionContext(match.id),
		read: () => store.get(match.id),
		events: () => store.events(match.id, -1).events,
		send: (command: unknown) => service.command(match.id, command),
		time: (t: number) => {
			now = t;
		},
		advance: (t: number) => {
			now = t;
			service.advance(match.id);
		},
		receipt: (id: string) => store.request(match.id, id)?.receipt,
	};
}
test("protocol rejects malformed pairs, unknown versions, injected request secrets and mismatched modes", () => {
	const f = fixture();
	const a = makePlan(f.context());
	expect(allControlSchema.safeParse(a).success).toBe(true);
	expect(
		allControlSchema.safeParse({ ...a, directions: ["right"] }).success,
	).toBe(false);
	expect(allControlSchema.safeParse({ ...a, protocolVersion: 3 }).success).toBe(
		false,
	);
	expect(
		allControlSchema.safeParse({
			...a,
			decision: {
				...a.decision,
				request: {
					...a.decision.request,
					headers: { Authorization: "private" },
				},
			},
		}).success,
	).toBe(false);
	const before = f.read();
	expect(() =>
		f.send({ protocolVersion: 1, type: "stop", requestId: "wrong" }),
	).toThrow("decision mode");
	expect(f.read()).toEqual(before);
	expect(() =>
		f.service.create({
			...f.creation,
			config: { ...f.creation.config, decisionMode: "single_step" },
		}),
	).toThrow("different content");
});
test("500ms: stored second step executes while next request is absent; late whole plan is rejected and backup is exhausted", () => {
	const f = fixture();
	const a = makePlan(f.context());
	const head = f.read().snake[0];
	expect(f.send(a).steps?.map((s) => s.status)).toEqual(["queued", "standby"]);
	expect(f.read().snake[0]).toEqual(head);
	f.advance(500);
	const b = makePlan(f.context(), "down_right", "B");
	expect(f.read().lastAppliedAction).toMatchObject({
		source: "primary",
		requestId: "plan-A",
		stepIndex: 0,
	});
	f.advance(1000);
	expect(f.read().snake[0]).toEqual({ x: head.x + 1, y: head.y + 1 });
	expect(f.read().lastAppliedAction).toMatchObject({
		source: "fallback",
		requestId: "plan-A",
		stepIndex: 1,
	});
	f.time(1100);
	expect(f.send(b).code).toBe("late_action");
	expect(f.read().lastAppliedAction?.requestId).toBe("plan-A");
	expect(f.receipt("B")?.steps?.map((s) => s.status)).toEqual([
		"rejected",
		"rejected",
	]);
	f.advance(1500);
	expect(f.read().lastAppliedAction).toMatchObject({
		source: "coast",
		reason: "backup_exhausted",
	});
	expect(f.receipt("plan-A")?.steps?.map((s) => s.status)).toEqual([
		"applied",
		"applied",
	]);
	expect(
		f.events().filter((e) => e.data.actionStatus === "applied"),
	).toHaveLength(2);
});
test("fresh primary supersedes backup only at boundary and duplicate reads retain both outcomes", () => {
	const f = fixture();
	const a = makePlan(f.context());
	f.send(a);
	f.advance(500);
	const b = makePlan(f.context(), "up_right", "B");
	f.time(600);
	f.send(b);
	expect(f.receipt("plan-A")?.steps?.[1].status).toBe("standby");
	expect(publicState(f.read()).scheduledActions).toHaveLength(3);
	f.advance(1000);
	expect(f.read().direction).toBe("up");
	expect(f.send(a).steps?.map((s) => s.status)).toEqual([
		"applied",
		"superseded",
	]);
	expect(f.send(a).steps?.[1].replacementRequestId).toBe("B");
	expect(() => f.send({ ...a, directions: ["right", "up"] })).toThrow(
		"different content",
	);
	f.advance(1500);
	expect(f.read().lastAppliedAction).toMatchObject({
		source: "fallback",
		requestId: "B",
	});
});
test.each([500, 650])(
	"first response at %dms cannot salvage its second step",
	(time) => {
		const f = fixture();
		const a = makePlan(f.context());
		f.time(time);
		expect(f.send(a).code).toBe("late_action");
		f.advance(1000);
		expect(f.read().lastAppliedAction).toMatchObject({
			source: "coast",
			reason: "no_plan",
		});
		expect(f.read().plans).toEqual([]);
	},
);
test("primary invalidation by reward expiry preserves the previous backup", () => {
	const f = fixture((s) => {
		s.star = { point: { x: 0, y: 0 }, expiresAt: 1000 };
	});
	f.send(makePlan(f.context()));
	f.advance(500);
	f.send(makePlan(f.context(), "up_right", "B"));
	f.advance(1000);
	expect(f.read().lastAppliedAction).toMatchObject({
		source: "fallback",
		requestId: "plan-A",
	});
	expect(f.receipt("B")?.steps?.map((s) => s.status)).toEqual([
		"cancelled",
		"cancelled",
	]);
	expect(f.receipt("plan-A")?.steps?.[1].status).toBe("applied");
});
test("eating and randomly spawning food does not invalidate an eligible backup", () => {
	const f = fixture((s) => {
		s.apple = { x: s.snake[0].x + 1, y: s.snake[0].y };
	});
	f.send(makePlan(f.context()));
	f.advance(500);
	expect(f.read().score).toBe(10);
	f.advance(1000);
	expect(f.read().lastAppliedAction?.source).toBe("fallback");
});
test("cancelled first step never enables backup even when coasting has the same direction", () => {
	const f = fixture((s) => {
		s.star = { point: { x: 0, y: 0 }, expiresAt: 500 };
	});
	f.send(makePlan(f.context()));
	f.advance(1000);
	expect(f.read().direction).toBe("right");
	expect(f.receipt("plan-A")?.steps?.map((s) => s.status)).toEqual([
		"cancelled",
		"cancelled",
	]);
	expect(
		f.events().some((e) => e.state.lastAppliedAction?.source === "fallback"),
	).toBe(false);
});
test("invalid observations, pair mismatch, reverse and duplicate primary leave slots unclaimed", () => {
	const f = fixture();
	const a = makePlan(f.context());
	expect(
		f.send({ ...a, requestId: "choice", directions: ["right", "up"] }).code,
	).toBe("invalid_plan");
	expect(f.send({ ...a, requestId: "obs", observedSeq: 999 }).code).toBe(
		"invalid_observation",
	);
	expect(f.send({ ...a, requestId: "future", targetTick: 3 }).code).toBe(
		"invalid_target_tick",
	);
	expect(
		f.send({ ...a, requestId: "hash", expectedStateHash: "0".repeat(64) }).code,
	).toBe("stale_state");
	expect(f.send(makePlan(f.context(), "right_left", "reverse")).code).toBe(
		"invalid_direction",
	);
	expect(f.read().plans).toEqual([]);
	expect(f.send(a).status).toBe("accepted");
	expect(f.send({ ...a, requestId: "conflict" }).code).toBe(
		"tick_action_conflict",
	);
});
test("backup can really collide; terminal receipt and subsequent arrival keep actual timestamps", () => {
	const f = fixture((s) => {
		s.obstacles = [{ x: s.snake[0].x + 1, y: s.snake[0].y + 1 }];
	});
	f.send(makePlan(f.context()));
	f.advance(500);
	const late = makePlan(f.context(), "up_up", "late");
	f.advance(1000);
	expect(f.read()).toMatchObject({
		status: "gameover",
		endReason: "obstacle",
		tick: 2,
		lastAppliedAction: { source: "fallback" },
	});
	f.time(1200);
	expect(f.send(late).code).toBe("not_running");
	expect(f.events().at(-1)?.data.receivedGameTimeMs).toBe(1200);
	expect(f.events().at(-1)?.gameTimeMs).toBe(1000);
	expect(f.receipt("plan-A")?.steps?.[1].status).toBe("applied");
});
test("catchup consumes exactly one backup and stops using it for later ticks", () => {
	const f = fixture();
	f.send(makePlan(f.context()));
	f.advance(2000);
	expect(f.read().tick).toBe(4);
	expect(
		f
			.events()
			.filter((e) => e.data.actionSource)
			.map((e) => e.state.lastAppliedAction?.source),
	).toEqual(["primary", "fallback", "coast", "coast"]);
});
test.each(["accept", "replace"])(
	"%s transaction failure does not leak partial plans, receipts or success broadcasts",
	(phase) => {
		const f = fixture();
		const a = makePlan(f.context());
		if (phase === "replace") {
			f.send(a);
			f.advance(500);
			f.send(makePlan(f.context(), "up_right", "B"));
		}
		const before = f.read();
		const listener = vi.fn();
		f.service.subscribe(listener);
		f.store.db.exec(
			"CREATE TRIGGER fail_plan BEFORE INSERT ON match_events BEGIN SELECT RAISE(ABORT, 'plan write failed'); END",
		);
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => (phase === "accept" ? f.send(a) : f.advance(1000))).toThrow(
			"plan write failed",
		);
		expect(f.read()).toEqual(before);
		expect(
			listener.mock.calls.filter(([id]) => id === f.match.id),
		).toHaveLength(0);
		if (phase === "accept") expect(f.receipt("plan-A")).toBeUndefined();
		else expect(f.receipt("plan-A")?.steps?.[1].status).toBe("standby");
	},
);
test("v2 SQLite reread, restart cancellation, stop, old records and unknown version boundaries", () => {
	const f = fixture();
	const a = makePlan(f.context());
	f.send(a);
	f.advance(500);
	const reader = new Store(f.path);
	expect(reader.get(f.match.id)).toEqual(f.read());
	reader.close();
	f.service.close();
	const restart = new MatchService(f.store, () => 0, false);
	disposers.push(() => restart.close());
	expect(f.read()).toMatchObject({
		status: "interrupted",
		endReason: "server_restart",
		tick: 1,
		plans: [],
	});
	expect(restart.command(f.match.id, a).steps?.map((s) => s.status)).toEqual([
		"applied",
		"cancelled",
	]);
	const g = fixture();
	g.send(makePlan(g.context()));
	g.send({ protocolVersion: 2, type: "stop", requestId: "stop" });
	expect(g.receipt("plan-A")?.steps?.map((s) => s.status)).toEqual([
		"cancelled",
		"cancelled",
	]);
	const old = g.service.create({
		...g.creation,
		requestId: "old",
		config: { ...g.creation.config, decisionMode: undefined },
	});
	expect(old.recordVersion).toBe(1);
	expect(g.store.get(old.id).recordVersion).toBe(1);
	const corrupt = g.read();
	corrupt.rulesVersion = 1;
	g.store.commit(corrupt, []);
	expect(() => g.read()).toThrow("Unsupported");
});
