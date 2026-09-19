import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { evaluateOutcomeContext } from "../scripts/evaluate-outcome-context.js";
import fixtures from "./fixtures/outcome-input-regressions.json" with { type: "json" };

const env = {
	JEV_PROVIDER: "typesafe",
	JEV_MODEL: "jev-outcome-test",
	TYPESAFE_API_KEY: "outcome-test-private-key",
};

test("offline evaluation freezes the real failing v4 requests including their history and preserves actual observation timing", async () => {
	const transport = vi
		.fn<typeof fetch>()
		.mockRejectedValue(new Error("Network is forbidden"));
	const report = await evaluateOutcomeContext({
		env: { ...env, TYPESAFE_API_KEY: "" },
		fetch: transport,
	});
	expect(transport).not.toHaveBeenCalled();
	expect(report.mode).toBe("offline");
	expect(report.repeats).toBe(3);
	expect(report.cases).toHaveLength(5);
	expect(report.live).toMatchObject({
		enabled: false,
		plannedRequests: 0,
		completedRequests: 0,
		results: [],
	});
	const recordedHashes = [
		"48258aa2a9caab7d931663ebf3746519c07e1970506aa515d60ffd1f672d8b3e",
		"fec015b3f518d7f378e2b153f1d6095a2052d8a54ee49325ef38fdc59d4f08cd",
	];
	for (const [index, entry] of report.cases.entries()) {
		const fixture = fixtures.cases[index];
		expect(entry.v4.recordedRequest).toEqual(fixture.recordedRequest);
		expect(entry.v4.request).toEqual({
			...fixture.recordedRequest,
			model: env.JEV_MODEL,
		});
		expect(entry.v4.contextBuildMs).toBeNull();
		expect(entry.v5.contextBuildMs).toBeGreaterThanOrEqual(0);
		expect(entry.v5.request.state.contextVersion).toBe("action-outcomes-v5");
		expect(entry.v5.request.state).not.toHaveProperty("witnessContinuity");
		expect(entry.observation).not.toHaveProperty("lastDecision");
		expect(entry.observation).not.toHaveProperty("lastAppliedAction");
		expect(entry.v5.request.state.timing).toEqual(
			entry.v4.recordedRequest.state.timing,
		);
		expect(entry.v5.request.state.progress ?? null).toEqual(fixture.progress);
		for (const version of ["v4", "v5"] as const)
			expect(entry[version].requestBytes).toBe(
				Buffer.byteLength(JSON.stringify(entry[version].request), "utf8"),
			);
		if (index < 2) {
			expect(entry.source.kind).toBe("historical_request");
			expect(
				createHash("sha256")
					.update(JSON.stringify(entry.v4.recordedRequest))
					.digest("hex"),
			).toBe(recordedHashes[index]);
			expect(entry.v4.request.state.witnessContinuity).toHaveLength(1);
			expect(entry.v4.request.state.witnessContinuity[0]).toHaveProperty(
				"nextDirection",
				index === 0 ? "up" : "left",
			);
		}
	}
	expect(report.cases[2].source.kind).toBe("reconstructed_v4");
	expect(report.cases[2].source.description).toContain(
		"NOT the historical provider request",
	);
	expect(report.cases[3].source.kind).toBe("synthetic_control");
	expect(report.cases[4].source.kind).toBe("synthetic_control");
	expect(
		report.cases[0].v5.request.questions.direction.criteria.up.survival,
	).toMatchObject({ status: "proven_fatal", collisionWithinMoves: 13 });
	expect(
		report.cases[1].v5.request.questions.direction.criteria.left.survival,
	).toMatchObject({ status: "proven_fatal", collisionWithinMoves: 3 });
});

