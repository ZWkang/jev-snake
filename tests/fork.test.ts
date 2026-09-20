import { afterEach, expect, test } from "vitest";
import { Store } from "../server/db/store.js";
import { MatchService } from "../server/matches/service.js";
import {
	type DecisionContext,
	type Direction,
	directions,
	type MatchState,
	vectors,
} from "../shared/snake/types.js";

const disposers: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposers.splice(0).reverse()) dispose();
});

const sourceToken = "original-controller-token".repeat(2);
const forkToken = "new-controller-token".repeat(2);
function fixture(config: Record<string, unknown> = {}) {
	const store = new Store(":memory:");
	let now = 0;
	const service = new MatchService(store, () => now, false);
	disposers.push(() => {
		service.close();
		store.close();
	});
	const source = service.create({
		requestId: "create-source",
		controlToken: sourceToken,
		agentName: "Original controller",
		model: "original-model",
		config: {
			width: 12,
			height: 9,
			obstacleCount: 0,
			seed: "fork-test",
			stepMode: "response",
			...config,
		},
	});
	const protocolVersion =
		source.config.decisionMode === "two_step_fallback" ? 2 : 1;
	const start = (id = source.id) =>
		service.command(id, { protocolVersion, type: "start", requestId: "start" });
	return {
		store,
		service,
		source,
		start,
		time: (at: number) => {
			now = at;
		},
		move: (direction: Direction, id = source.id, requestId?: string) => {
			const context = service.decisionContext(id);
			now += 100;
			return service.command(id, action(context, direction, requestId));
		},
		fork: (sourceSeq = store.get(source.id).seq, requestId = "fork-request") =>
			service.fork(source.id, forkInput(sourceSeq, requestId)),
	};
}
function forkInput(sourceSeq: number, requestId = "fork-request") {
	return {
		requestId,
		controlToken: forkToken,
		agentName: "Resumed controller",
		model: "current-model",
		sourceSeq,
	};
}
function action(
	context: DecisionContext,
	direction: Direction,
	requestId = `move-${context.targetTick}`,
) {
	return {
		protocolVersion: 1,
		type: "action",
		requestId,
		observedSeq: context.observedSeq,
		targetTick: context.targetTick,
		expectedStateHash: context.expectedStateHash,
		direction,
		decision: {
			model: "test-model",
			choice: direction,
			probabilities: Object.fromEntries(
				directions.map((d) => [d, d === direction ? 1 : 0]),
			),
			confidence: 1,
			requestMs: 10,
		},
	};
}
function savedRows(store: Store, id: string) {
	return {
		match: store.db.prepare("SELECT * FROM matches WHERE id=?").get(id),
		events: store.db
			.prepare("SELECT * FROM match_events WHERE match_id=? ORDER BY seq")
			.all(id),
		requests: store.db
			.prepare(
				"SELECT * FROM control_requests WHERE match_id=? ORDER BY request_id",
			)
			.all(id),
	};
}
function routeToApple(s: MatchState): Direction[] {
	const occupied = new Set(
		[...s.snake.slice(0, -1), ...s.obstacles].map((p) => `${p.x},${p.y}`),
	);
	const queue = [{ point: s.snake[0], route: [] as Direction[] }];
	const visited = new Set([`${s.snake[0].x},${s.snake[0].y}`]);
	for (const { point, route } of queue) {
		if (point.x === s.apple?.x && point.y === s.apple.y) return route;
		for (const direction of directions) {
			const delta = vectors[direction];
			const next = { x: point.x + delta.x, y: point.y + delta.y };
			const key = `${next.x},${next.y}`;
			if (
				next.x < 0 ||
				next.y < 0 ||
				next.x >= s.config.width ||
				next.y >= s.config.height ||
				occupied.has(key) ||
				visited.has(key)
			)
				continue;
			visited.add(key);
			queue.push({ point: next, route: [...route, direction] });
		}
	}
	throw new Error("Test fixture has no route to apple");
}

