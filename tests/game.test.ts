import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Store } from "../server/db/store.js";
import {
	createState,
	expireStar,
	move,
	stateHash,
} from "../server/game/engine.js";
import { decisionBody, JEV_MODEL } from "../server/jev/client.js";
import { MatchService } from "../server/matches/service.js";
import type { GameConfig } from "../shared/snake/types.js";
import { publicState } from "../shared/snake/types.js";

const config: GameConfig = {
	width: 24,
	height: 18,
	obstacleCount: 0,
	tickIntervalMs: 125,
	seed: "test-seed",
};
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
	vi.restoreAllMocks();
});
function fixture(extra: Partial<GameConfig> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "snake-test-"));
	const store = new Store(join(dir, "game.sqlite"));
	let now = 0;
	const service = new MatchService(store, () => now, false);
	cleanup.push(() => {
		service.close();
		if (store.db.open) store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const match = service.create({
		requestId: "create-1",
		controlToken: "a".repeat(32),
		agentName: "Test controller",
		config: { ...config, ...extra },
	});
	const start = () =>
		service.command(match.id, {
			protocolVersion: 1,
			requestId: "start",
			type: "start",
		});
	return {
		dir,
		store,
		service,
		match,
		start,
		time: (t: number) => {
			now = t;
		},
		advance: (t: number) => {
			now = t;
			service.advance(match.id);
		},
	};
}
test("actual decision request survives acceptance, late rejection and SQLite reread", () => {
	const f = fixture({ tickIntervalMs: 300 });
	f.start();
	const plan = f.service.decisionContext(f.match.id);
	const request = decisionBody(plan.state);
	const command = {
		protocolVersion: 1,
		requestId: "with-input",
		type: "action",
		observedSeq: plan.observedSeq,
		targetTick: plan.targetTick,
		expectedStateHash: plan.expectedStateHash,
		direction: "right",
		decision: {
			model: JEV_MODEL,
			choice: "right",
			probabilities: { up: 0, right: 1, down: 0, left: 0 },
			confidence: 1,
			requestMs: 15,
			request,
		},
	};
	expect(f.service.command(f.match.id, command).status).toBe("accepted");
	f.advance(300);
	expect(
		f.service.command(f.match.id, { ...command, requestId: "late-input" }).code,
	).toBe("late_action");
	const saved = new Store(join(f.dir, "game.sqlite"));
	cleanup.push(() => saved.close());
	const actions = saved
		.events(f.match.id, -1)
		.events.filter((e) => e.type.startsWith("action_"));
	expect(actions).toHaveLength(2);
	for (const event of actions)
		expect(event.state.lastDecision?.request).toEqual(request);
	expect(saved.get(f.match.id).lastDecision?.request).toEqual(request);
	expect(() =>
		f.service.command(f.match.id, {
			...command,
			requestId: "headers-not-allowed",
			decision: {
				...command.decision,
				request: { ...request, headers: { Authorization: "secret" } },
			},
		}),
	).toThrow();
});
describe("engine", () => {
	test("random layouts are reproducible, connected, non-overlapping and protect spawn", () => {
		for (const seed of ["red", "green", "blue"]) {
			const cfg = { ...config, seed, obstacleCount: 12 };
			const a = createState("a", "A", null, cfg, "now");
			const b = createState("b", "B", null, cfg, "later");
			expect(a.obstacles).toEqual(b.obstacles);
			expect(a.apple).toEqual(b.apple);
			expect(new Set(a.obstacles.map((p) => `${p.x},${p.y}`)).size).toBe(12);
			for (const p of a.obstacles) {
				expect(p.x).toBeGreaterThan(0);
				expect(p.x).toBeLessThan(cfg.width - 1);
				expect(p.y).toBeGreaterThan(0);
				expect(p.y).toBeLessThan(cfg.height - 1);
				expect(a.snake).not.toContainEqual(p);
				expect(
					[1, 2, 3].map((x) => ({ x: a.snake[0].x + x, y: a.snake[0].y })),
				).not.toContainEqual(p);
			}
			const blocked = new Set(a.obstacles.map((p) => `${p.x},${p.y}`));
			const seen = new Set(["0,0"]);
			const queue = [{ x: 0, y: 0 }];
			for (let i = 0; i < queue.length; i++)
				for (const [dx, dy] of [
					[1, 0],
					[-1, 0],
					[0, 1],
					[0, -1],
				]) {
					const p = { x: queue[i].x + dx, y: queue[i].y + dy };
					const key = `${p.x},${p.y}`;
					if (
						p.x >= 0 &&
						p.y >= 0 &&
						p.x < cfg.width &&
						p.y < cfg.height &&
						!blocked.has(key) &&
						!seen.has(key)
					) {
						seen.add(key);
						queue.push(p);
					}
				}
			expect(seen.size).toBe(cfg.width * cfg.height - 12);
		}
	});
	test("apple grows, star does not, expiry happens at its exact boundary", () => {
		const s = createState("a", "A", null, config, "now");
		s.status = "running";
		s.apple = { x: 8, y: 9 };
		s.gameTimeMs = 125;
		expect(move(s, "right").type).toBe("apple");
		expect(s.score).toBe(10);
		expect(s.snake).toHaveLength(5);
		s.star = { point: { x: 9, y: 9 }, expiresAt: 8000 };
		expect(move(s, "right").type).toBe("star");
		expect(s.score).toBe(40);
		expect(s.snake).toHaveLength(5);
		s.star = { point: { x: 0, y: 0 }, expiresAt: 8000 };
		expect(expireStar(s, 7999)).toBe(false);
		expect(expireStar(s, 8000)).toBe(true);
	});
	test("allows the departing tail but rejects occupied body, obstacles and walls", () => {
		const s = createState("a", "A", null, config, "now");
		s.status = "running";
		s.apple = { x: 20, y: 15 };
		s.snake = [
			{ x: 2, y: 2 },
			{ x: 2, y: 3 },
			{ x: 1, y: 3 },
			{ x: 1, y: 2 },
		];
		s.direction = "up";
		expect(move(s, "left").type).toBe("move");
		s.direction = "down";
		expect(move(s, "right").type).toBe("gameover");
		expect(s.endReason).toBe("self");
		const wall = createState("w", "A", null, config, "now");
		wall.status = "running";
		wall.snake[0] = { x: 23, y: 9 };
		expect(move(wall, "right").type).toBe("gameover");
		expect(wall.snake[0]).toEqual({ x: 23, y: 9 });
		const rock = createState("r", "A", null, config, "now");
		rock.status = "running";
		rock.obstacles = [{ x: 8, y: 9 }];
		expect(move(rock, "right").type).toBe("gameover");
		expect(rock.endReason).toBe("obstacle");
	});
	test("apple replaces star in the last free cell, then full board wins", () => {
		const s = createState("a", "A", null, config, "now");
		s.status = "running";
		s.config = { ...config, width: 3, height: 2 };
		s.snake = [
			{ x: 1, y: 0 },
			{ x: 0, y: 0 },
			{ x: 0, y: 1 },
			{ x: 1, y: 1 },
		];
		s.apple = { x: 2, y: 0 };
		s.star = { point: { x: 2, y: 1 }, expiresAt: 8000 };
		move(s, "right");
		expect(s.star).toBeNull();
		expect(s.apple).toEqual({ x: 2, y: 1 });
		expect(move(s, "down").type).toBe("won");
		expect(s.apple).toBeNull();
	});
	test("invalid map requests fail instead of reducing obstacle count", () => {
		expect(() =>
			createState("a", "A", null, { ...config, obstacleCount: 500 }, "now"),
		).toThrow("Obstacle count");
	});
});
describe("clock, planned actions and persistence", () => {
	test("ready does not move, clock advances without inputs and speed is configurable", () => {
		const f = fixture();
		f.advance(500);
		expect(f.store.get(f.match.id).tick).toBe(0);
		f.start();
		f.advance(1000);
		expect(f.store.get(f.match.id).tick).toBe(4);
		const slow = fixture({ tickIntervalMs: 500 });
		slow.start();
		slow.advance(1000);
		expect(slow.store.get(slow.match.id).tick).toBe(2);
	});
	test("acceptance is not movement; duplicate after application is not late", () => {
		const f = fixture();
		f.start();
		const plan = f.service.decisionContext(f.match.id);
		const command = {
			protocolVersion: 1,
			requestId: "turn",
			type: "action",
			observedSeq: plan.observedSeq,
			targetTick: plan.targetTick,
			expectedStateHash: plan.expectedStateHash,
			direction: "up",
		};
		f.time(100);
		expect(f.service.command(f.match.id, command).status).toBe("accepted");
		expect(f.store.get(f.match.id).direction).toBe("right");
		expect(f.store.get(f.match.id).tick).toBe(0);
		f.advance(125);
		expect(f.store.get(f.match.id).direction).toBe("up");
		expect(f.service.command(f.match.id, command).status).toBe("applied");
		expect(() =>
			f.service.command(f.match.id, { ...command, direction: "down" }),
		).toThrow("different content");
	});
	test.each([125, 150])(
		"an action received at %sms cannot be moved to the next tick",
		(time) => {
			const f = fixture();
			f.start();
			const p = f.service.decisionContext(f.match.id);
			f.time(time);
			expect(
				f.service.command(f.match.id, {
					protocolVersion: 1,
					requestId: "late",
					type: "action",
					observedSeq: p.observedSeq,
					targetTick: p.targetTick,
					expectedStateHash: p.expectedStateHash,
					direction: "up",
				}).code,
			).toBe("late_action");
			expect(f.store.get(f.match.id).direction).toBe("right");
		},
	);
	test("only the next movement can be reserved, and an old observation cannot be retargeted", () => {
		const f = fixture({ tickIntervalMs: 300 });
		f.start();
		const current = f.service.decisionContext(f.match.id);
		expect(current.state).toEqual(publicState(f.store.get(f.match.id)));
		expect(current.targetTick).toBe(current.state.tick + 1);
		const action = {
			protocolVersion: 1,
			requestId: "future",
			type: "action",
			observedSeq: current.observedSeq,
			targetTick: current.targetTick + 4,
			expectedStateHash: current.expectedStateHash,
			direction: "up",
		};
		expect(f.service.command(f.match.id, action).code).toBe(
			"invalid_target_tick",
		);
		expect(f.store.get(f.match.id).pending).toHaveLength(0);
		expect(
			f.service.command(f.match.id, {
				...action,
				requestId: "current",
				targetTick: current.targetTick,
			}).status,
		).toBe("accepted");
		expect(() => f.service.decisionContext(f.match.id)).toThrow(
			"already has a decision",
		);
		expect(f.store.get(f.match.id).pending).toHaveLength(1);
		f.advance(300);
		const next = f.service.decisionContext(f.match.id);
		expect(next.state.tick).toBe(1);
		expect(next.targetTick).toBe(2);
		expect(
			f.service.command(f.match.id, {
				...action,
				requestId: "retarget-old",
				targetTick: next.targetTick,
				expectedStateHash: next.expectedStateHash,
			}).code,
		).toBe("stale_state");
		expect(f.store.get(f.match.id).pending).toHaveLength(0);
	});
	test("a decision is cancelled if its actual observed state changes before the movement", () => {
		const f = fixture({ tickIntervalMs: 300 });
		const initial = f.store.get(f.match.id);
		initial.star = { point: { x: 0, y: 0 }, expiresAt: 300 };
		f.store.commit(initial, [], []);
		f.start();
		const context = f.service.decisionContext(f.match.id);
		expect(context.state.star).not.toBeNull();
		f.service.command(f.match.id, {
			protocolVersion: 1,
			requestId: "expiring-state",
			type: "action",
			observedSeq: context.observedSeq,
			targetTick: context.targetTick,
			expectedStateHash: context.expectedStateHash,
			direction: "up",
		});
		f.advance(300);
		expect(
			f.store.request(f.match.id, "expiring-state")?.receipt,
		).toMatchObject({ status: "cancelled", code: "stale_state" });
		expect(f.store.get(f.match.id).direction).toBe("right");
	});
	test("rejects an invalid expected state and direct reversal without occupying a slot", () => {
		const f = fixture();
		f.start();
		const p = f.service.decisionContext(f.match.id);
		const c = {
			protocolVersion: 1,
			requestId: "bad",
			type: "action",
			observedSeq: p.observedSeq,
			targetTick: p.targetTick,
			expectedStateHash: "0".repeat(64),
			direction: "up",
		};
		expect(f.service.command(f.match.id, c).code).toBe("stale_state");
		expect(
			f.service.command(f.match.id, {
				...c,
				requestId: "reverse",
				expectedStateHash: p.expectedStateHash,
				direction: "left",
			}).code,
		).toBe("invalid_direction");
		expect(f.store.get(f.match.id).pending).toHaveLength(0);
	});
	test("transaction failure does not leak partial state or a successful event", () => {
		const f = fixture();
		f.start();
		const before = f.store.get(f.match.id);
		const listener = vi.fn();
		f.service.subscribe(listener);
		f.store.db.exec(
			"CREATE TRIGGER fail_insert BEFORE INSERT ON match_events BEGIN SELECT RAISE(ABORT, 'write failed'); END",
		);
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => f.advance(125)).toThrow("write failed");
		expect(f.store.get(f.match.id)).toEqual(before);
		expect(
			listener.mock.calls.filter(([id]) => id === f.match.id),
		).toHaveLength(0);
		expect(f.service.fault).toContain("write failed");
	});
	test("restart preserves committed events and marks active matches interrupted", () => {
		const f = fixture();
		f.start();
		f.advance(250);
		const before = f.store.get(f.match.id);
		f.service.close();
		f.store.close();
		const store = new Store(join(f.dir, "game.sqlite"));
		const service = new MatchService(store, () => 0, false);
		cleanup.push(() => {
			service.close();
			store.close();
		});
		expect(store.get(f.match.id)).toMatchObject({
			status: "interrupted",
			endReason: "server_restart",
			tick: 2,
			gameTimeMs: 250,
		});
		expect(store.events(f.match.id, -1).events.at(-1)?.state.snake).toEqual(
			before.snake,
		);
	});
	test("history pagination and snapshots match the source of truth", () => {
		const f = fixture();
		f.start();
		f.advance(250);
		for (let i = 0; i < 3; i++)
			f.service.create({
				requestId: `create-${i + 2}`,
				controlToken: "a".repeat(32),
				agentName: "Other",
				config,
			});
		const first = f.store.list({ limit: 2 });
		const second = f.store.list({
			limit: 2,
			cursor: first.nextCursor as string,
		});
		expect(
			new Set([...first.matches, ...second.matches].map((m) => m.id)).size,
		).toBe(4);
		const s = f.store.get(f.match.id);
		expect(f.store.events(s.id, -1).events.at(-1)?.state).toEqual(
			publicState(s),
		);
		expect(f.store.list({ agent: "Other" }).matches).toHaveLength(3);
		expect(stateHash(s)).toHaveLength(64);
	});
});

test("a missing final event is an explicit corruption error, never an empty endless page", () => {
	const f = fixture();
	f.start();
	f.advance(125);
	const latest = f.store.get(f.match.id);
	f.store.db
		.prepare("DELETE FROM match_events WHERE match_id=? AND seq=?")
		.run(latest.id, latest.seq);
	expect(() => f.store.events(latest.id, latest.seq - 1)).toThrow("incomplete");
});