test("live evaluation alternates thirty serial production-contract requests and preserves errors and known-bad choices", async () => {
	let inFlight = 0;
	let maxInFlight = 0;
	const requests: unknown[] = [];
	const transport = vi
		.fn<typeof fetch>()
		.mockImplementation(async (_url, init) => {
			inFlight++;
			maxInFlight = Math.max(inFlight, maxInFlight);
			const request = JSON.parse(init?.body as string);
			requests.push(request);
			await Promise.resolve();
			inFlight--;
			if (requests.length === 1)
				return new Response(`Unavailable ${env.TYPESAFE_API_KEY}`, {
					status: 503,
				});
			const choice =
				["unused", "diagonal", "right", "left", "up", "down"][
					requests.length - 1
				] ?? (request.state.board.height === 1 ? "right" : "left");
			const probabilities = { up: 0.1, right: 0.2, down: 0.3, left: 0.4 };
			return Response.json({
				model: "resolved-provider-model",
				answers: {
					direction: { type: "choice", choice, probabilities, confidence: 0.4 },
				},
				usage: {
					input_tokens: 123,
					output_tokens: 4,
					cost: 0.001,
					currency: "USD",
				},
			});
		});
	const streamed: unknown[] = [];
	const report = await evaluateOutcomeContext({
		live: true,
		env,
		fetch: transport,
		onLiveResult: (result) => {
			streamed.push(result);
		},
	});
	expect(transport).toHaveBeenCalledTimes(30);
	expect(maxInFlight).toBe(1);
	expect(streamed).toHaveLength(30);
	expect(report.live).toMatchObject({
		enabled: true,
		plannedRequests: 30,
		completedRequests: 30,
		failedRequests: 2,
	});
	for (let offset = 0; offset < 30; offset += 6) {
		expect(
			report.live.results
				.slice(offset, offset + 6)
				.map((result) => result.version),
		).toEqual(["v4", "v5", "v5", "v4", "v4", "v5"]);
		expect(
			report.live.results
				.slice(offset, offset + 6)
				.map((result) => result.repeat),
		).toEqual([1, 1, 2, 2, 3, 3]);
	}
	const [failed, invalid, reverse, collision, fatal, unknown] =
		report.live.results;
	expect(failed.status).toBe("error");
	expect(failed.responseText).toBe("Unavailable [redacted]");
	expect(failed.responseParseError).toBeTruthy();
	expect(failed.error).toContain("503");
	expect(invalid.status).toBe("error");
	expect(invalid.rawChoice).toBe("diagonal");
	expect(invalid.responseText).toContain("diagonal");
	expect(invalid.resolvedModel).toBe("resolved-provider-model");
	expect(invalid.inputTokens).toBe(123);
	expect(invalid.selectedSurvivalStatus).toBeNull();
	expect(reverse.knownBadChoice).toBe("illegal_reverse");
	expect(collision.knownBadChoice).toBe("immediate_collision");
	expect(fatal.knownBadChoice).toBe("proven_fatal");
	expect(unknown).toMatchObject({
		selectedSurvivalStatus: "not_proven_fatal",
		knownBadChoice: null,
		choiceProbability: 0.3,
	});
	for (const [index, result] of report.live.results.entries()) {
		expect(result.request).toEqual(requests[index]);
		expect(result.requestMs).toBeGreaterThanOrEqual(0);
		expect(result.startedAt).not.toBe("");
		expect(result.finishedAt).not.toBe("");
		if (result.status === "ok") {
			expect(result.decision?.choice).toBe(result.rawChoice);
			expect(result.inputTokens).toBe(123);
			expect(result.providerUsage).toEqual({
				input_tokens: 123,
				output_tokens: 4,
				cost: 0.001,
				currency: "USD",
			});
			if (result.version === "v4")
				expect(result.decision).not.toHaveProperty("contextBuildMs");
			else expect(result.decision?.contextBuildMs).toBe(result.contextBuildMs);
		}
	}
	expect(JSON.stringify(report)).not.toContain(env.TYPESAFE_API_KEY);
});

test("explicit evaluation parameters and credentials are checked before any network request", async () => {
	const transport = vi.fn<typeof fetch>();
	await expect(
		evaluateOutcomeContext({ repeats: 0, env, fetch: transport }),
	).rejects.toThrow("positive integer");
	await expect(
		evaluateOutcomeContext({
			live: true,
			env: { ...env, TYPESAFE_API_KEY: "" },
			fetch: transport,
		}),
	).rejects.toThrow("TYPESAFE_API_KEY");
	expect(transport).not.toHaveBeenCalled();
});
