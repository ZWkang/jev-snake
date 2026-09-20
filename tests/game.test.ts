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
import { gameConfig } from "../server/jev/game-config.js";
import { MatchService } from "../server/matches/service.js";
import type { GameConfig } from "../shared/snake/types.js";
import { directions, publicState, vectors } from "../shared/snake/types.js";

const config: GameConfig = {
	width: 24,
	height: 18,
	obstacleCount: 0,
	stepMode: "response",
	tickIntervalMs: null,
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
test("actual decision request survives application, stale rejection and SQLite reread", () => {
	const f = fixture();
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
			probabilities: Object.fromEntries(
				Object.keys(request.questions.direction.criteria).map((d) => [
					d,
					d === "right" ? 1 : 0,
				]),
			),
			confidence: 1,
			requestMs: 15,
			request,
		},
	};
	expect(f.service.command(f.match.id, command).status).toBe("applied");
	f.advance(300);
	expect(
		f.service.command(f.match.id, { ...command, requestId: "late-input" }).code,
	).toBe("stale_state");
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
	test.each([undefined, 2] as const)(
		"layout %s is reproducible, connected, non-overlapping and protects spawn",
		(layoutVersion) => {
			for (const seed of ["red", "green", "blue"]) {
				const cfg = { ...config, seed, obstacleCount: 12, layoutVersion };
				const a = createState("a", "A", null, cfg, "now");
				const b = createState("b", "B", null, cfg, "later");
				expect(a.snake).toEqual(b.snake);
				expect(a.direction).toBe(b.direction);
				expect(a.rngState).toBe(b.rngState);
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
						[1, 2, 3].map((step) => ({
							x: a.snake[0].x + vectors[a.direction].x * step,
							y: a.snake[0].y + vectors[a.direction].y * step,
						})),
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
		},
	);
	test.each([
		[24, 18],
		[7, 7],
		[7, 1],
		[8, 6],
	])(
		"new %s x %s rounds vary spawn, fit the board and can move three steps",
		(width, height) => {
			const headings = new Set<string>();
			const heads = new Set<string>();
			for (let i = 0; i < 64; i++) {
				const cfg = gameConfig(
					{},
					{
						width: String(width),
						height: String(height),
						obstacles: height === 18 ? "12" : "0",
						seed: `spawn-${i}`,
					},
				);
				expect(cfg.layoutVersion).toBe(3);
				const s = createState("spawn", "Test", null, cfg, "now");
				headings.add(s.direction);
				heads.add(JSON.stringify(s.snake[0]));
				expect(s.snake).toHaveLength(4);
				expect(new Set(s.snake.map((p) => `${p.x},${p.y}`)).size).toBe(4);
				for (const [index, point] of s.snake.entries()) {
					expect(point.x).toBeGreaterThanOrEqual(0);
					expect(point.y).toBeGreaterThanOrEqual(0);
					expect(point.x).toBeLessThan(width);
					expect(point.y).toBeLessThan(height);
					if (index > 0) {
						const previous = s.snake[index - 1];
						expect({
							x: previous.x - point.x,
							y: previous.y - point.y,
						}).toEqual(vectors[s.direction]);
					}
				}
				expect(s.snake).not.toContainEqual(s.apple);
				expect(s.obstacles).not.toContainEqual(s.apple);
				s.status = "running";
				for (let step = 0; step < 3; step++)
					expect(move(s, s.direction).type).not.toBe("gameover");
			}
			expect(headings).toEqual(
				new Set(height >= 7 ? directions : ["right", "left"]),
			);
			if (width > 7 || height > 1) expect(heads.size).toBeGreaterThan(1);
		},
	);
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
describe("response persistence", () => {
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
		expect(() =>
			f.service.command(f.match.id, {
				protocolVersion: 1,
				requestId: "move-fails",
				type: "action",
				observedSeq: before.seq,
				targetTick: before.tick + 1,
				expectedStateHash: stateHash(before),
				direction: "right",
			}),
		).toThrow("write failed");
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
			tick: 0,
			gameTimeMs: 0,
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
