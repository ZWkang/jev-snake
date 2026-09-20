import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { createApp } from "../server/app.js";
import { Store } from "../server/db/store.js";
import { askJev, decisionBody } from "../server/jev/client.js";
import { jevConfig, JEV_PROVIDERS } from "../server/jev/config.js";
import { gameConfig } from "../server/jev/game-config.js";
import { MatchService } from "../server/matches/service.js";
import { decisionSchema } from "../shared/snake/schema.js";
import type {
	Decision,
	Direction,
	MatchEvent,
	PublicState,
} from "../shared/snake/types.js";
import { decisionForPosition } from "../src/features/snake/replay.js";

test("retired Laya cannot be selected as a runtime provider", () => {
	expect(() => jevConfig({ JEV_PROVIDER: "laya" })).toThrow(
		"JEV_PROVIDER must be typesafe or openrouter",
	);
	expect(Object.keys(JEV_PROVIDERS)).toEqual(["typesafe", "openrouter"]);
	for (const provider of ["typesafe", "openrouter"] as const) {
		const configured = jevConfig({
			JEV_PROVIDER: provider,
			LAYA_ENDPOINT: "http://localhost:3002/v1/systemone",
		});
		expect(configured.endpoint).toBe(JEV_PROVIDERS[provider].endpoint);
		expect(configured.apiKey).toBe("");
	}
});

test("saved Laya decisions remain readable and replayable with no local provider installed", async () => {
	const store = new Store(":memory:");
	const service = new MatchService(store, Date.now, false);
	try {
		const initial = service.create({
			requestId: randomUUID(),
			controlToken: "archive-test-control".repeat(3),
			agentName: "Laya 本地连续观战",
			model: "laya-typed-decisions",
			config: gameConfig(
				{},
				{ width: "8", height: "8", obstacles: "0", seed: "laya-archive-test" },
			),
		});
		service.command(initial.id, {
			protocolVersion: 1,
			requestId: randomUUID(),
			type: "start",
		});
		const context = service.decisionContext(initial.id);
		const request = decisionBody(context.state, "laya-typed-decisions");
		const offered = Object.keys(
			request.questions.direction.criteria,
		) as Direction[];
		const decision: Decision = {
			provider: "laya",
			model: "laya-typed-decisions",
			choice: offered[0],
			probabilities: Object.fromEntries(
				offered.map((direction, i) => [direction, i === 0 ? 1 : 0]),
			),
			confidence: 1,
			requestMs: 123,
			inputTokens: 456,
			request,
		};
		expect(decisionSchema.parse(decision)).toEqual(decision);
		service.command(initial.id, {
			protocolVersion: 1,
			type: "action",
			requestId: randomUUID(),
			observedSeq: context.observedSeq,
			targetTick: context.targetTick,
			expectedStateHash: context.expectedStateHash,
			direction: decision.choice,
			decision,
		});
		service.command(initial.id, {
			protocolVersion: 1,
			type: "stop",
			requestId: randomUUID(),
			reason: "controller_stop",
		});
		const app = createApp(service, {
			adminToken: "archive-test-admin".repeat(3),
			jevConfigured: false,
		});
		const response = await app.request(`/api/matches/${initial.id}`);
		expect(response.status).toBe(200);
		const archived = (await response.json()) as PublicState;
		expect(archived.lastDecision).toMatchObject(decision);
		const eventsResponse = await app.request(
			`/api/matches/${initial.id}/events`,
		);
		expect(eventsResponse.status).toBe(200);
		const { events } = (await eventsResponse.json()) as {
			events: MatchEvent[];
		};
		expect(decisionForPosition(events, archived)).toMatchObject(decision);
		const transport = vi.fn<typeof fetch>();
		for (const provider of ["typesafe", "openrouter"] as const) {
			await expect(
				askJev("", context.state, { provider, fetch: transport }),
			).rejects.toThrow(JEV_PROVIDERS[provider].keyEnv);
		}
		expect(transport).not.toHaveBeenCalled();
	} finally {
		service.close();
		store.close();
	}
});
