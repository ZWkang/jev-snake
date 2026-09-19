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
test("real HTTP + WS: visitor read-only, clocks independent, reconnect recovers exact sequence", async () => {
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
			tickIntervalMs: 60,
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
	const movement = await watcher.waitFor(
		(m) => m.type === "event" && (m.event?.tick ?? 0) >= 2,
	);
	const cursor = movement.event?.seq as number;
	watcher.socket.close();
	controller.socket.close();
	await new Promise((resolve) => setTimeout(resolve, 140));
	const reconnected = await connect(`${wsBase}/watch`);
	reconnected.socket.send(
		JSON.stringify({ type: "subscribe", afterSeq: cursor }),
	);
	const first = await reconnected.waitFor((m) => m.type === "event");
	expect(first.event?.seq).toBe(cursor + 1);
	expect(game.store.get(state.id).tick).toBeGreaterThanOrEqual(4);
	const collected = (await (
		await fetch(`${base}/api/matches/${state.id}/events?afterSeq=-1`)
	).json()) as { events: MatchEvent[] };
	expect(collected.events.every((e, i) => e.seq === i)).toBe(true);
	expect(collected.events.at(-1)?.state.tick).toBe(
		game.store.get(state.id).tick,
	);
});

test("v2 plans require control auth, persist before acknowledgment and replay ordered fallback events", async () => {
	const { makePlan } = await import("./plan-fixture.js");
	const dir = mkdtempSync(join(tmpdir(), "snake-v2-ws-"));
	const token = "v2-control-secret".repeat(3);
	const adminToken = "v2-admin-secret".repeat(3);
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
	if (!address || typeof address === "string") throw new Error("No address");
	const base = `http://127.0.0.1:${address.port}`;
	const health = await (await fetch(`${base}/api/health`)).json();
	expect(health.supportedProtocolVersions).toEqual([1, 2]);
	const response = await fetch(`${base}/api/matches`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${adminToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			requestId: "v2-create",
			controlToken: token,
			agentName: "V2 test only",
			config: {
				width: 24,
				height: 18,
				obstacleCount: 0,
				tickIntervalMs: 500,
				seed: "v2",
				decisionMode: "two_step_fallback",
			},
		}),
	});
	expect(response.status).toBe(201);
	const state = await response.json();
	const wsBase = `${base.replace("http", "ws")}/ws/matches/${state.id}`;
	const unauthorized = new WebSocket(`${wsBase}/control`);
	const [req, denied] = await once(unauthorized, "unexpected-response");
	expect(denied.statusCode).toBe(401);
	req.destroy();
	const controller = await connect(`${wsBase}/control`, token);
	controller.socket.send(
		JSON.stringify({
			protocolVersion: 2,
			type: "start",
			requestId: "v2-start",
		}),
	);
	await controller.waitFor((m) => m.type === "ack");
	const contextResponse = await fetch(
		`${base}/api/matches/${state.id}/decision-context`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	const plan = makePlan(await contextResponse.json());
	const watcher = await connect(`${wsBase}/watch`);
	watcher.socket.send(JSON.stringify(plan));
	expect((await watcher.waitFor((m) => m.type === "error")).error?.code).toBe(
		"readonly",
	);
	watcher.socket.send(JSON.stringify({ type: "subscribe", afterSeq: -1 }));
	controller.socket.send(JSON.stringify(plan));
	await controller.waitFor(
		(m) => m.type === "ack" && m.receipt?.status === "accepted",
	);
	expect(
		game.store.request(state.id, plan.requestId)?.receipt.steps?.[1].status,
	).toBe("standby");
	const applied = await watcher.waitFor(
		(m) => m.event?.state.lastAppliedAction?.source === "fallback",
	);
	const cursor = applied.event?.seq as number;
	watcher.socket.close();
	controller.socket.send(
		JSON.stringify({ protocolVersion: 2, type: "stop", requestId: "v2-stop" }),
	);
	await controller.waitFor((m) => m.event?.type === "interrupted");
	const reconnect = await connect(`${wsBase}/watch`);
	reconnect.socket.send(
		JSON.stringify({ type: "subscribe", afterSeq: cursor }),
	);
	expect((await reconnect.waitFor((m) => m.type === "event")).event?.seq).toBe(
		cursor + 1,
	);
	const rows = game.store.events(state.id, -1).events;
	expect(rows.every((e, i) => e.seq === i)).toBe(true);
	const publicText = JSON.stringify(rows);
	for (const secret of [
		token,
		adminToken,
		"Authorization",
		"control_hash",
		'"plans":',
		"rngState",
	])
		expect(publicText).not.toContain(secret);
	expect(
		game.store
			.request(state.id, plan.requestId)
			?.receipt.steps?.map((s) => s.status),
	).toEqual(["applied", "applied"]);
});
