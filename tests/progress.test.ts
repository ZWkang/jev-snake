import { afterEach, expect, test, vi } from "vitest";
import { Store } from "../server/db/store.js";
import { createState, move, stateHash } from "../server/game/engine.js";
import {
	ProgressHistory,
	progressPositionKey,
} from "../server/jev/progress.js";
import { MatchService } from "../server/matches/service.js";
import {
	type DecisionContext,
	type Direction,
	type PublicState,
	publicState,
} from "../shared/snake/types.js";
import replay from "./fixtures/loop-replay.json" with { type: "json" };

const disposers: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposers.splice(0).reverse()) dispose();
});

function loopState() {
	const state = createState(
		"loop",
		"History test",
		null,
		{
			stepMode: "response",
			tickIntervalMs: null,
			width: 7,
			height: 5,
			obstacleCount: 0,
			seed: "progress-test",
		},
		"now",
	);
	state.status = "running";
	state.snake = [
		{ x: 3, y: 1 },
		{ x: 2, y: 1 },
		{ x: 1, y: 1 },
		{ x: 1, y: 2 },
	];
	state.apple = { x: 5, y: 4 };
	return state;
}

const circuit: Direction[] = [
	"down",
	"down",
	"left",
	"left",
	"up",
	"up",
	"right",
	"right",
];

test("the actual 24-move replay exposes the direction that repeatedly returned without an apple", () => {
	const history = new ProgressHistory();
	const states = replay.states as PublicState[];
	for (const state of states.slice(0, 144)) history.observe(state);
	expect(history.snapshot(states[143])).toMatchObject({
		historyVersion: "progress-v1",
		historyStartTick: 0,
		throughTick: 143,
		lastAppleTick: 103,
		movesSinceApple: 40,
		positionVisits: 2,
		previousVisitTick: 119,
		repeatAfterMoves: 24,
		actions: {
			right: { timesTaken: 1, returnsWithoutApple: 1, lastTakenTick: 120 },
			up: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
		},
	});
	for (const state of states.slice(144)) history.observe(state);
	expect(history.snapshot(states[167])).toMatchObject({
		movesSinceApple: 64,
		positionVisits: 3,
		previousVisitTick: 143,
		repeatAfterMoves: 24,
		actions: {
			right: { timesTaken: 2, returnsWithoutApple: 2, lastTakenTick: 144 },
		},
	});
});

test("same-tick accepted, rejected and repeated observations do not invent movements or visits", () => {
	const history = new ProgressHistory();
	const state = loopState();
	history.observe(state);
	for (const direction of circuit) {
		move(state, direction);
		history.observe(state);
	}
	const before = history.snapshot(state);
	for (let i = 0; i < 5; i++) {
		state.seq++;
		state.gameTimeMs += 500;
		history.observe(state);
	}
	expect(history.snapshot(state)).toEqual(before);
	expect(before).toMatchObject({
		movesSinceApple: 8,
		positionVisits: 2,
		previousVisitTick: 0,
		repeatAfterMoves: 8,
		actions: {
			down: { timesTaken: 1, returnsWithoutApple: 1, lastTakenTick: 1 },
		},
	});
	before.actions.down.timesTaken = 100;
	expect(history.snapshot(state).actions.down.timesTaken).toBe(1);
});

test("growth resets the no-apple phase while eating a star does not reset real progress", () => {
	const history = new ProgressHistory();
	const state = loopState();
	state.star = { point: { x: 3, y: 2 }, expiresAt: 8000 };
	state.apple = { x: 3, y: 3 };
	history.observe(state);
	expect(move(state, "down").type).toBe("star");
	history.observe(state);
	expect(history.snapshot(state)).toMatchObject({
		lastAppleTick: 0,
		movesSinceApple: 1,
	});
	expect(move(state, "down").type).toBe("apple");
	history.observe(state);
	expect(history.snapshot(state)).toMatchObject({
		lastAppleTick: 2,
		movesSinceApple: 0,
		positionVisits: 1,
		previousVisitTick: null,
		repeatAfterMoves: null,
	});
	expect(
		Object.values(history.snapshot(state).actions).every(
			(action) =>
				action.timesTaken === 0 &&
				action.returnsWithoutApple === 0 &&
				action.lastTakenTick === null,
		),
	).toBe(true);
});

