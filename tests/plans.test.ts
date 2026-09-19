import { afterEach, expect, test, vi } from "vitest";
import { Store } from "../server/db/store.js";
import { gameConfig } from "../server/jev/game-config.js";
import { MatchService } from "../server/matches/service.js";
import { createSchema, configSchema } from "../shared/snake/schema.js";
import { decisionStatistics } from "../src/features/snake/replay.js";
import { loadLegacy } from "./legacy-fixture.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
	vi.restoreAllMocks();
});
function fixture(snapshot?: string, restart = false) {
	const store = new Store(":memory:");
	const legacy = snapshot ? loadLegacy(store, snapshot) : undefined;
	let now = 0;
	// A ready fixture is never scheduled; running snapshots intentionally exercise restart cancellation.
	const service = new MatchService(store, () => now, false);
	cleanup.push(() => {
		service.close();
		store.close();
	});
	if (restart) expect(legacy).toBeDefined();
	return {
		store,
		service,
		legacy,
		time: (value: number) => {
			now = value;
		},
	};
}
const creation = {
	requestId: "new-response",
	controlToken: "response-only-test-control-token-00000",
	agentName: "Response test",
	config: { seed: "response-default", obstacleCount: 0 },
};

test("creation defaults to explicit response/single_step/null while historical parsing keeps fixed semantics", () => {
	expect(createSchema.parse(creation).config).toMatchObject({
		stepMode: "response",
		decisionMode: "single_step",
		tickIntervalMs: null,
	});
	expect(configSchema.parse(creation.config)).toMatchObject({
		tickIntervalMs: 300,
	});
	const f = fixture();
	const match = f.service.create(creation);
	expect(match.recordVersion).toBe(3);
	expect(f.service.create(creation)).toEqual(match);
	expect(() =>
		f.service.create({ ...creation, agentName: "different" }),
	).toThrow("different content");
});
test.each([
	{ stepMode: "fixed" },
	{ decisionMode: "two_step_fallback" },
	{ tickIntervalMs: 300 },
	{ stepMode: "unknown" },
])("retired creation configuration %j fails without writing", (config) => {
	const f = fixture();
	expect(() =>
		f.service.create({
			...creation,
			config: { ...creation.config, ...config },
		}),
	).toThrow();
	expect(f.store.list().matches).toHaveLength(0);
});
test("legacy tick environment is visible but cannot affect response speed or seed configuration", () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	expect(
		gameConfig({ SNAKE_TICK_MS: "50000", SNAKE_SEED: "same" }),
	).toMatchObject({
		stepMode: "response",
		decisionMode: "single_step",
		tickIntervalMs: null,
		seed: "same",
	});
	expect(warn).toHaveBeenCalledWith(expect.stringContaining("deprecated"));
	warn.mockClear();
	gameConfig({});
	expect(warn).not.toHaveBeenCalled();
	for (const values of [
		{ "step-mode": "fixed" },
		{ "decision-mode": "two_step_fallback" },
		{ "tick-ms": "300" },
	])
		expect(() => gameConfig({}, values)).toThrow();
});
test.each(["single_step", "two_step_fallback"])(
	"old %s ready matches remain readable, idempotent and stoppable but cannot start or fork",
	(mode) => {
		const f = fixture(`${mode}-ready`);
		const old = f.legacy!;
		expect(f.service.create(old.creation).id).toBe(old.id);
		const before = f.store.get(old.id);
		expect(() =>
			f.service.fork(old.id, {
				requestId: "fork-retired",
				controlToken: creation.controlToken,
				agentName: "Fork",
				sourceSeq: 0,
			}),
		).toThrow("Only response single-step matches can be forked");
		expect(f.store.get(old.id)).toEqual(before);
		expect(f.store.list().matches).toHaveLength(1);
		expect(
			f.service.command(old.id, {
				protocolVersion: 1,
				requestId: "start-retired",
				type: "start",
			}),
		).toMatchObject({ status: "rejected", code: "mode_retired" });
		f.time(10000);
		f.service.advance(old.id);
		expect(f.store.get(old.id)).toMatchObject({
			status: "ready",
			tick: 0,
			config: before.config,
		});
		expect(
			f.service.command(old.id, {
				protocolVersion: 1,
				requestId: "stop-retired",
				type: "stop",
			}),
		).toMatchObject({ status: "applied" });
		expect(f.store.get(old.id).status).toBe("interrupted");
	},
);
test.each(["single_step", "two_step_fallback"])(
	"old %s running history survives restart and never schedules a move",
	(mode) => {
		const f = fixture(`${mode}-running`, true);
		const old = f.legacy!;
		const events = f.store.events(old.id, -1).events;
		const prefix = old.tables.match_events.map((r) => JSON.parse(r.event_json));
		expect(events.slice(0, prefix.length)).toEqual(prefix);
		expect(f.store.get(old.id)).toMatchObject({
			status: "interrupted",
			endReason: "server_restart",
			tick: 1,
			snake: old.state.snake,
			config: old.state.config,
		});
		f.time(50000);
		f.service.advance(old.id);
		expect(f.store.get(old.id).tick).toBe(1);
		const command = old.commands[1];
		const receipt = f.service.command(old.id, command);
		expect(receipt.status).toBe(
			mode === "two_step_fallback" ? "accepted" : "applied",
		);
		if (mode === "two_step_fallback") {
			expect(receipt.steps?.map((s) => s.status)).toEqual([
				"applied",
				"cancelled",
			]);
			expect(events.some((e) => e.type === "plan_step_cancelled")).toBe(true);
		}
		if (mode === "two_step_fallback")
			expect(() =>
				f.service.command(old.id, { ...command, requestId: "fresh-retired" }),
			).toThrow("protocol v1");
		else
			expect(
				f.service.command(old.id, { ...command, requestId: "fresh-retired" }),
			).toMatchObject({ status: "rejected", code: "mode_retired" });
	},
);
test("new v2 commands are rejected while captured plan, fallback and coast history stays readable", () => {
	const f = fixture("two_step_fallback-moved");
	const old = f.legacy!;
	const events = old.tables.match_events.map((r) => JSON.parse(r.event_json));
	expect(decisionStatistics(events)).toMatchObject({
		requests: 1,
		primary: 1,
		fallback: 1,
		coast: 1,
	});
	const current = f.service.create(creation);
	for (const command of [
		old.commands[1],
		{ protocolVersion: 2, type: "start", requestId: "v2-start" },
		{ protocolVersion: 2, type: "stop", requestId: "v2-stop" },
	])
		expect(() => f.service.command(current.id, command)).toThrow("protocol v1");
	expect(f.store.get(current.id)).toMatchObject({ status: "ready", tick: 0 });
	expect(f.store.events(old.id, -1).events.slice(0, events.length)).toEqual(
		events,
	);
});
