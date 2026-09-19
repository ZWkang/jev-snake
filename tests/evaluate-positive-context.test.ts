import { expect, test, vi } from "vitest";
import { evaluatePositiveContext } from "../scripts/evaluate-positive-context.js";
import { ProgressHistory } from "../server/jev/progress.js";
import { publicState } from "../shared/snake/types.js";
import { baseState } from "./context-fixture.js";

const env = {
	JEV_PROVIDER: "typesafe",
	JEV_MODEL: "jev-positive-test",
	TYPESAFE_API_KEY: "positive-test-private-key",
};

test("default evaluation is offline and separates actual geometry evidence from model performance", async () => {
	const transport = vi
		.fn<typeof fetch>()
		.mockRejectedValue(new Error("network forbidden"));
	const report = await evaluatePositiveContext({
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
		results: [],
	});
	expect(report.cases).toHaveLength(4);
	for (const entry of report.cases) {
		expect(entry.v3.request.state.contextVersion).toBe("action-facts-v3");
		expect(entry.v4.request.state.contextVersion).toBe("action-facts-v4");
		expect(entry.progress).toEqual({ status: "not_provided", value: null });
		expect(entry.v3.request.state).not.toHaveProperty("progress");
		expect(entry.v4.request.state).not.toHaveProperty("progress");
		for (const version of ["v3", "v4"] as const) {
			expect(entry[version].contextBuildMs.samples).toBe(2);
			expect(entry[version].contextBuildMs.p95).toBeGreaterThanOrEqual(
				entry[version].contextBuildMs.p50,
			);
			expect(entry[version].requestBytes).toBe(
				Buffer.byteLength(JSON.stringify(entry[version].request), "utf8"),
			);
		}
		expect(entry.byteDelta).toBe(entry.v4.requestBytes - entry.v3.requestBytes);
		expect(entry.v4.request).not.toHaveProperty("evidence");
		expect(entry.v4.evidenceBytes).toBe(
			Buffer.byteLength(JSON.stringify(entry.v4.evidence), "utf8"),
		);
		for (const comparison of Object.values(entry.comparisons)) {
			expect(comparison.v3.opportunity).toBeNull();
			expect(comparison.v4.opportunity.status).toBeTruthy();
			if (comparison.witness)
				expect(comparison.witness.moves).toBe(comparison.v4.opportunity.moves);
		}
	}
	const replay = report.cases.find(
		(entry) => entry.fixture === "release_trap_529dd",
	);
	expect(replay?.source).toContain("Recorded geometry only");
	expect(replay?.comparisons.up.v3.appleRouteStatus).toBe("no_static_path");
	expect(replay?.comparisons.up.v4.opportunity.status).toBe(
		"apple_route_found",
	);
	expect(replay?.comparisons.up.witness?.releasePassages).toContainEqual({
		point: { x: 11, y: 6 },
		originalBodyIndex: 39,
		earliestReleaseStep: 11,
		enteredAtStep: 11,
	});
	expect(JSON.stringify(report)).not.toContain(env.TYPESAFE_API_KEY);
});

test("only supplied committed history is included, identically for both inputs", async () => {
	const state = publicState(baseState());
	const history = new ProgressHistory();
	history.observe(state);
	const progress = history.snapshot(state);
	const report = await evaluatePositiveContext({
		samples: 1,
		env,
		progressByFixture: { opening: progress },
	});
	const opening = report.cases.find((entry) => entry.fixture === "opening");
	expect(opening?.progress).toEqual({ status: "provided", value: progress });
	expect(opening?.v3.request.state.progress).toEqual(progress);
	expect(opening?.v4.request.state.progress).toEqual(progress);
	expect(
		report.cases
			.filter((entry) => entry.fixture !== "opening")
			.every((entry) => entry.progress.status === "not_provided"),
	).toBe(true);
});

test("explicit live comparison makes exactly eight serial production-contract calls and keeps failed and unsafe choices", async () => {
	let inFlight = 0;
	let maxInFlight = 0;
	const bodies: unknown[] = [];
	const transport = vi
		.fn<typeof fetch>()
		.mockImplementation(async (_url, init) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			const body = JSON.parse(init?.body as string);
			bodies.push(body);
			await Promise.resolve();
			inFlight--;
			if (bodies.length === 1)
				return new Response(`unavailable ${env.TYPESAFE_API_KEY}`, {
					status: 503,
				});
			return Response.json({
				model: "provider-model",
				answers: {
					direction: {
						type: "choice",
						choice: bodies.length === 2 ? "diagonal" : "left",
						probabilities: { up: 0, right: 0, down: 0, left: 1 },
						confidence: 0.9,
					},
				},
				usage: {
					input_tokens: 43,
					output_tokens: 12,
					cost: 0.001,
					currency: "USD",
				},
			});
		});
	const recorded: unknown[] = [];
	const report = await evaluatePositiveContext({
		live: true,
		samples: 1,
		env,
		fetch: transport,
		onLiveResult: (result) => {
			recorded.push(result);
		},
	});
	expect(transport).toHaveBeenCalledTimes(8);
	expect(maxInFlight).toBe(1);
	expect(recorded).toHaveLength(8);
	expect(report.live).toMatchObject({
		plannedRequests: 8,
		completedRequests: 8,
		failedRequests: 2,
	});
	expect(report.live.results[0].responseText).toBe("unavailable [redacted]");
	expect(report.live.results[0].error).toContain("503");
	expect(report.live.results[1].error).toContain("Invalid JEV");
	for (const [index, result] of report.live.results.entries()) {
		expect(result.request).toEqual(bodies[index]);
		expect(result.startedAt).not.toBe("");
		expect(result.finishedAt).not.toBe("");
		if (result.status === "ok") {
			expect(result.decision?.choice).toBe("left");
			expect(result.decision?.request).toEqual(bodies[index]);
			expect(result.decision?.inputTokens).toBe(43);
			expect(result.decision?.requestMs).toBeGreaterThanOrEqual(0);
			expect(result.providerUsage).toEqual({
				input_tokens: 43,
				output_tokens: 12,
				cost: 0.001,
				currency: "USD",
			});
			expect(result.responseText).toContain("provider-model");
		}
	}
	expect(JSON.stringify(report)).not.toContain(env.TYPESAFE_API_KEY);
});

test("bad measurement counts and missing live credentials fail before networking", async () => {
	const transport = vi.fn<typeof fetch>();
	await expect(
		evaluatePositiveContext({ samples: 0, env, fetch: transport }),
	).rejects.toThrow("positive integer");
	await expect(
		evaluatePositiveContext({
			live: true,
			samples: 1,
			env: { ...env, TYPESAFE_API_KEY: "" },
			fetch: transport,
		}),
	).rejects.toThrow("TYPESAFE_API_KEY");
	expect(transport).not.toHaveBeenCalled();
});