test("position identity retains ordered body, facing, rewards and board but ignores clocks and score", () => {
	const state = publicState(loopState());
	state.star = { point: { x: 6, y: 4 }, expiresAt: 8000 };
	const original = progressPositionKey(state);
	const changes: ((s: PublicState) => void)[] = [
		(s) => {
			[s.snake[1], s.snake[2]] = [s.snake[2], s.snake[1]];
		},
		(s) => {
			s.direction = "up";
		},
		(s) => {
			s.apple = { x: 4, y: 4 };
		},
		(s) => {
			s.star = null;
		},
		(s) => {
			if (s.star) s.star.point = { x: 6, y: 3 };
		},
		(s) => {
			s.config.width++;
		},
		(s) => {
			s.config.height++;
		},
		(s) => {
			s.obstacles.push({ x: 5, y: 1 });
		},
	];
	for (const change of changes) {
		const changed = structuredClone(state);
		change(changed);
		expect(progressPositionKey(changed)).not.toBe(original);
	}
	state.tick += 100;
	state.gameTimeMs += 1234;
	state.score += 30;
	state.star.expiresAt += 1234;
	expect(progressPositionKey(state)).toBe(original);
});

test("same-tick star expiry updates position identity without counting a move or departure", () => {
	const history = new ProgressHistory();
	const state = loopState();
	state.star = { point: { x: 6, y: 4 }, expiresAt: 8000 };
	history.observe(state);
	state.star = null;
	history.observe(state);
	expect(history.snapshot(state)).toMatchObject({
		throughTick: 0,
		movesSinceApple: 0,
		positionVisits: 1,
	});
	expect(
		Object.values(history.snapshot(state).actions).every(
			(a) => a.timesTaken === 0,
		),
	).toBe(true);
	move(state, "down");
	history.observe(state);
	expect(history.snapshot(state).movesSinceApple).toBe(1);
});

test("incomplete histories and stale snapshots fail explicitly", () => {
	const state = loopState();
	const history = new ProgressHistory();
	expect(() => history.snapshot(state)).toThrow("does not match");
	expect(() => history.observe({ ...state, tick: 1 })).toThrow(
		"begin at tick 0",
	);
	history.observe(state);
	expect(() => history.observe({ ...state, tick: 2 })).toThrow("incomplete");
	const initial = publicState(state);
	move(state, "down");
	history.observe(state);
	expect(() => history.observe(initial)).toThrow("incomplete");
	expect(() => history.snapshot(initial)).toThrow("does not match");
	expect(() => history.snapshot({ ...state, direction: "left" })).toThrow(
		"does not match",
	);
});

function serviceFixture() {
	const store = new Store(":memory:");
	const service = new MatchService(store, () => 0, false);
	disposers.push(() => {
		service.close();
		store.close();
	});
	const initial = service.create({
		requestId: "create",
		controlToken: "history-control-token".repeat(3),
		agentName: "History cache test",
		config: {
			stepMode: "response",
			width: 7,
			height: 5,
			obstacleCount: 0,
			seed: "progress-test",
		},
	});
	const ready = store.get(initial.id);
	const geometry = loopState();
	ready.snake = geometry.snake;
	ready.direction = geometry.direction;
	ready.apple = geometry.apple;
	store.commit(ready, []);
	service.command(initial.id, {
		protocolVersion: 1,
		requestId: "start",
		type: "start",
	});
	return { store, service, id: initial.id };
}

function command(
	context: DecisionContext,
	direction: Direction,
	requestId: string,
) {
	return {
		protocolVersion: 1,
		type: "action",
		requestId,
		direction,
		observedSeq: context.observedSeq,
		targetTick: context.targetTick,
		expectedStateHash: context.expectedStateHash,
	};
}

