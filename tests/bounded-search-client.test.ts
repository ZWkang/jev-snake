import { expect, test, vi } from "vitest";
import { sendJevRequest } from "../server/jev/client.js";
import { jevConfig } from "../server/jev/config.js";
import { offlineSearchConfig } from "../server/jev/search-config.js";
import {
	decisionBodyV10 as decisionBody,
	decisionBodyV8,
} from "../server/jev/search-context.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import type { PublicState } from "../shared/snake/types.js";
import cases from "./fixtures/global-view-73882.json";

test("search options are validated only for explicit offline experiments", () => {
	expect(offlineSearchConfig({})).toEqual({ maxDepth: 32, maxNodes: 5000 });
	expect(
		offlineSearchConfig({ JEV_SEARCH_DEPTH: "6", JEV_SEARCH_NODES: "0" }),
	).toEqual({ maxDepth: 6, maxNodes: 0 });
	for (const env of [
		{ JEV_SEARCH_DEPTH: "0" },
		{ JEV_SEARCH_DEPTH: "NaN" },
		{ JEV_SEARCH_NODES: "-1" },
		{ JEV_SEARCH_NODES: "1.5" },
		{ JEV_SEARCH_NODES: "9007199254740992" },
	])
		expect(() => offlineSearchConfig(env)).toThrow(/JEV_/);
});

test("bounded evidence reaches the saved model request without replacing a proven-dead choice", async () => {
	const state = cases[2].state as PublicState;
	const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
		Response.json({
			model: "returned-model",
			answers: {
				direction: {
					type: "choice",
					choice: "up",
					probabilities: { up: 1, right: 0, down: 0, left: 0 },
					confidence: 1,
				},
			},
		}),
	);
	const { decision } = await sendJevRequest("test-key", decisionBody(state), {
		fetch,
	});
	const sent = JSON.parse(fetch.mock.calls[0][1]!.body as string);
	expect(sent.state.contextVersion).toBe("post-apple-v10");
	expect(sent.state.localSearch.moves.up.status).toBe("proven_dead");
	expect(sent.state.localSearch.moves.left.status).toBe("apple_reachable");
	expect(Object.keys(sent.questions.direction.criteria)).toEqual([
		"up",
		"right",
		"down",
		"left",
	]);
	expect(decision.choice).toBe("up");
	expect(decision.request).toEqual(sent);
	expect(decisionRequestSchema.parse(sent)).toEqual(sent);
	const { decision: baseline } = await sendJevRequest(
		"test-key",
		decisionBodyV8(state),
		{ fetch },
	);
	expect(baseline.request).toEqual(decisionBodyV8(state));
	expect(baseline.request?.state).not.toHaveProperty("localSearch");
});

test("zero budget remains explicit uncertainty, never a hidden fallback", () => {
	const request = decisionBody(
		cases[0].state as PublicState,
		undefined,
		undefined,
		undefined,
		{ maxDepth: 8, maxNodes: 0 },
	);
	expect(request.state.contextVersion).toBe("post-apple-v10");
	expect(request.state.localSearch.moves.up).toMatchObject({
		status: "unknown",
		cutoff: "nodes",
		witness: null,
		expandedNodes: 0,
	});
	expect(decisionRequestSchema.parse(request)).toEqual(request);
});

test("legacy search settings cannot enable search in the live configuration", () => {
	expect(
		jevConfig({
			JEV_LOCAL_SEARCH: "true",
			JEV_SEARCH_DEPTH: "32",
			JEV_SEARCH_NODES: "5000",
		}),
	).toEqual(jevConfig({}));
	expect(jevConfig({})).not.toHaveProperty("localSearch");
});
