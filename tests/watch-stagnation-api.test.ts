import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { jevConfig, JEV_PROVIDERS } from "../server/jev/config.js";
import { gameConfig } from "../server/jev/game-config.js";
import { startServer } from "../server/start.js";
import type { DecisionRequestV16 } from "../shared/snake/compact-growth.js";
import { stagnationMessage } from "../shared/snake/stagnation.js";
import type { Direction } from "../shared/snake/types.js";
import { reasonName } from "../src/features/snake/api.js";

test.each([
	[false, false],
	[true, false],
	[false, true],
])(
	"no-apple protection ends the round and continues only while scheduling is enabled (restart before threshold=%s, completion commit gap=%s)",
	async (restartBeforeThreshold, completionCommitGap) => {
		const directory = mkdtempSync(join(tmpdir(), "snake-watch-stagnation-"));
		const transport = globalThis.fetch;
		const calls: DecisionRequestV16[] = [];
		let holdSecondMove = restartBeforeThreshold;
		let holdNextRound = true;
		let rounds = 0;
		const release: (() => void)[] = [];
		vi.stubGlobal(
			"fetch",
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				if (String(input) !== JEV_PROVIDERS.typesafe.endpoint)
					return transport(input, init);
				const body = JSON.parse(init!.body as string) as DecisionRequestV16;
				calls.push(body);
				if (body.state.timing.observedTick === 0) rounds++;
				if (
					(holdSecondMove && body.state.timing.observedTick === 1) ||
					(holdNextRound && rounds > 1 && body.state.timing.observedTick === 0)
				) {
					await new Promise<void>((resolve, reject) => {
						release.push(resolve);
						if (init?.signal?.aborted) reject(init.signal.reason);
						else
							init?.signal?.addEventListener(
								"abort",
								() => reject(init.signal?.reason),
								{ once: true },
							);
					});
				}
				const options = Object.keys(
					body.questions.direction.criteria,
				) as (keyof typeof body.questions.direction.criteria)[];
				const nonApple = options.filter(
					(direction) => !body.state.moveFacts[direction]!.eatsApple,
				);
				const choice = nonApple.includes(body.state.player.direction)
					? body.state.player.direction
					: nonApple[0];
				expect(choice).toBeDefined();
				return Response.json({
					model: "test-only-stagnation-transport",
					answers: {
						direction: {
							type: "choice",
							choice,
							confidence: 1,
							probabilities: Object.fromEntries(
								options.map((direction) => [
									direction,
									direction === choice ? 1 : 0,
								]),
							),
						},
					},
				});
			},
		);
		const secret = "cost-protection-test-owner".repeat(2);
		const options = {
			path: join(directory, "game.sqlite"),
			port: 0,
			adminToken: secret,
			watch: {
				jev: jevConfig({
					TYPESAFE_API_KEY: "test-only-model-key",
					JEV_STAGNATION_GUARD: "true",
					JEV_STAGNATION_MAX_VISITS: "99",
					JEV_STAGNATION_MAX_NO_APPLE_MOVES: "2",
				}),
				makeConfig: () =>
					gameConfig(
						{},
						{
							width: "8",
							height: "8",
							obstacles: "0",
							seed: "watch-stagnation",
						},
					),
				intermissionMs: 500,
				log: () => {},
			},
		};
		let game = startServer(options);
		const base = () => {
			const address = game.server.address();
			if (!address || typeof address === "string")
				throw new Error("No HTTP address");
			return `http://127.0.0.1:${address.port}`;
		};
		const post = (path: string, body: unknown, cookie?: string) =>
			transport(`${base()}/api/watch-admin/${path}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: "http://localhost:3000",
					...(cookie ? { Cookie: cookie } : {}),
				},
				body: JSON.stringify(body),
			});
		const login = async () => {
			const response = await post("session", { password: secret });
			expect(response.status).toBe(200);
			return response.headers.get("set-cookie")!.split(";")[0];
		};
		try {
			await game.ready;
			let cookie = await login();
			expect(
				(
					await post(
						"commands",
						{ requestId: "enable-original", enabled: true },
						cookie,
					)
				).status,
			).toBe(200);
			let originalId: string | undefined;
			if (restartBeforeThreshold) {
				await vi.waitFor(() => expect(calls).toHaveLength(2), {
					timeout: 5000,
				});
				originalId = game.channel.snapshot().currentMatchId!;
				expect(game.store.get(originalId).tick).toBe(1);
				expect(calls[1].state.progress?.movesSinceApple).toBe(1);
				await game.close();
				holdSecondMove = false;
				game = startServer(options);
				await game.ready;
			}
			await vi.waitFor(
				() => expect(game.channel.snapshot().phase).toBe("countdown"),
				{ timeout: 5000 },
			);
			const protectedState = game.channel.snapshot();
			const id = protectedState.lastMatchId!;
			if (originalId) expect(id).toBe(originalId);
			const beforeNextRound = restartBeforeThreshold ? 3 : 2;
			expect(calls).toHaveLength(beforeNextRound);
			expect(calls.map((call) => call.state.timing.observedTick)).toEqual(
				restartBeforeThreshold ? [0, 1, 1] : [0, 1],
			);
			if (restartBeforeThreshold)
				expect(calls[2].state.progress?.movesSinceApple).toBe(1);
			expect(protectedState).toMatchObject({
				enabled: true,
				phase: "countdown",
				currentMatchId: null,
				lastMatchId: id,
				nextStartAt: expect.any(Number),
				error: null,
			});
			expect(game.store.get(id)).toMatchObject({
				status: "interrupted",
				endReason: "stagnation_no_apple",
				tick: 2,
				applesEaten: 0,
			});
			const events = game.store.events(id, -1).events;
			expect(
				events.filter((event) => event.type === "action_accepted"),
			).toHaveLength(2);
			expect(
				events.filter((event) => event.type === "action_rejected"),
			).toHaveLength(0);
			const guardEvents = events.filter(
				(event) =>
					event.type === "interrupted" &&
					event.data.reason === "stagnation_no_apple",
			);
			expect(guardEvents).toHaveLength(1);
			expect(guardEvents[0].data.guard).toMatchObject({
				reason: "stagnation_no_apple",
				observedTick: 2,
				movesSinceApple: 2,
				maxPositionVisits: 99,
				maxMovesWithoutApple: 2,
			});
			expect(events.at(-1)?.tick).toBe(2);
			const savedSeq = game.store.get(id).seq;
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(calls).toHaveLength(beforeNextRound);
			expect(game.store.list().matches).toHaveLength(1);
			if (completionCommitGap) {
				// Recreate the durable boundary where the match's guard stop was
				// committed, but the channel still owns it until finished() commits.
				const record = game.channel.store.read();
				record.snapshot = {
					...record.snapshot,
					revision: record.snapshot.revision + 1,
					enabled: true,
					phase: "running",
					currentMatchId: id,
					lastMatchId: null,
					nextStartAt: null,
					error: null,
				};
				game.channel.store.write(record);
			}
			await game.close();

			game = startServer(options);
			await game.ready;
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(game.channel.snapshot()).toMatchObject({
				enabled: true,
				phase: "countdown",
				currentMatchId: null,
				lastMatchId: id,
				nextStartAt: expect.any(Number),
				error: protectedState.error,
			});
			expect(game.store.get(id).seq).toBe(savedSeq);
			expect(calls).toHaveLength(beforeNextRound);
			cookie = await login();
			const replay = await (
				await post(
					"commands",
					{ requestId: "enable-original", enabled: true },
					cookie,
				)
			).json();
			expect(replay.state).toMatchObject({ enabled: true, phase: "countdown" });
			expect(calls).toHaveLength(beforeNextRound);
			await vi.waitFor(
				() => {
					expect(calls).toHaveLength(beforeNextRound + 1);
					expect(game.channel.snapshot().phase).toBe("running");
					expect(game.channel.snapshot().currentMatchId).not.toBe(id);
				},
				{ timeout: 5000 },
			);
			const nextId = game.channel.snapshot().currentMatchId!;
			expect(game.store.get(nextId).tick).toBe(0);
			expect(game.store.list().matches).toHaveLength(2);
			await post(
				"commands",
				{ requestId: "drain-new-round", enabled: false },
				cookie,
			);
			expect(game.channel.snapshot().phase).toBe("draining");
			holdNextRound = false;
			for (const resume of release) resume();
			await vi.waitFor(
				() => expect(game.channel.snapshot().phase).toBe("stopped"),
				{ timeout: 5000 },
			);
			expect(game.store.get(nextId)).toMatchObject({
				tick: 2,
				endReason: "stagnation_no_apple",
			});
			expect(calls).toHaveLength(beforeNextRound + 2);
			await new Promise((resolve) => setTimeout(resolve, 550));
			expect(game.channel.snapshot()).toMatchObject({
				enabled: false,
				phase: "stopped",
				nextStartAt: null,
			});
			expect(game.store.list().matches).toHaveLength(2);
		} finally {
			await game.close();
			vi.unstubAllGlobals();
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

test.each([false, true])(
	"repeated-position protection still pauses scheduling across restart (completion commit gap=%s)",
	async (completionCommitGap) => {
		const directory = mkdtempSync(join(tmpdir(), "snake-watch-loop-"));
		const transport = globalThis.fetch;
		const calls: DecisionRequestV16[] = [];
		const cycle: Direction[] = ["right", "down", "left", "up"];
		vi.stubGlobal(
			"fetch",
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				if (String(input) !== JEV_PROVIDERS.typesafe.endpoint)
					return transport(input, init);
				const body = JSON.parse(init!.body as string) as DecisionRequestV16;
				calls.push(body);
				const choice = cycle[body.state.timing.observedTick % cycle.length];
				expect(Object.hasOwn(body.questions.direction.criteria, choice)).toBe(
					true,
				);
				expect(body.state.moveFacts[choice]!.eatsApple).toBe(false);
				return Response.json({
					model: "test-only-loop-transport",
					answers: {
						direction: {
							type: "choice",
							choice,
							confidence: 1,
							probabilities: Object.fromEntries(
								Object.keys(body.questions.direction.criteria).map(
									(direction) => [direction, direction === choice ? 1 : 0],
								),
							),
						},
					},
				});
			},
		);
		const options = {
			path: join(directory, "game.sqlite"),
			port: 0,
			adminToken: "watch-loop-admin".repeat(3),
			watch: {
				jev: jevConfig({
					TYPESAFE_API_KEY: "test-only-model-key",
					JEV_STAGNATION_MAX_VISITS: "2",
					JEV_STAGNATION_MAX_NO_APPLE_MOVES: "100",
				}),
				makeConfig: () =>
					gameConfig(
						{},
						{
							width: "8",
							height: "8",
							obstacles: "0",
							seed: "watch-loop-fault",
						},
					),
				intermissionMs: 10,
				log: () => {},
			},
		};
		let game = startServer(options);
		try {
			await game.ready;
			game.channel.command({ requestId: "start-loop", enabled: true });
			await vi.waitFor(
				() => expect(game.channel.snapshot().phase).toBe("fault"),
				{ timeout: 5000 },
			);
			const snapshot = game.channel.snapshot();
			const id = snapshot.lastMatchId!;
			expect(snapshot).toMatchObject({
				enabled: false,
				currentMatchId: null,
				nextStartAt: null,
				error: {
					code: "stagnation_loop",
					message: stagnationMessage("stagnation_loop"),
				},
			});
			expect(game.store.get(id)).toMatchObject({
				status: "interrupted",
				endReason: "stagnation_loop",
				tick: 7,
			});
			expect(calls).toHaveLength(7);
			const events = game.store.events(id, -1).events;
			expect(events.at(-1)?.data.guard).toMatchObject({
				reason: "stagnation_loop",
				observedTick: 7,
				positionVisits: 2,
				maxPositionVisits: 2,
			});
			expect(
				events.filter((event) => event.type === "action_rejected"),
			).toHaveLength(0);
			if (completionCommitGap) {
				const record = game.channel.store.read();
				record.snapshot = {
					...record.snapshot,
					revision: record.snapshot.revision + 1,
					enabled: true,
					phase: "running",
					currentMatchId: id,
					lastMatchId: null,
					error: null,
				};
				game.channel.store.write(record);
			}
			await game.close();
			game = startServer(options);
			await game.ready;
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(game.channel.snapshot()).toMatchObject({
				enabled: false,
				phase: "fault",
				currentMatchId: null,
				lastMatchId: id,
				error: snapshot.error,
			});
			expect(calls).toHaveLength(7);
			expect(game.store.list().matches).toHaveLength(1);
		} finally {
			await game.close();
			vi.unstubAllGlobals();
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

test("protection end reasons distinguish pausing repeated loops from ending a no-apple round", () => {
	expect(reasonName("stagnation_loop")).toBe("费用保护：重复无果循环，已暂停");
	expect(reasonName("stagnation_no_apple")).toBe("长时间未吃苹果，结束本局");
	expect(stagnationMessage("stagnation_no_apple")).toContain(
		"连续观战开启时会自动开始下一局",
	);
});
