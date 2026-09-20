import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { jevConfig, JEV_PROVIDERS } from "../server/jev/config.js";
import { gameConfig } from "../server/jev/game-config.js";
import { startServer } from "../server/start.js";
import type { DecisionRequestV15 } from "../shared/snake/types.js";

test.each([false, true])(
	"an authorized immediate stop cancels in-flight JEV, persists across restart and only resumes on a new enable (late response=%s)",
	async (lateResponse) => {
		const directory = mkdtempSync(join(tmpdir(), "snake-immediate-stop-"));
		const transport = globalThis.fetch;
		const calls: {
			body: DecisionRequestV15;
			signal: AbortSignal | null | undefined;
			release: () => void;
		}[] = [];
		let aborts = 0;
		vi.stubGlobal(
			"fetch",
			(input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				if (String(input) !== JEV_PROVIDERS.typesafe.endpoint)
					return transport(input, init);
				const body = JSON.parse(init!.body as string) as DecisionRequestV15;
				return new Promise<Response>((resolve, reject) => {
					const choice = Object.keys(body.questions.direction.criteria)[0];
					calls.push({
						body,
						signal: init?.signal,
						release: () =>
							resolve(
								Response.json({
									model: "test-only-stop-transport",
									answers: {
										direction: {
											type: "choice",
											choice,
											confidence: 1,
											probabilities: Object.fromEntries(
												Object.keys(body.questions.direction.criteria).map(
													(direction) => [
														direction,
														direction === choice ? 1 : 0,
													],
												),
											),
										},
									},
								}),
							),
					});
					init?.signal?.addEventListener(
						"abort",
						() => {
							aborts++;
							if (!lateResponse) reject(init.signal?.reason);
						},
						{ once: true },
					);
				});
			},
		);
		const secret = "test-owner-stop-credential".repeat(2);
		const origin = "http://localhost:3000";
		const options = {
			path: join(directory, "game.sqlite"),
			port: 0,
			adminToken: secret,
			watch: {
				jev: jevConfig({ TYPESAFE_API_KEY: "test-only-model-key" }),
				makeConfig: () =>
					gameConfig(
						{},
						{ width: "8", height: "8", obstacles: "0", seed: "immediate-stop" },
					),
				intermissionMs: 10,
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
		const post = (
			path: string,
			body: unknown,
			cookie?: string,
			requestOrigin = origin,
		) =>
			transport(`${base()}/api/watch-admin/${path}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: requestOrigin,
					...(cookie ? { Cookie: cookie } : {}),
				},
				body: JSON.stringify(body),
			});
		const login = async () => {
			const response = await post("session", { password: secret });
			expect(response.status).toBe(200);
			return response.headers.get("set-cookie")!.split(";")[0];
		};
		const stop = {
			requestId: "stop-active-request",
			enabled: false,
			stopCurrent: true,
		};
		try {
			await game.ready;
			expect((await post("commands", stop)).status).toBe(401);
			let cookie = await login();
			expect(
				(await post("commands", stop, cookie, "http://other.test")).status,
			).toBe(403);
			expect(
				(
					await post(
						"commands",
						{ requestId: "start-original", enabled: true },
						cookie,
					)
				).status,
			).toBe(200);
			await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 5000 });
			const id = game.channel.snapshot().currentMatchId!;
			const before = game.store.get(id);
			expect(before.status).toBe("running");
			const generation = game.channel.store.read().generation;
			const response = await post("commands", stop, cookie);
			expect(response.status).toBe(200);
			const stopped = await response.json();
			expect(stopped.state).toMatchObject({
				enabled: false,
				phase: "stopped",
				currentMatchId: null,
				lastMatchId: id,
				nextStartAt: null,
				error: null,
			});
			expect(game.channel.store.read().generation).toBe(generation + 1);
			await vi.waitFor(() => expect(calls[0].signal?.aborted).toBe(true));
			expect(aborts).toBe(1);
			calls[0].release();
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(calls).toHaveLength(1);
			expect(game.store.get(id)).toMatchObject({
				status: "interrupted",
				endReason: "controller_stop",
				tick: before.tick,
				snake: before.snake,
				score: before.score,
			});
			const events = game.store.events(id, -1).events;
			expect(
				events.filter((event) => event.type === "action_rejected"),
			).toHaveLength(0);
			expect(
				events.filter((event) => event.type === "interrupted"),
			).toHaveLength(1);
			expect(
				events.some((event) =>
					["action_accepted", "moved", "gameover", "won"].includes(event.type),
				),
			).toBe(false);
			const seq = game.store.get(id).seq;
			expect(
				(await (await post("commands", stop, cookie)).json()).receipt,
			).toEqual(stopped.receipt);
			expect(game.store.get(id).seq).toBe(seq);
			expect(aborts).toBe(1);
			expect(
				(
					await post(
						"commands",
						{ requestId: stop.requestId, enabled: false },
						cookie,
					)
				).status,
			).toBe(409);
			expect(game.store.list().matches).toHaveLength(1);
			await game.close();

			game = startServer(options);
			await game.ready;
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(game.channel.snapshot()).toMatchObject({
				enabled: false,
				phase: "stopped",
				currentMatchId: null,
				lastMatchId: id,
			});
			expect(game.store.get(id)).toMatchObject({
				status: "interrupted",
				endReason: "controller_stop",
				tick: before.tick,
			});
			expect(calls).toHaveLength(1);
			cookie = await login();
			expect(
				(await (await post("commands", stop, cookie)).json()).receipt,
			).toEqual(stopped.receipt);
			expect(
				(
					await (
						await post(
							"commands",
							{ requestId: "start-original", enabled: true },
							cookie,
						)
					).json()
				).state.phase,
			).toBe("stopped");
			expect(
				(
					await post(
						"commands",
						{ requestId: "explicit-new-round", enabled: true },
						cookie,
					)
				).status,
			).toBe(200);
			await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 5000 });
			expect(game.channel.snapshot().currentMatchId).not.toBe(id);
			expect(game.store.list().matches).toHaveLength(2);
			game.channel.command({
				requestId: "cleanup",
				enabled: false,
				stopCurrent: true,
			});
		} finally {
			for (const call of calls) call.release();
			await game.close();
			vi.unstubAllGlobals();
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