test("fork copies only the complete prefix, preserves history, and starts a separate controller", () => {
	const f = fixture();
	f.start();
	const lap: Direction[] = [
		"right",
		"right",
		"down",
		"down",
		"left",
		"left",
		"up",
		"up",
	];
	for (const direction of [...lap, ...lap])
		expect(f.move(direction).status).toBe("applied");
	const checkpoint = f.store.get(f.source.id);
	const context = f.service.decisionContext(f.source.id);
	f.move("right");
	f.move("right");
	const original = savedRows(f.store, f.source.id);
	const prefix = f.store.events(f.source.id, -1, checkpoint.seq + 1).events;
	const fork = f.fork(checkpoint.seq);
	expect(fork).toMatchObject({
		status: "ready",
		tick: checkpoint.tick,
		gameTimeMs: checkpoint.gameTimeMs,
		startedAt: null,
		endedAt: null,
		endReason: null,
		lastDecision: null,
		agentName: "Resumed controller",
		model: "current-model",
		forkedFrom: {
			matchId: f.source.id,
			seq: checkpoint.seq,
			tick: checkpoint.tick,
			gameTimeMs: checkpoint.gameTimeMs,
		},
	});
	expect(fork).not.toHaveProperty("lastAppliedAction");
	expect(fork.id).not.toBe(f.source.id);
	expect(f.store.get(fork.id)).toMatchObject({
		rngState: checkpoint.rngState,
		snake: checkpoint.snake,
		apple: checkpoint.apple,
		score: checkpoint.score,
		applesEaten: checkpoint.applesEaten,
		config: checkpoint.config,
		recordVersion: checkpoint.recordVersion,
		rulesVersion: checkpoint.rulesVersion,
		lastMoveGameTimeMs: checkpoint.lastMoveGameTimeMs,
		pending: [],
	});
	const inherited = f.store.events(fork.id, -1).events;
	expect(inherited.slice(0, -1)).toEqual(
		prefix.map((event) => ({
			...event,
			matchId: fork.id,
			state: { ...event.state, id: fork.id, forkedFrom: fork.forkedFrom },
		})),
	);
	expect(inherited.at(-1)).toMatchObject({
		type: "forked",
		seq: checkpoint.seq + 1,
		data: fork.forkedFrom,
	});
	expect(f.store.request(fork.id, "start")).toBeNull();
	expect(f.store.request(fork.id, "move-1")).toBeNull();
	expect(() => f.service.authorize(fork.id, sourceToken)).toThrow("credential");
	expect(() => f.service.authorize(fork.id, forkToken)).not.toThrow();
	f.time(100000);
	expect(f.start(fork.id).status).toBe("applied");
	const resumed = f.service.decisionContext(fork.id);
	expect(resumed.progress).toEqual(context.progress);
	expect(resumed.progress).toMatchObject({
		historyStartTick: 0,
		throughTick: 16,
		positionVisits: 2,
	});
	expect(f.move("left", fork.id, "move-1").status).toBe("applied");
	expect(f.store.get(fork.id)).toMatchObject({ tick: 17, direction: "left" });
	expect(savedRows(f.store, f.source.id)).toEqual(original);
});

test.each([undefined, 2, 3] as const)(
	"layout %s restores RNG and generates the same next apple after the inherited prefix",
	(layoutVersion) => {
		const f = fixture({ layoutVersion });
		expect(f.source.config.layoutVersion).toBe(layoutVersion ?? 3);
		f.start();
		const initialRng = f.store.get(f.source.id).rngState;
		for (const direction of routeToApple(f.store.get(f.source.id)))
			f.move(direction);
		const checkpoint = f.store.get(f.source.id);
		expect(checkpoint.applesEaten).toBe(1);
		expect(checkpoint.rngState).not.toBe(initialRng);
		const route = routeToApple(checkpoint);
		for (const direction of route)
			expect(f.move(direction).status).toBe("applied");
		const expected = f.store.get(f.source.id);
		const fork = f.fork(checkpoint.seq);
		expect(f.store.get(fork.id).rngState).toBe(checkpoint.rngState);
		f.time(100000);
		f.start(fork.id);
		for (const direction of route)
			expect(f.move(direction, fork.id).status).toBe("applied");
		const actual = f.store.get(fork.id);
		expect(actual).toMatchObject({
			apple: expected.apple,
			rngState: expected.rngState,
			snake: expected.snake,
			score: expected.score,
			applesEaten: 2,
			gameTimeMs: expected.gameTimeMs,
		});
	},
);

