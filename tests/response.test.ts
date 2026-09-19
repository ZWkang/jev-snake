import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";
import { Store } from "../server/db/store.js";
import { stateHash } from "../server/game/engine.js";
import { MatchService } from "../server/matches/service.js";
import { startServer } from "../server/start.js";
import type {
	DecisionContext,
	Direction,
	MatchEvent,
	PublicState,
	Receipt,
} from "../shared/snake/types.js";
import { publicState } from "../shared/snake/types.js";

const disposers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

function fixture(config: Record<string, unknown> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "snake-response-"));
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
		controlToken: "response-secret".repeat(3),
		agentName: "Response protocol test",
		config: {
			width: 24,
			height: 18,
			obstacleCount: 0,
			seed: "response-test",
			stepMode: "response",
			...config,
		},
	};
	const match = service.create(creation);
	return {
		path,
		store,
		service,
		creation,
		match,
		read: () => store.get(match.id),
		events: () => store.events(match.id, -1).events,
		context: () => service.decisionContext(match.id),
		send: (input: unknown) => service.command(match.id, input),
		start: () =>
			service.command(match.id, {
				protocolVersion: 1,
				requestId: "start",
				type: "start",
			}),
		time: (at: number) => {
			now = at;
		},
		advance: (at: number) => {
			now = at;
			service.advance(match.id);
		},
	};
}

function action(
	context: DecisionContext,
	requestId: string,
	direction: Direction = "right",
) {
	return {
		protocolVersion: 1,
		type: "action",
		requestId,
		observedSeq: context.observedSeq,
		targetTick: context.targetTick,
		expectedStateHash: context.expectedStateHash,
		direction,
	};
}

test("response creation has an explicit v3 format and rejects conflicting modes before inserting", () => {
	const f = fixture();
	expect(f.match).toMatchObject({
		recordVersion: 3,
		rulesVersion: 3,
		config: { stepMode: "response", tickIntervalMs: null },
	});
	const withNull = f.service.create({
		...f.creation,
		requestId: "null-period",
		config: { ...f.creation.config, tickIntervalMs: null },
	});
	expect(withNull.config).toEqual(f.match.config);
	for (const config of [
		{ stepMode: "response", tickIntervalMs: 500 },
		{ stepMode: "response", decisionMode: "two_step_fallback" },
		{ stepMode: "unknown" },
		{ stepMode: "fixed", tickIntervalMs: null },
	]) {
		expect(() =>
			f.service.create({
				...f.creation,
				requestId: "bad-mode",
				config: { ...f.creation.config, ...config },
			}),
		).toThrow();
		expect(f.store.byCreation("bad-mode")).toBeUndefined();
	}
	expect(f.store.list().matches).toHaveLength(2);
});

test("response movements follow actual 120/470/1770ms arrivals, commit before publication and never coast", () => {
	const f = fixture();
	f.start();
	const reader = new Store(f.path);
	disposers.push(() => reader.close());
	const published: { tick: number; receipt: Receipt | undefined }[] = [];
	let requestId = "";
	f.service.subscribe((id) => {
		if (id !== f.match.id) return;
		published.push({
			tick: reader.get(id).tick,
			receipt: reader.request(id, requestId)?.receipt,
		});
	});
	for (const [index, at] of [120, 470, 1770].entries()) {
		const context = f.context();
		expect(context.state).toEqual(publicState(f.read()));
		expect(context.deadlineInMs).toBeNull();
		expect(f.service.timing(f.match.id).nextTickAt).toBeNull();
		f.time(at);
		requestId = `move-${index}`;
		const receipt = f.send(action(context, requestId));
		expect(receipt).toMatchObject({ status: "applied", targetTick: index + 1 });
		expect(published.at(-1)).toMatchObject({ tick: index + 1, receipt });
		expect(f.read().pending).toEqual([]);
	}
	const movements = f
		.events()
		.filter((event) => event.data.actionStatus === "applied");
	expect(movements.map((event) => event.gameTimeMs)).toEqual([120, 470, 1770]);
	expect(movements.map((event) => event.data.stepDurationMs)).toEqual([
		120, 350, 1300,
	]);
	expect(movements.every((event) => !("schedulerLagMs" in event.data))).toBe(
		true,
	);
	expect(f.read().lastStepDurationMs).toBe(1300);
	expect(publicState(f.read())).not.toHaveProperty("lastMoveGameTimeMs");
	const before = f.read();
	f.advance(11770);
	expect(f.read()).toEqual(before);
	const delayed = f.context();
	expect(delayed.elapsedGameTimeMs).toBe(11770);
	expect(delayed.state.gameTimeMs).toBe(1770);
	expect(f.send(action(delayed, "after-long-wait"))).toMatchObject({
		status: "applied",
		targetTick: 4,
	});
	expect(f.read().lastStepDurationMs).toBe(10000);
	expect(reader.events(f.match.id, -1).events).toEqual(f.events());
});

