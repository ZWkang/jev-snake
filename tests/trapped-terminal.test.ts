import { expect, test } from "vitest";
import { Store } from "../server/db/store.js";
import { inspectMove } from "../server/game/engine.js";
import { MatchService } from "../server/matches/service.js";
import type { MatchState } from "../shared/snake/types.js";
import { directions } from "../shared/snake/types.js";
import fixture from "./fixtures/reverse-deadlock-2424060a.json";

test("the reported tick-186 deadlock terminates before another model context is issued", () => {
	const store = new Store(":memory:");
	const service = new MatchService(store, () => 0, false);
	try {
		const created = service.create({
			requestId: "regression",
			controlToken: "test".repeat(10),
			agentName: "deadlock regression",
			config: fixture.state.config,
		});
		// Load the actual reported geometry at the test's control boundary.
		const saved = store.get(created.id);
		const position: MatchState = {
			...saved,
			...fixture.state,
			id: created.id,
			seq: saved.seq,
			status: "ready",
			endReason: null,
			startedAt: null,
			endedAt: null,
			lastDecision: null,
		} as MatchState;
		store.commit(position, []);
		expect(
			Object.fromEntries(
				directions.map((d) => [d, inspectMove(position, d).immediateCollision]),
			),
		).toEqual({ up: "body", right: "body", down: "body", left: "reverse" });
		service.command(created.id, {
			protocolVersion: 1,
			requestId: "start",
			type: "start",
		});
		expect(() => service.decisionContext(created.id)).toThrow(
			"Match is not running",
		);
		const ended = store.get(created.id);
		expect(ended).toMatchObject({
			status: "gameover",
			endReason: "no_legal_moves",
			tick: 186,
			score: 320,
			snake: position.snake,
			rngState: position.rngState,
		});
		const terminal = store.events(created.id, ended.seq - 1, 1).events[0];
		expect(terminal).toMatchObject({
			type: "trapped",
			tick: 186,
			data: {
				blockedDirections: {
					up: "body",
					right: "body",
					down: "body",
					left: "reverse",
				},
			},
		});
		expect(() => service.decisionContext(created.id)).toThrow(
			"Match is not running",
		);
		expect(store.get(created.id).seq).toBe(ended.seq);
	} finally {
		service.close();
		store.close();
	}
});

test("a vacating tail is a legal exit and must not end the game", () => {
	const store = new Store(":memory:");
	const service = new MatchService(store, () => 0, false);
	try {
		const created = service.create({
			requestId: "tail",
			controlToken: "test".repeat(10),
			agentName: "tail regression",
			config: {
				width: 7,
				height: 2,
				obstacleCount: 0,
				seed: "tail",
				stepMode: "response",
				tickIntervalMs: null,
			},
		});
		const position = store.get(created.id);
		position.snake = [
			{ x: 0, y: 0 },
			{ x: 1, y: 0 },
			{ x: 1, y: 1 },
			{ x: 0, y: 1 },
		];
		position.direction = "left";
		position.apple = { x: 6, y: 1 };
		store.commit(position, []);
		service.command(created.id, {
			protocolVersion: 1,
			requestId: "start",
			type: "start",
		});
		expect(inspectMove(position, "down").immediateCollision).toBeNull();
		expect(service.decisionContext(created.id).state.status).toBe("running");
	} finally {
		service.close();
		store.close();
	}
});
