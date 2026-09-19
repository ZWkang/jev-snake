import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { Store } from "../server/db/store.js";
import { move } from "../server/game/engine.js";
import { restoreMatchAt } from "../server/matches/restore.js";
import { MatchService } from "../server/matches/service.js";
import { type Direction, type MatchState } from "../shared/snake/types.js";

function direction(s: MatchState): Direction {
	const { x, y } = s.snake[0];
	if (x === 0) return y === s.config.height - 1 ? "right" : "down";
	if (y % 2 === 1) return x === s.config.width - 1 ? "up" : "right";
	return x === 1 ? (y === 0 ? "left" : "up") : "left";
}

test("restart resumes the same game, RNG and history without counting downtime or duplicating moves", () => {
	const store = new Store(":memory:");
	let now = 1000;
	let service = new MatchService(store, () => now, false);
	try {
		const initial = service.create({
			requestId: "create",
			controlToken: "a".repeat(32),
			agentName: "resume-test",
			config: {
				width: 8,
				height: 6,
				obstacleCount: 0,
				seed: "resume-rewards",
				stepMode: "response",
				tickIntervalMs: null,
			},
		});
		const id = initial.id;
		const start = () =>
			service.command(id, {
				protocolVersion: 1,
				requestId: randomUUID(),
				type: "start",
			});
		const step = () => {
			now += 10;
			const c = service.decisionContext(id);
			const command = {
				protocolVersion: 1,
				requestId: randomUUID(),
				type: "action",
				direction: direction(store.get(id)),
				observedSeq: c.observedSeq,
				targetTick: c.targetTick,
				expectedStateHash: c.expectedStateHash,
			};
			expect(service.command(id, command).status).toBe("applied");
			return command;
		};
		expect(start().status).toBe("applied");
		let last;
		while (store.get(id).applesEaten < 5) last = step();
		const before = store.get(id);
		const history = store.events(id, -1, before.seq + 1).events;
		const progress = service.decisionContext(id).progress;
		service.close();
		now += 600_000;
		service = new MatchService(store, () => now, false);
		expect(store.get(id).endReason).toBe("server_restart");
		const resumed = service.resume(id, "b".repeat(32), () => {});
		expect(resumed).toMatchObject({
			id,
			tick: before.tick,
			score: before.score,
			config: before.config,
			snake: before.snake,
			apple: before.apple,
			star: before.star,
			gameTimeMs: before.gameTimeMs,
		});
		expect(() => service.authorize(id, "a".repeat(32))).toThrow();
		service.authorize(id, "b".repeat(32));
		expect(start().status).toBe("applied");
		expect(store.get(id).startedAt).toBe(before.startedAt);
		expect(service.elapsed(id)).toBe(before.gameTimeMs);
		expect(service.decisionContext(id).progress).toEqual(progress);
		expect(service.command(id, last).status).toBe("applied");
		expect(store.get(id).tick).toBe(before.tick);
		const expected = structuredClone(before);
		for (let i = 0; i < 80; i++) {
			expected.gameTimeMs += 10;
			move(expected, direction(expected));
			step();
			const actual = store.get(id);
			expect(actual).toMatchObject({
				snake: expected.snake,
				apple: expected.apple,
				star: expected.star,
				rngState: expected.rngState,
				score: expected.score,
				tick: expected.tick,
				gameTimeMs: expected.gameTimeMs,
			});
		}
		expect(store.events(id, -1, history.length).events).toEqual(history);
		const final = store.get(id);
		const restored = restoreMatchAt(
			store.events(id, -1, final.seq + 1).events,
			final.seq,
		);
		expect(restored.rngState).toBe(final.rngState);
	} finally {
		service.close();
		store.close();
	}
});

test.each(["controller_stop", "model_error"])(
	"recovery does not resurrect %s interruptions",
	(reason) => {
		const store = new Store(":memory:");
		const service = new MatchService(store, () => 0, false);
		try {
			const state = service.create({
				requestId: "create",
				controlToken: "a".repeat(32),
				agentName: "test",
				config: {
					width: 8,
					height: 6,
					obstacleCount: 0,
					seed: "stop",
					stepMode: "response",
					tickIntervalMs: null,
				},
			});
			service.command(state.id, {
				protocolVersion: 1,
				requestId: "stop",
				type: "stop",
				reason,
			});
			expect(() => service.resume(state.id, "b".repeat(32), () => {})).toThrow(
				"not interrupted by a server restart",
			);
		} finally {
			service.close();
			store.close();
		}
	},
);
