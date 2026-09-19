import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Store } from "../server/db/store.js";
import { jevConfig } from "../server/jev/config.js";
import { gameConfig } from "../server/jev/game-config.js";
import type { RunJevOptions } from "../server/jev/runner.js";
import { MatchService } from "../server/matches/service.js";
import { WatchChannel } from "../server/watch/channel.js";
import { WatchStore } from "../server/watch/store.js";
import { publicState, type PublicState } from "../shared/snake/types.js";
import type { WatchSnapshot } from "../shared/snake/watch.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const f of cleanup.splice(0).reverse()) await f();
	vi.useRealTimers();
});
const config = () =>
	gameConfig(
		{
			SNAKE_WIDTH: "7",
			SNAKE_HEIGHT: "1",
			SNAKE_OBSTACLES: "0",
			SNAKE_TICK_MS: "10",
		},
		{ "decision-mode": "single_step" },
	);
function fixture(path = ":memory:", key = "test-model-key") {
	vi.useFakeTimers();
	const store = new Store(path),
		service = new MatchService(store, Date.now, false);
	const jobs: {
		options: RunJevOptions;
		resolve: (s: PublicState) => void;
		reject: (e: Error) => void;
		aborts: number;
	}[] = [];
	const channel = new WatchChannel(service, {
		jev: jevConfig({ TYPESAFE_API_KEY: key }),
		makeConfig: config,
		intermissionMs: 5000,
		run: (options) =>
			new Promise((resolve, reject) => {
				const job = { options, resolve, reject, aborts: 0 };
				jobs.push(job);
				options.signal?.addEventListener(
					"abort",
					() => {
						job.aborts++;
						resolve(publicState(store.get(options.state.id)));
					},
					{ once: true },
				);
			}),
	});
	channel.activate("http://test.invalid");
	cleanup.push(async () => {
		await channel.close();
		service.close();
		store.close();
	});
	const command = (enabled: boolean, id = randomUUID()) =>
		channel.command({ requestId: id, enabled });
	const start = (i = jobs.length - 1) => {
		const id = jobs[i].options.state.id;
		expect(
			service.command(id, {
				protocolVersion: 1,
				requestId: randomUUID(),
				type: "start",
			}).status,
		).toBe("applied");
		return id;
	};
	const finish = async (i = jobs.length - 1) => {
		await vi.advanceTimersByTimeAsync(100);
		const id = jobs[i].options.state.id;
		service.advance(id);
		const s = publicState(store.get(id));
		expect(["won", "gameover"]).toContain(s.status);
		jobs[i].resolve(s);
		await vi.advanceTimersByTimeAsync(0);
		return id;
	};
	return { store, service, channel, jobs, command, start, finish };
}