test("response retries are idempotent while competing, retargeted and reverse actions do not move", () => {
	const f = fixture();
	f.start();
	const initial = f.context();
	const first = action(initial, "first", "up");
	f.time(470);
	const receipt = f.send(first);
	const applied = f.read();
	f.time(10000);
	expect(f.send(first)).toEqual(receipt);
	expect(f.read()).toEqual(applied);
	expect(() => f.send({ ...first, direction: "down" })).toThrow(
		"different content",
	);
	expect(f.send({ ...first, requestId: "competitor" }).status).toBe("rejected");
	const current = f.context();
	expect(
		f.send({
			...first,
			requestId: "retarget-old",
			targetTick: current.targetTick,
			expectedStateHash: current.expectedStateHash,
		}).code,
	).toBe("stale_state");
	expect(f.send(action(f.context(), "reverse", "down")).code).toBe(
		"invalid_direction",
	);
	expect(f.read()).toMatchObject({ tick: 1, direction: "up", pending: [] });
	expect(f.read().snake).toEqual(applied.snake);
	expect(
		f.events().filter((event) => event.data.actionStatus === "applied"),
	).toHaveLength(1);
	expect(f.events().every((event, index) => event.seq === index)).toBe(true);
});

test("star expiry precedes a simultaneous response, invalidates its context and does not move the snake", () => {
	const f = fixture();
	const ready = f.read();
	ready.star = { point: { x: 0, y: 0 }, expiresAt: 8000 };
	f.store.commit(ready, []);
	f.start();
	const before = f.context();
	f.time(8000);
	expect(f.send(action(before, "expired")).code).toBe("stale_state");
	expect(f.read()).toMatchObject({ tick: 0, star: null, gameTimeMs: 8000 });
	expect(f.read().snake).toEqual(before.state.snake);
	expect(
		f
			.events()
			.slice(-2)
			.map((event) => event.type),
	).toEqual(["star_expired", "action_rejected"]);
	f.time(9000);
	expect(f.send(action(f.context(), "fresh")).status).toBe("applied");
	expect(f.read()).toMatchObject({ tick: 1, lastStepDurationMs: 9000 });
});

test("a response collision is exactly one committed movement attempt with the real elapsed interval", () => {
	const f = fixture();
	const ready = f.read();
	ready.obstacles = [{ x: ready.snake[0].x + 1, y: ready.snake[0].y }];
	f.store.commit(ready, []);
	f.start();
	const command = action(f.context(), "collision");
	f.time(550);
	expect(f.send(command).status).toBe("applied");
	expect(f.read()).toMatchObject({
		status: "gameover",
		endReason: "obstacle",
		tick: 1,
		gameTimeMs: 550,
		lastStepDurationMs: 550,
	});
	expect(f.events().at(-1)?.data).toMatchObject({
		actionStatus: "applied",
		requestId: "collision",
		stepDurationMs: 550,
	});
	f.advance(10000);
	expect(f.send(command).status).toBe("applied");
	expect(f.read().tick).toBe(1);
});

test("a request write failure rolls back accepted event, movement, state and receipt without a success broadcast", () => {
	const f = fixture();
	f.start();
	const before = f.read();
	const eventsBefore = f.events();
	const command = action(f.context(), "will-fail");
	const published: string[] = [];
	f.service.subscribe((id) => published.push(id));
	f.store.db.exec(
		"CREATE TRIGGER fail_response BEFORE INSERT ON control_requests WHEN NEW.request_id='will-fail' BEGIN SELECT RAISE(ABORT, 'response commit failed'); END",
	);
	f.time(470);
	expect(() => f.send(command)).toThrow("response commit failed");
	expect(f.read()).toEqual(before);
	expect(f.events()).toEqual(eventsBefore);
	expect(f.store.request(f.match.id, command.requestId)).toBeNull();
	expect(published).not.toContain(f.match.id);
	expect(f.service.fault).toBe("response commit failed");
});