test("service history pages committed events once and reuses the cursor for unchanged observations", () => {
	const { store, service, id } = serviceFixture();
	// Build a long history without requesting context, as a newly attached runner would.
	for (let tick = 0; tick < 112; tick++) {
		const state = store.get(id);
		expect(
			service.command(id, {
				protocolVersion: 1,
				type: "action",
				requestId: `move-${tick}`,
				observedSeq: state.seq,
				targetTick: state.tick + 1,
				expectedStateHash: stateHash(state),
				direction: circuit[tick % circuit.length],
			}).status,
		).toBe("applied");
	}
	const events = vi.spyOn(store, "events");
	const context = service.decisionContext(id);
	expect(events.mock.calls).toEqual([
		[id, -1, 200],
		[id, 199, 26],
	]);
	expect(context.progress).toMatchObject({
		throughTick: 112,
		movesSinceApple: 112,
		positionVisits: 15,
		previousVisitTick: 104,
		repeatAfterMoves: 8,
		actions: {
			down: { timesTaken: 14, returnsWithoutApple: 14, lastTakenTick: 105 },
		},
	});
	events.mockClear();
	expect(service.decisionContext(id).progress).toEqual(context.progress);
	expect(events).not.toHaveBeenCalled();
	service.command(id, command(context, "down", "next"));
	events.mockClear();
	expect(service.decisionContext(id).progress).toMatchObject({
		throughTick: 113,
		movesSinceApple: 113,
	});
	expect(events.mock.calls).toEqual([[id, 225, 2]]);
});

test("same-tick service rejections preserve history and terminal commits release its cache", () => {
	const { store, service, id } = serviceFixture();
	const before = service.decisionContext(id);
	expect(service.command(id, command(before, "left", "reverse")).status).toBe(
		"rejected",
	);
	expect(service.decisionContext(id).progress).toEqual(before.progress);
	service.command(
		id,
		command(service.decisionContext(id), "down", "actual-move"),
	);
	const after = service.decisionContext(id);
	expect(after.progress.movesSinceApple).toBe(1);
	expect(service.command(id, command(before, "down", "stale")).status).toBe(
		"rejected",
	);
	expect(service.decisionContext(id).progress).toEqual(after.progress);
	const cache = (service as unknown as { progress: Map<string, unknown> })
		.progress;
	expect(cache.has(id)).toBe(true);
	service.command(id, { protocolVersion: 1, requestId: "stop", type: "stop" });
	expect(store.get(id).status).toBe("interrupted");
	expect(cache.has(id)).toBe(false);
});

test("an observed historical sequence never reads future events and rejects a cursor rewind", () => {
	const { store, service, id } = serviceFixture();
	const before = service.decisionContext(id);
	service.command(id, command(before, "down", "move"));
	const getProgress = (
		service as unknown as {
			getProgress: (id: string, seq: number) => ProgressHistory;
		}
	).getProgress.bind(service);
	const events = vi.spyOn(store, "events");
	const acceptedSeq = before.observedSeq + 1;
	const accepted = store.events(id, before.observedSeq, 1).events[0].state;
	events.mockClear();
	expect(getProgress(id, acceptedSeq).snapshot(accepted).throughTick).toBe(0);
	expect(events.mock.calls).toEqual([[id, before.observedSeq, 1]]);
	expect(service.decisionContext(id).progress.throughTick).toBe(1);
	expect(() => getProgress(id, acceptedSeq)).toThrow(
		"ahead of the observed sequence",
	);
});

test("coast and fallback movements contribute actual departures regardless of model decisions", () => {
	const history = new ProgressHistory();
	const state = loopState();
	history.observe(state);
	for (const [index, direction] of [...circuit, ...circuit].entries()) {
		move(state, direction);
		state.lastAppliedAction = {
			source: index < circuit.length ? "coast" : "fallback",
			direction,
			tick: state.tick,
			targetTick: state.tick,
		};
		history.observe(state);
	}
	expect(history.snapshot(state).actions.down).toEqual({
		timesTaken: 2,
		returnsWithoutApple: 2,
		lastTakenTick: 9,
	});
});