test("owner intent runs two actual engine rounds without viewers, then drains without aborting", async () => {
	const f = fixture();
	expect(f.channel.snapshot().phase).toBe("stopped");
	expect(f.store.list().matches).toHaveLength(0);
	f.command(true);
	await vi.advanceTimersByTimeAsync(0);
	const first = f.start();
	await f.finish();
	expect(f.channel.snapshot()).toMatchObject({
		phase: "countdown",
		lastMatchId: first,
	});
	await vi.advanceTimersByTimeAsync(4999);
	expect(f.jobs).toHaveLength(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(f.jobs).toHaveLength(2);
	const second = f.start();
	expect(second).not.toBe(first);
	expect(f.jobs.map((job) => job.options.state.config.layoutVersion)).toEqual([
		2, 2,
	]);
	expect(f.jobs[1].options.state.config.seed).not.toBe(
		f.jobs[0].options.state.config.seed,
	);
	f.command(false);
	expect(f.channel.snapshot()).toMatchObject({
		enabled: false,
		phase: "draining",
		currentMatchId: second,
	});
	expect(f.jobs[1].aborts).toBe(0);
	expect(f.store.get(second).status).toBe("running");
	await f.finish();
	expect(f.channel.snapshot().phase).toBe("stopped");
	await vi.advanceTimersByTimeAsync(20000);
	expect(f.jobs).toHaveLength(2);
});

test("commands are durable and idempotent, including replaying an old enable after stop", async () => {
	const f = fixture();
	const enabled = f.command(true, "A");
	expect(f.command(true, "A").receipt).toEqual(enabled.receipt);
	f.command(true, "A2");
	await vi.advanceTimersByTimeAsync(0);
	expect(f.jobs).toHaveLength(1);
	f.start();
	f.command(false, "B");
	expect(f.command(true, "A").state.enabled).toBe(false);
	expect(() => f.command(false, "A")).toThrow("different content");
	f.command(true, "C");
	expect(f.channel.snapshot().phase).toBe("running");
	expect(f.jobs).toHaveLength(1);
	f.command(false, "D");
	await f.finish();
	await vi.advanceTimersByTimeAsync(10000);
	expect(f.jobs).toHaveLength(1);
});

test("countdown stop and preparation stop invalidate all later starts", async () => {
	const f = fixture();
	f.command(true);
	f.command(false);
	await vi.advanceTimersByTimeAsync(0);
	expect(f.jobs).toHaveLength(0);
	f.command(true);
	await vi.advanceTimersByTimeAsync(0);
	const ready = f.jobs[0].options.state.id;
	f.command(false);
	expect(f.store.get(ready)).toMatchObject({
		status: "interrupted",
		endReason: "controller_stop",
	});
	expect(
		f.service.command(ready, {
			protocolVersion: 1,
			requestId: randomUUID(),
			type: "start",
		}),
	).toMatchObject({ status: "rejected", code: "channel_stopped" });
	await vi.advanceTimersByTimeAsync(0);
	f.command(true);
	await vi.advanceTimersByTimeAsync(0);
	f.start();
	await f.finish();
	await vi.advanceTimersByTimeAsync(4999);
	f.command(false);
	await vi.advanceTimersByTimeAsync(20000);
	expect(f.jobs).toHaveLength(2);
});

test("a duplicate enable never restarts an existing countdown", async () => {
	const f = fixture();
	f.command(true);
	await vi.advanceTimersByTimeAsync(0);
	f.start();
	await f.finish();
	const at = f.channel.snapshot().nextStartAt;
	await vi.advanceTimersByTimeAsync(1000);
	f.command(true);
	expect(f.channel.snapshot().nextStartAt).toBe(at);
	await vi.advanceTimersByTimeAsync(4000);
	expect(f.jobs).toHaveLength(2);
});

test("real runner errors, even next to a natural terminal event, fault visibly without another round", async () => {
	const f = fixture();
	f.command(true);
	await vi.advanceTimersByTimeAsync(0);
	const id = f.start();
	await vi.advanceTimersByTimeAsync(100);
	f.service.advance(id);
	expect(["gameover", "won"]).toContain(f.store.get(id).status);
	f.jobs[0].reject(new Error("API failed test-model-key"));
	await vi.advanceTimersByTimeAsync(0);
	expect(f.channel.snapshot()).toMatchObject({
		phase: "fault",
		error: { message: "API failed [redacted]" },
	});
	await vi.advanceTimersByTimeAsync(10000);
	expect(f.jobs).toHaveLength(1);
	f.command(false);
	expect(f.channel.snapshot()).toMatchObject({
		enabled: false,
		phase: "fault",
	});
	f.command(true);
	await vi.advanceTimersByTimeAsync(0);
	expect(f.jobs).toHaveLength(2);
});

test("missing credentials fail before creation and store a visible fault", () => {
	const f = fixture(":memory:", "");
	expect(() => f.command(true)).toThrow("TYPESAFE_API_KEY");
	expect(f.store.list().matches).toHaveLength(0);
	expect(f.channel.snapshot().phase).toBe("fault");
});

test("unexpected interrupted completion is a channel fault, not a normal new round", async () => {
	const f = fixture();
	f.command(true);
	await vi.advanceTimersByTimeAsync(0);
	const id = f.start();
	f.service.command(id, {
		protocolVersion: 1,
		requestId: randomUUID(),
		type: "stop",
		reason: "external_stop",
	});
	f.jobs[0].resolve(publicState(f.store.get(id)));
	await vi.advanceTimersByTimeAsync(0);
	expect(f.channel.snapshot().phase).toBe("fault");
	await vi.advanceTimersByTimeAsync(5000);
	expect(f.jobs).toHaveLength(1);
});

test("failed command persistence has no success receipt or enabled state", () => {
	const f = fixture();
	f.store.db.exec(
		"CREATE TRIGGER fail_command BEFORE INSERT ON watch_commands BEGIN SELECT RAISE(ABORT,'injected command failure'); END;",
	);
	expect(() => f.command(true)).toThrow("injected command failure");
	expect(f.channel.store.read().snapshot.enabled).toBe(false);
	expect(f.store.list().matches).toHaveLength(0);
	expect(f.service.fault).toContain("injected");
});

test.each([
	"stopped",
	"starting",
	"running",
	"draining",
	"countdown",
	"fault",
] as const)(
	"restart recovers %s without replaying old moves or taking manual ready matches",
	async (phase) => {
		vi.useFakeTimers();
		const dir = mkdtempSync(join(tmpdir(), "watch-recovery-")),
			path = join(dir, "game.sqlite");
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
		const store = new Store(path),
			service = new MatchService(store, Date.now, false),
			watch = new WatchStore(store.db);
		const manual = service.create({
			requestId: "manual",
			controlToken: "x".repeat(32),
			agentName: "manual",
			config: config(),
		});
		const record = watch.read();
		let id: string | null = null;
		if (["starting", "running", "draining"].includes(phase)) {
			id = service.create({
				requestId: "owned",
				controlToken: "x".repeat(32),
				agentName: "owned",
				config: config(),
			}).id;
			if (phase !== "starting")
				service.command(id, {
					protocolVersion: 1,
					requestId: "start",
					type: "start",
				});
		}
		record.generation = 1;
		record.snapshot = {
			...record.snapshot,
			revision: 1,
			enabled: !["stopped", "draining"].includes(phase),
			phase,
			currentMatchId: id,
			nextStartAt: phase === "countdown" ? Date.now() + 300 : null,
			error:
				phase === "fault"
					? { code: "model_error", message: "preserved error" }
					: null,
		};
		if (id) watch.assign(record, id);
		else watch.write(record);
		service.close();
		store.close();
		const f = fixture(path);
		expect(f.store.get(manual.id).status).toBe("ready");
		if (id)
			expect(f.store.get(id)).toMatchObject({
				status: "interrupted",
				endReason: "server_restart",
			});
		const expected: WatchSnapshot["phase"] =
			phase === "fault"
				? "fault"
				: ["stopped", "draining"].includes(phase)
					? "stopped"
					: "countdown";
		expect(f.channel.snapshot().phase).toBe(expected);
		if (expected === "countdown")
			expect(f.channel.snapshot().nextStartAt).toBe(Date.now() + 5000);
		if (expected === "fault")
			expect(f.channel.snapshot().error?.message).toBe("preserved error");
		expect(f.jobs).toHaveLength(0);
	},
);

test("shutdown cancels scheduling, cleans active work and preserves enabled intent", async () => {
	const f = fixture();
	f.command(true);
	await vi.advanceTimersByTimeAsync(0);
	const id = f.start();
	await f.channel.close();
	expect(f.store.get(id)).toMatchObject({
		status: "interrupted",
		endReason: "server_shutdown",
	});
	expect(f.channel.store.read().snapshot.enabled).toBe(true);
	await vi.advanceTimersByTimeAsync(10000);
	expect(f.jobs).toHaveLength(1);
	expect(f.jobs[0].aborts).toBe(1);
});
