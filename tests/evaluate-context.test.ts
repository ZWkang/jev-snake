import { expect, test, vi } from "vitest";
import { evaluateContext } from "../scripts/evaluate-context.js";

const env = {
	JEV_PROVIDER: "typesafe",
	JEV_MODEL: "jev-evaluation-test",
	TYPESAFE_API_KEY: "eval-private-key",
};
test("offline evaluation never calls a provider and reports measured costs, baseline gaps, and raw inputs", async () => {
	const transport = vi
		.fn<typeof fetch>()
		.mockRejectedValue(new Error("network forbidden"));
	const report = await evaluateContext({
		samples: 2,
		env: { ...env, TYPESAFE_API_KEY: "" },
		fetch: transport,
	});
	expect(transport).not.toHaveBeenCalled();
	expect(report.mode).toBe("offline");
	expect(report.live).toMatchObject({
		enabled: false,
		plannedRequests: 0,
		completedRequests: 0,
	});
	expect(report.cases).toHaveLength(6);
	expect(report.responseCosts).toHaveLength(3);
	for (const entry of report.cases) {
		expect(entry.v2.contextBuildMs).toBeNull();
		expect(entry.v3.contextBuildMs.samples).toBe(2);
		expect(entry.v3.contextBuildMs.p95).toBeGreaterThanOrEqual(
			entry.v3.contextBuildMs.p50,
		);
		expect(entry.v3.requestBytes).toBe(
			Buffer.byteLength(JSON.stringify(entry.v3.request), "utf8"),
		);
		expect(entry.byteDelta).toBe(entry.v3.requestBytes - entry.v2.requestBytes);
		expect(entry.v3.request.state.player).not.toHaveProperty("bodyHeadToTail");
		expect(entry.v3.request.state.board).not.toHaveProperty("obstacles");
	}
	expect(JSON.stringify(report)).not.toContain("eval-private-key");
});

test("explicit live evaluation sends twelve serial requests through the production contract and records errors without replacement", async () => {
	let inFlight = 0,
		maxInFlight = 0;
	const bodies: unknown[] = [];
	const transport = vi
		.fn<typeof fetch>()
		.mockImplementation(async (_url, init) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			const body = JSON.parse(init?.body as string);
			bodies.push(body);
			await new Promise((resolve) => setTimeout(resolve, 1));
			inFlight--;
			if (bodies.length === 1)
				return new Response("upstream eval-private-key failed", {
					status: 503,
				});
			const key = body.questions.plan ? "plan" : "direction";
			const choice = key === "plan" ? "right_right" : "right";
			return Response.json({
				model: "provider-model",
				answers: {
					[key]: {
						type: "choice",
						choice: bodies.length === 2 ? "diagonal" : choice,
						probabilities: Object.fromEntries(
							Object.keys(body.questions[key].criteria).map((c) => [
								c,
								c === choice ? 1 : 0,
							]),
						),
						confidence: 0.9,
					},
				},
				usage: { input_tokens: 45 },
			});
		});
	const report = await evaluateContext({
		live: true,
		samples: 1,
		env,
		fetch: transport,
	});
	expect(transport).toHaveBeenCalledTimes(12);
	expect(maxInFlight).toBe(1);
	expect(report.live.completedRequests).toBe(12);
	expect(report.live.failedRequests).toBe(2);
	expect(report.live.results[0].error).toContain("503");
	expect(report.live.results[0].responseText).toBe(
		"upstream [redacted] failed",
	);
	expect(report.live.results[1].error).toContain("Invalid JEV");
	for (const [i, result] of report.live.results.entries()) {
		expect(result.request).toEqual(bodies[i]);
		expect(result.provider).toBe("typesafe");
		expect(result.model).toBe("jev-evaluation-test");
		expect(result.startedAt).not.toBe("");
		expect(result.finishedAt).not.toBe("");
		if (result.status === "ok") {
			expect(result.decision?.request).toEqual(bodies[i]);
			expect(result.decision?.inputTokens).toBe(45);
			expect(result.decision?.requestMs).toBeGreaterThanOrEqual(0);
			expect(result.responseText).toContain("provider-model");
			expect(result.selectedEvidence).toBeDefined();
		}
	}
	expect(JSON.stringify(report)).not.toContain("eval-private-key");
});

test("invalid samples and a missing live credential fail explicitly before any network call", async () => {
	const transport = vi.fn<typeof fetch>();
	await expect(
		evaluateContext({ samples: 0, env, fetch: transport }),
	).rejects.toThrow("positive integer");
	await expect(
		evaluateContext({
			live: true,
			env: { ...env, TYPESAFE_API_KEY: "" },
			fetch: transport,
		}),
	).rejects.toThrow("TYPESAFE_API_KEY");
	expect(transport).not.toHaveBeenCalled();
});