test("controlled stop includes waiting time but process restart preserves only the last persisted time", () => {
	const stopped = fixture();
	stopped.start();
	stopped.time(2345);
	stopped.send({ protocolVersion: 1, requestId: "stop", type: "stop" });
	expect(stopped.read()).toMatchObject({
		status: "interrupted",
		gameTimeMs: 2345,
		tick: 0,
	});
	const f = fixture();
	f.start();
	f.time(120);
	const command = action(f.context(), "move");
	f.send(command);
	const committed = f.read();
	f.time(5000);
	f.service.close();
	const restarted = new MatchService(f.store, () => 60000, false);
	disposers.push(() => restarted.close());
	expect(f.read()).toMatchObject({
		status: "interrupted",
		endReason: "server_restart",
		tick: 1,
		gameTimeMs: 120,
		pending: [],
	});
	expect(f.read().snake).toEqual(committed.snake);
	expect(restarted.command(f.match.id, command).status).toBe("applied");
	expect(f.read().tick).toBe(1);
});

test("rejected responses preserve receipt time after stop and do not invent reaction time for an unknown observation", () => {
	const f = fixture();
	f.start();
	const context = f.context();
	f.time(500);
	f.send({ protocolVersion: 1, requestId: "stop", type: "stop" });
	f.time(1200);
	expect(f.send(action(context, "after-stop")).code).toBe("not_running");
	const rejected = f.events().at(-1);
	expect(rejected).toMatchObject({
		type: "action_rejected",
		gameTimeMs: 500,
		data: {
			receivedGameTimeMs: 1200,
			reactionMs: 1200,
		},
	});
	expect(Number.isFinite(Date.parse(rejected?.data.receivedAt as string))).toBe(
		true,
	);
	f.send({
		...action(context, "unknown-observation"),
		observedSeq: 999,
	});
	expect(f.events().at(-1)?.data).toMatchObject({
		receivedGameTimeMs: 1200,
		reactionMs: null,
	});
	expect(f.read()).toMatchObject({ tick: 0, gameTimeMs: 500 });
});

test.each([
	{
		decisionMode: undefined,
		version: 1,
		createHash:
			"84726af7aae341ab50126472a335f7ecf5a9fb5731d31d53dcf41d3de8915156",
		stateDigest:
			"d1048ef1c6112baa924fbfc6096de18eeba8d0ae069c8c40045937a6764edee6",
	},
	{
		decisionMode: "two_step_fallback",
		version: 2,
		createHash:
			"fc80a645d8a0addbc792994c66afd1b8837400adf144f9cfb0f6502dcb519e34",
		stateDigest:
			"06c82f16925351bf7015e4981d38261dbfe5430418b7330579c7a0e0fedcb70b",
	},
])(
	"legacy v$version creation and state digests remain unchanged alongside response records",
	(legacy) => {
		const f = fixture();
		const input = {
			requestId: `legacy-${legacy.decisionMode ?? "single"}`,
			controlToken: "legacy-token".repeat(3),
			agentName: "Legacy fixture",
			config: {
				decisionMode: legacy.decisionMode,
				width: 24,
				height: 18,
				obstacleCount: 0,
				tickIntervalMs: 500,
				seed: "response-legacy",
			},
		};
		const created = f.service.create(input);
		expect(created.recordVersion).toBe(legacy.version);
		expect(f.store.byCreation(input.requestId)?.create_hash).toBe(
			legacy.createHash,
		);
		expect(stateHash(f.store.get(created.id))).toBe(legacy.stateDigest);
		const original = f.store.db
			.prepare("SELECT state_json FROM matches WHERE id=?")
			.get(created.id);
		expect(f.service.create(input)).toEqual(created);
		expect(f.store.events(created.id, -1).events[0].state).toEqual(created);
		expect(f.store.list().matches).toHaveLength(2);
		expect(
			f.store.db
				.prepare("SELECT state_json FROM matches WHERE id=?")
				.get(created.id),
		).toEqual(original);
	},
);

test("stored unknown modes and unrecognized record versions fail explicitly", () => {
	const f = fixture();
	const original = f.read();
	for (const state of [
		{ ...original, config: { ...original.config, stepMode: "unknown" } },
		{ ...original, recordVersion: 99, rulesVersion: 99 },
	]) {
		f.store.db
			.prepare("UPDATE matches SET state_json=? WHERE id=?")
			.run(JSON.stringify(state), f.match.id);
		expect(() => f.read()).toThrow("Unsupported");
	}
});

type Message = {
	type: string;
	event?: MatchEvent;
	receipt?: Receipt;
};