test("response start preserves inherited elapsed and last movement time but excludes downtime", () => {
	const f = fixture();
	f.start();
	f.move("right");
	const checkpoint = f.store.get(f.source.id);
	const fork = f.fork();
	f.time(50000);
	f.start(fork.id);
	expect(f.service.elapsed(fork.id)).toBe(100);
	expect(f.service.decisionContext(fork.id).elapsedGameTimeMs).toBe(100);
	f.time(50250);
	const context = f.service.decisionContext(fork.id);
	expect(f.service.command(fork.id, action(context, "down")).status).toBe(
		"applied",
	);
	expect(f.store.get(fork.id)).toMatchObject({
		tick: checkpoint.tick + 1,
		gameTimeMs: 350,
		lastMoveGameTimeMs: 350,
		lastStepDurationMs: 250,
	});
});

test("fork creation is idempotent and changing source, sequence or content conflicts", () => {
	const f = fixture();
	f.start();
	f.move("right");
	const fork = f.fork();
	expect(f.fork()).toEqual(fork);
	expect(f.store.list().matches).toHaveLength(2);
	for (const input of [
		{ ...forkInput(fork.forkedFrom!.seq), sourceSeq: 0 },
		{ ...forkInput(fork.forkedFrom!.seq), model: "other-model" },
		{
			...forkInput(fork.forkedFrom!.seq),
			controlToken: "different-controller".repeat(3),
		},
	])
		expect(() => f.service.fork(f.source.id, input)).toThrow(
			"different content",
		);
	expect(() =>
		f.service.fork("other-source", forkInput(fork.forkedFrom!.seq)),
	).toThrow("different content");
	f.start(fork.id);
	expect(f.fork()).toMatchObject({ id: fork.id, status: "running" });
});

test("fork insertion rolls back match and every prefix event when a write fails", () => {
	const f = fixture();
	f.start();
	f.move("right");
	const original = savedRows(f.store, f.source.id);
	f.store.db.exec(
		"CREATE TRIGGER fail_fork BEFORE INSERT ON match_events WHEN NEW.seq=2 BEGIN SELECT RAISE(ABORT, 'fork insert failed'); END",
	);
	expect(() => f.fork()).toThrow("fork insert failed");
	expect(f.store.list().matches).toHaveLength(1);
	expect(f.store.byCreation("fork-request")).toBeUndefined();
	expect(savedRows(f.store, f.source.id)).toEqual(original);
	f.store.db.exec("DROP TRIGGER fail_fork");
	expect(f.fork().status).toBe("ready");
});

test("invalid sequence, incomplete history and terminal targets reject without creating a match", () => {
	const f = fixture();
	f.start();
	for (const sourceSeq of [-1, 1.5, 9999]) {
		expect(() => f.fork(sourceSeq)).toThrow();
		expect(f.store.byCreation("fork-request")).toBeUndefined();
	}
	while (f.store.get(f.source.id).status === "running") f.move("right");
	expect(() => f.fork()).toThrow();
	expect(f.store.list().matches).toHaveLength(1);
	f.store.db
		.prepare("DELETE FROM match_events WHERE match_id=? AND seq=1")
		.run(f.source.id);
	expect(() => f.fork(2)).toThrow("incomplete");
	expect(f.store.list().matches).toHaveLength(1);
});

test("a fork can be forked again with complete movement history", () => {
	const f = fixture();
	f.start();
	f.move("right");
	const first = f.fork();
	f.time(10000);
	f.start(first.id);
	f.move("down", first.id);
	const checkpoint = f.store.get(first.id);
	const progress = f.service.decisionContext(first.id).progress;
	const second = f.service.fork(
		first.id,
		forkInput(checkpoint.seq, "second-fork"),
	);
	f.time(20000);
	f.start(second.id);
	expect(f.service.decisionContext(second.id).progress).toEqual(progress);
	expect(f.store.get(second.id)).toMatchObject({
		rngState: checkpoint.rngState,
		tick: 2,
		gameTimeMs: 200,
		forkedFrom: { matchId: first.id, seq: checkpoint.seq },
	});
});
