import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { jevConfig, JEV_PROVIDERS } from "../server/jev/config.js";
import { gameConfig } from "../server/jev/game-config.js";
import { startServer } from "../server/start.js";
import type { DecisionRequestV5 } from "../shared/snake/outcome-context.js";
import { directions, type PublicState } from "../shared/snake/types.js";

test("HTTP/WS runner resumes the same saved round after shutdown with a fresh control credential", async () => {
	const dir = mkdtempSync(join(tmpdir(), "snake-http-resume-"));
	const requests: DecisionRequestV5[] = [];
	const transport = globalThis.fetch;
	let allowTick = 0;
	vi.stubGlobal(
		"fetch",
		async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			if (String(input) !== JEV_PROVIDERS.typesafe.endpoint)
				return transport(input, init);
			const body = JSON.parse(init!.body as string) as DecisionRequestV5;
			requests.push(body);
			if (body.state.timing.observedTick > allowTick) {
				await new Promise<void>((_resolve, reject) => {
					if (init?.signal?.aborted) reject(init.signal.reason);
					else
						init?.signal?.addEventListener(
							"abort",
							() => reject(init.signal?.reason),
							{ once: true },
						);
				});
			}
			const choice = directions.find(
				(d) =>
					!(["illegal_reverse", "immediate_collision"] as string[]).includes(
						body.questions.direction.criteria[d].survival.status,
					),
			)!;
			return Response.json({
				model: "test-transport",
				answers: {
					direction: {
						type: "choice",
						choice,
						confidence: 1,
						probabilities: Object.fromEntries(
							directions.map((d) => [d, d === choice ? 1 : 0]),
						),
					},
				},
			});
		},
	);
	const options = {
		path: join(dir, "game.sqlite"),
		port: 0,
		adminToken: "admin".repeat(10),
		watch: {
			jev: jevConfig({ TYPESAFE_API_KEY: "test-key" }),
			makeConfig: () =>
				gameConfig(
					{},
					{ width: "12", height: "9", obstacles: "0", seed: "http-resume" },
				),
			intermissionMs: 5000,
			log: () => {},
		},
	};
	let game = startServer(options);
	try {
		await game.ready;
		game.channel.command({ requestId: randomUUID(), enabled: true });
		await vi.waitFor(
			() => expect(requests.at(-1)?.state.timing.observedTick).toBe(1),
			{ timeout: 5000 },
		);
		const id = game.channel.snapshot().currentMatchId!;
		const before = game.store.get(id);
		const originalTokenHash = game.store.controlHash(id);
		expect(before.tick).toBe(1);
		await game.close();
		allowTick = 1;
		game = startServer(options);
		await game.ready;
		await vi.waitFor(() => expect(game.store.get(id).tick).toBe(2), {
			timeout: 5000,
		});
		await vi.waitFor(
			() => expect(requests.at(-1)?.state.timing.observedTick).toBe(2),
			{ timeout: 5000 },
		);
		expect(game.channel.snapshot().currentMatchId).toBe(id);
		expect(game.store.controlHash(id)).not.toBe(originalTokenHash);
		expect(game.store.list().matches).toHaveLength(1);
		expect(game.store.get(id)).toMatchObject({
			config: before.config,
			startedAt: before.startedAt,
		});
		const address = game.server.address();
		if (!address || typeof address === "string")
			throw new Error("No HTTP port");
		const response = await transport(
			`http://127.0.0.1:${address.port}/api/matches/${id}`,
		);
		expect(response.status).toBe(200);
		expect(((await response.json()) as PublicState).tick).toBe(2);
		expect(requests.map((r) => r.state.timing.observedTick)).toEqual([
			0, 1, 1, 2,
		]);
	} finally {
		await game.close();
		vi.unstubAllGlobals();
		rmSync(dir, { recursive: true, force: true });
	}
});
