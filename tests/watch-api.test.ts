import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { jevConfig, JEV_PROVIDERS } from "../server/jev/config.js";
import { gameConfig } from "../server/jev/game-config.js";
import { startServer } from "../server/start.js";
import { OwnerSessions } from "../server/watch/owner.js";
import type { WatchSnapshot } from "../shared/snake/watch.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of cleanups.splice(0).reverse()) await dispose();
	vi.unstubAllGlobals();
});
const origin = "http://localhost:3000",
	secret = "owner-test-credential".repeat(3);
async function fixture(twoStep = false) {
	const transport = globalThis.fetch;
	vi.stubGlobal(
		"fetch",
		async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			if (String(input) !== JEV_PROVIDERS.typesafe.endpoint)
				return transport(input, init);
			const body = JSON.parse(init?.body as string),
				key = body.questions.plan ? "plan" : "direction",
				choice = key === "plan" ? "right_right" : "right";
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, 5);
				init?.signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(init.signal?.reason);
					},
					{ once: true },
				);
			});
			return Response.json({
				model: "test-only-watch-transport",
				answers: {
					[key]: {
						type: "choice",
						choice,
						confidence: 1,
						probabilities: Object.fromEntries(
							Object.keys(body.questions[key].criteria).map((k) => [
								k,
								k === choice ? 1 : 0,
							]),
						),
					},
				},
			});
		},
	);
	const game = startServer({
		path: ":memory:",
		port: 0,
		adminToken: secret,
		watch: {
			jev: jevConfig({ TYPESAFE_API_KEY: "not-a-real-provider-key" }),
			makeConfig: () =>
				gameConfig(
					{
						SNAKE_WIDTH: "7",
						SNAKE_HEIGHT: "1",
						SNAKE_OBSTACLES: "0",
						SNAKE_TICK_MS: "50",
					},
					{ "decision-mode": twoStep ? "two_step_fallback" : "single_step" },
				),
			intermissionMs: 60,
		},
	});
	await game.ready;
	const addr = game.server.address();
	if (!addr || typeof addr === "string") throw new Error("No server address");
	cleanups.push(() => game.close());
	const base = `http://127.0.0.1:${addr.port}`;
	const req = (
		path: string,
		method = "GET",
		body?: unknown,
		cookie?: string,
		requestOrigin: string | undefined = origin,
	) =>
		transport(base + path, {
			method,
			headers: {
				...(requestOrigin ? { Origin: requestOrigin } : {}),
				...(cookie ? { Cookie: cookie } : {}),
				...(body !== undefined ? { "Content-Type": "application/json" } : {}),
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
	const login = async () => {
		const response = await req("/api/watch-admin/session", "POST", {
			password: secret,
		});
		expect(response.status).toBe(200);
		const value = response.headers.get("set-cookie");
		expect(value).toContain("HttpOnly");
		expect(value).toContain("SameSite=Strict");
		expect(value).toContain("Path=/api/watch-admin");
		return value!.split(";")[0];
	};
	return { game, base, req, login };
}
async function watcher(base: string) {
	const socket = new WebSocket(
		base.replace("http:", "ws:") + "/ws/watch-channel",
	);
	const messages: {
			type: string;
			state?: WatchSnapshot;
			error?: { code: string };
		}[] = [],
		listeners = new Set<() => void>();
	socket.on("message", (raw) => {
		messages.push(JSON.parse(raw.toString()));
		for (const notify of listeners) notify();
	});
	await once(socket, "open");
	cleanups.push(() => socket.terminate());
	return {
		socket,
		messages,
		wait(predicate: (m: (typeof messages)[number]) => boolean) {
			return new Promise<(typeof messages)[number]>((resolve, reject) => {
				const timer = setTimeout(() => {
					listeners.delete(check);
					reject(new Error("Watch expectation timed out"));
				}, 4000);
				const check = () => {
					const item = messages.find(predicate);
					if (item) {
						clearTimeout(timer);
						listeners.delete(check);
						resolve(item);
					}
				};
				listeners.add(check);
				check();
			});
		},
	};
}

test("hidden parameter grants no rights; same-origin session controls, logout revokes, public data has no credential", async () => {
	const f = await fixture();
	expect(
		(
			await f.req("/api/watch-admin/commands?admin=1", "POST", {
				requestId: "A",
				enabled: true,
			})
		).status,
	).toBe(401);
	expect(
		(await f.req("/api/watch-admin/session", "POST", { password: "wrong" }))
			.status,
	).toBe(401);
	expect(
		(
			await f.req(
				"/api/watch-admin/session",
				"POST",
				{ password: secret },
				undefined,
				"http://evil.test",
			)
		).status,
	).toBe(403);
	const cookie = await f.login();
	expect(
		(
			await f.req(
				"/api/watch-admin/commands",
				"POST",
				{ requestId: "A", enabled: true },
				cookie,
				"http://evil.test",
			)
		).status,
	).toBe(403);
	expect(
		(
			await f.req(
				"/api/watch-admin/commands",
				"POST",
				{ requestId: "A", enabled: true },
				cookie,
				"",
			)
		).status,
	).toBe(403);
	const publicText = await (await f.req("/api/watch-channel")).text();
	expect(publicText).not.toContain(secret);
	expect(publicText).not.toContain(cookie);
	expect(publicText).not.toContain("not-a-real-provider-key");
	expect(
		(await f.req("/api/watch-admin/session", "DELETE", undefined, cookie))
			.status,
	).toBe(200);
	expect(
		(
			await f.req(
				"/api/watch-admin/commands",
				"POST",
				{ requestId: "A", enabled: true },
				cookie,
			)
		).status,
	).toBe(401);
	expect(f.game.store.list().matches).toHaveLength(0);
});

test.each([false, true])(
	"two real watchers follow two engine rounds and graceful stop (twoStep=%s)",
	async (twoStep) => {
		const f = await fixture(twoStep),
			a = await watcher(f.base),
			b = await watcher(f.base),
			cookie = await f.login();
		a.socket.send(JSON.stringify({ type: "stop" }));
		expect((await a.wait((m) => m.type === "error")).error?.code).toBe(
			"read_only",
		);
		const start = { requestId: "start", enabled: true };
		expect(
			(await f.req("/api/watch-admin/commands", "POST", start, cookie)).status,
		).toBe(200);
		const first = (await a.wait((m) => m.state?.phase === "running")).state!
			.currentMatchId;
		expect(
			(await b.wait((m) => m.state?.phase === "running")).state?.currentMatchId,
		).toBe(first);
		await a.wait((m) => m.state?.phase === "countdown");
		const second = (
			await a.wait(
				(m) => m.state?.phase === "running" && m.state.currentMatchId !== first,
			)
		).state!.currentMatchId!;
		expect(
			(
				await b.wait(
					(m) =>
						m.state?.currentMatchId === second && m.state.phase === "running",
				)
			).state?.currentMatchId,
		).toBe(second);
		const stop = await f.req(
			"/api/watch-admin/commands",
			"POST",
			{ requestId: "stop", enabled: false },
			cookie,
		);
		expect((await stop.json()).state).toMatchObject({
			phase: "draining",
			enabled: false,
			currentMatchId: second,
		});
		const replay = await f.req(
			"/api/watch-admin/commands",
			"POST",
			start,
			cookie,
		);
		expect((await replay.json()).state.enabled).toBe(false);
		await a.wait(
			(m) => m.state?.phase === "stopped" && m.state.lastMatchId === second,
		);
		expect(f.game.store.list().matches).toHaveLength(2);
		expect(["gameover", "won"]).toContain(f.game.store.get(second).status);
		const c = await watcher(f.base);
		expect((await c.wait((m) => m.type === "channel")).state).toMatchObject({
			phase: "stopped",
			lastMatchId: second,
		});
		for (const client of [a, b, c]) {
			const revisions = client.messages
				.filter((m) => m.state)
				.map((m) => m.state!.revision);
			expect(revisions).toEqual([...revisions].sort((x, y) => x - y));
		}
	},
);

test.each([false, true])(
	"service shutdown waits for controlled work and preserves intent (twoStep=%s)",
	async (twoStep) => {
		const f = await fixture(twoStep),
			w = await watcher(f.base),
			cookie = await f.login();
		await f.req(
			"/api/watch-admin/commands",
			"POST",
			{ requestId: randomUUID(), enabled: true },
			cookie,
		);
		await w.wait((m) => m.state?.phase === "running");
		await f.game.channel.close();
		expect(f.game.channel.store.read().snapshot.enabled).toBe(true);
		const match = f.game.store.list().matches[0];
		expect(match.status).toBe("interrupted");
		expect(match.endReason).toBe("server_shutdown");
	},
);

test("owner sessions expire, revoke and do not survive a new service instance", () => {
	let now = 0;
	const auth = new OwnerSessions(secret, origin, 100, () => now),
		session = auth.login(secret);
	expect(auth.status(session.token).authenticated).toBe(true);
	now = 100;
	expect(auth.status(session.token).authenticated).toBe(false);
	expect(() => auth.authorize(session.token)).toThrow("解锁");
	const next = auth.login(secret);
	auth.logout(next.token);
	expect(auth.status(next.token).authenticated).toBe(false);
	expect(
		new OwnerSessions(secret, origin).status(auth.login(secret).token)
			.authenticated,
	).toBe(false);
	expect(new OwnerSessions(secret, "https://snake.example").secure).toBe(true);
});
