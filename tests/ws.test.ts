import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";
import { startServer } from "../server/start.js";
import type { MatchEvent } from "../shared/snake/types.js";

type Message = {
	type: string;
	event?: MatchEvent;
	receipt?: { status: string };
	error?: { code: string };
};
const disposers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});
async function connect(url: string, token?: string) {
	const socket = new WebSocket(
		url,
		token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
	);
	const messages: Message[] = [];
	const notifications = new Set<() => void>();
	socket.on("message", (raw) => {
		messages.push(JSON.parse(raw.toString()) as Message);
		for (const n of notifications) n();
	});
	await once(socket, "open");
	disposers.push(() => {
		socket.terminate();
	});
	return {
		socket,
		messages,
		waitFor(predicate: (message: Message) => boolean) {
			return new Promise<Message>((resolve, reject) => {
				const timeout = setTimeout(() => {
					notifications.delete(check);
					reject(new Error("WebSocket expectation timed out"));
				}, 3000);
				const check = () => {
					const message = messages.find(predicate);
					if (message) {
						clearTimeout(timeout);
						notifications.delete(check);
						resolve(message);
					}
				};
				notifications.add(check);
				check();
			});
		},
	};
}
test("real HTTP + WS: visitor read-only, waiting never moves, reconnect recovers exact sequence", async () => {
	const dir = mkdtempSync(join(tmpdir(), "snake-ws-"));
	const adminToken = "admin".repeat(8);
	const token = "controller".repeat(5);
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
	const body = {
		requestId: "create",
		controlToken: token,
		agentName: "Protocol verification",
		config: {
			width: 24,
			height: 18,
			obstacleCount: 0,
			stepMode: "response",
			seed: "ws",
		},
	};
	const denied = await fetch(`${base}/api/matches`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(denied.status).toBe(401);
	const created = await fetch(`${base}/api/matches`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${adminToken}`,
		},
		body: JSON.stringify(body),
	});
	const state = (await created.json()) as { id: string };
	const publicResponse = await (
		await fetch(`${base}/api/matches/${state.id}`)
	).text();
	expect(publicResponse).not.toContain(token);
	expect(publicResponse).not.toContain("control_hash");
	expect(publicResponse).not.toContain("rngState");
	const wsBase = `${base.replace("http", "ws")}/ws/matches/${state.id}`;
	const watcher = await connect(`${wsBase}/watch`);
	watcher.socket.send(JSON.stringify({ type: "action", direction: "up" }));
	expect((await watcher.waitFor((m) => m.type === "error")).error?.code).toBe(
		"readonly",
	);
	watcher.socket.send(JSON.stringify({ type: "subscribe", afterSeq: -1 }));
	const controller = await connect(`${wsBase}/control`, token);
	controller.socket.send(
		JSON.stringify({ protocolVersion: 1, requestId: "start", type: "start" }),
	);
	expect(
		(await controller.waitFor((m) => m.type === "ack")).receipt?.status,
	).toBe("applied");
	for (let i = 0; i < 2; i++) {
		const c = game.service.decisionContext(state.id);
		game.service.command(state.id, {
			protocolVersion: 1,
			type: "action",
			requestId: `move-${i}`,
			observedSeq: c.observedSeq,
			targetTick: c.targetTick,
			expectedStateHash: c.expectedStateHash,
			direction: "right",
		});
	}
	const movement = await watcher.waitFor(
		(m) => m.type === "event" && (m.event?.tick ?? 0) >= 2,
	);
	const cursor = movement.event?.seq as number;
	watcher.socket.close();
	controller.socket.close();
	await new Promise((resolve) => setTimeout(resolve, 140));
	expect(game.store.get(state.id).tick).toBe(2);
	const c = game.service.decisionContext(state.id);
	game.service.command(state.id, {
		protocolVersion: 1,
		type: "action",
		requestId: "move-after-disconnect",
		observedSeq: c.observedSeq,
		targetTick: c.targetTick,
		expectedStateHash: c.expectedStateHash,
		direction: "right",
	});
	const reconnected = await connect(`${wsBase}/watch`);
	reconnected.socket.send(
		JSON.stringify({ type: "subscribe", afterSeq: cursor }),
	);
	const first = await reconnected.waitFor((m) => m.type === "event");
	expect(first.event?.seq).toBe(cursor + 1);
	expect(game.store.get(state.id).tick).toBe(3);
	const collected = (await (
		await fetch(`${base}/api/matches/${state.id}/events?afterSeq=-1`)
	).json()) as { events: MatchEvent[] };
	expect(collected.events.every((e, i) => e.seq === i)).toBe(true);
	expect(collected.events.at(-1)?.state.tick).toBe(
		game.store.get(state.id).tick,
	);
});

test("health declares only v1 and authenticated v2 commands cannot execute", async () => {
	const game = startServer({
		path: ":memory:",
		adminToken: "a".repeat(32),
		port: 0,
	});
	disposers.push(() => game.close());
	await game.ready;
	const address = game.server.address();
	if (!address || typeof address === "string") throw new Error("No address");
	const base = `http://127.0.0.1:${address.port}`;
	expect(
		(await (await fetch(`${base}/api/health`)).json())
			.supportedProtocolVersions,
	).toEqual([1]);
	const token = "response-control-".repeat(3);
	const created = game.service.create({
		requestId: "create",
		controlToken: token,
		agentName: "Protocol test",
		config: { seed: "ws-retirement", obstacleCount: 0 },
	});
	const wsBase = `${base.replace("http", "ws")}/ws/matches/${created.id}`;
	const unauthorized = new WebSocket(`${wsBase}/control`);
	const [, denied] = await once(unauthorized, "unexpected-response");
	expect(denied.statusCode).toBe(401);
	unauthorized.terminate();
	const controller = await connect(`${wsBase}/control`, token);
	controller.socket.send(
		JSON.stringify({ protocolVersion: 2, type: "start", requestId: "retired" }),
	);
	expect(
		(await controller.waitFor((m) => m.type === "error")).error?.code,
	).toBe("unsupported_protocol");
	expect(game.store.get(created.id)).toMatchObject({
		tick: 0,
		status: "ready",
	});
});