async function connect(url: string, token?: string) {
	const socket = new WebSocket(
		url,
		token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
	);
	const messages: Message[] = [];
	const notifications = new Set<() => void>();
	socket.on("message", (raw) => {
		messages.push(JSON.parse(raw.toString()) as Message);
		for (const notify of notifications) notify();
	});
	await once(socket, "open");
	disposers.push(() => socket.terminate());
	return {
		socket,
		waitFor(predicate: (message: Message) => boolean) {
			return new Promise<Message>((resolve, reject) => {
				const timeout = setTimeout(() => {
					notifications.delete(check);
					reject(new Error("Response WebSocket expectation timed out"));
				}, 3000);
				const check = () => {
					const message = messages.find(predicate);
					if (!message) return;
					clearTimeout(timeout);
					notifications.delete(check);
					resolve(message);
				};
				notifications.add(check);
				check();
			});
		},
	};
}

test("real HTTP/WS response mode expires rewards during silence and persists immediate moves before ack", async () => {
	const dir = mkdtempSync(join(tmpdir(), "snake-response-ws-"));
	const token = "response-controller".repeat(3);
	const adminToken = "response-admin".repeat(3);
	const game = startServer({
		path: join(dir, "game.sqlite"),
		adminToken,
		port: 0,
	});
	disposers.push(async () => {
		await game.close();
		rmSync(dir, { recursive: true, force: true });
	});
	if (!game.server.listening) await once(game.server, "listening");
	const address = game.server.address();
	if (!address || typeof address === "string")
		throw new Error("No listening address");
	const base = `http://127.0.0.1:${address.port}`;
	const response = await fetch(`${base}/api/matches`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${adminToken}`,
		},
		body: JSON.stringify({
			requestId: "response-create",
			controlToken: token,
			agentName: "Response WS test",
			config: { stepMode: "response", obstacleCount: 0, seed: "response-ws" },
		}),
	});
	expect(response.status).toBe(201);
	const created = (await response.json()) as PublicState;
	const seeded = game.store.get(created.id);
	seeded.star = { point: { x: 0, y: 0 }, expiresAt: 80 };
	game.store.commit(seeded, []);
	const wsBase = `${base.replace("http", "ws")}/ws/matches/${created.id}`;
	const watcher = await connect(`${wsBase}/watch`);
	watcher.socket.send(JSON.stringify({ type: "subscribe", afterSeq: -1 }));
	const controller = await connect(`${wsBase}/control`, token);
	controller.socket.send(
		JSON.stringify({ protocolVersion: 1, requestId: "start", type: "start" }),
	);
	await controller.waitFor((message) => message.receipt?.requestId === "start");
	controller.socket.close();
	await once(controller.socket, "close");
	await watcher.waitFor((message) => message.event?.type === "star_expired");
	await new Promise((resolve) => setTimeout(resolve, 350));
	expect(game.store.get(created.id)).toMatchObject({
		status: "running",
		tick: 0,
		star: null,
	});
	const context = (await (
		await fetch(`${base}/api/matches/${created.id}/decision-context`, {
			headers: { Authorization: `Bearer ${token}` },
		})
	).json()) as DecisionContext;
	expect(context.deadlineInMs).toBeNull();
	expect(context.elapsedGameTimeMs).toBeGreaterThanOrEqual(400);
	const resumed = await connect(`${wsBase}/control`, token);
	const command = action(context, "ws-move", "up");
	resumed.socket.send(JSON.stringify(command));
	const ack = await resumed.waitFor(
		(message) => message.receipt?.requestId === command.requestId,
	);
	expect(ack.receipt?.status).toBe("applied");
	expect(game.store.request(created.id, command.requestId)?.receipt).toEqual(
		ack.receipt,
	);
	expect(game.store.get(created.id)).toMatchObject({
		tick: 1,
		direction: "up",
	});
	const moved = await watcher.waitFor(
		(message) => message.event?.data.actionStatus === "applied",
	);
	expect(moved.event?.state).toEqual(publicState(game.store.get(created.id)));
	expect(moved.event?.data.stepDurationMs).toBeGreaterThanOrEqual(400);
	resumed.socket.send(JSON.stringify(command));
	resumed.socket.close();
	await once(resumed.socket, "close");
	await new Promise((resolve) => setTimeout(resolve, 350));
	expect(game.store.get(created.id).tick).toBe(1);
	expect(
		game.store
			.events(created.id, -1)
			.events.every((event, i) => event.seq === i),
	).toBe(true);
});
