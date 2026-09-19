import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { JEV_ENDPOINT } from "../server/jev/client.js";
import { analyzeActions } from "../server/jev/context-v3.js";
import { startServer } from "../server/start.js";
import type {
	DecisionContext,
	DecisionRequestV3,
	PlanRequestV3,
} from "../shared/snake/types.js";

const disposers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function fixture(
	mode:
		| "failure"
		| "fast"
		| "late"
		| "late-error"
		| "rounded"
		| "two-step"
		| "two-error"
		| "two-cancel"
		| "two-signal"
		| "bad-plan"
		| "old-server"
		| "response-fast"
		| "response-slow"
		| "response-reverse"
		| "response-stale"
		| "response-protocol"
		| "response-error"
		| "response-cancel"
		| "response-loop"
		| "response-no-progress"
		| "response-progress-mismatch"
		| "response-rounded" = "failure",
) {
	const dir = mkdtempSync(join(tmpdir(), "snake-jev-runner-"));
	const adminToken = "runner-test-admin".repeat(4);
	const game = startServer({
		path: join(dir, "game.sqlite"),
		adminToken,
		port: 0,
	});
	disposers.push(async () => {
		await game.close();
		rmSync(dir, { recursive: true, force: true });
	});
	if (!game.server.listening) await once(game.server, "listening");
	const address = game.server.address();
	if (!address || typeof address === "string")
		throw new Error("No listening address");
	const root = `http://127.0.0.1:${address.port}`;
	// Only the external API boundary is replaced. The runner, HTTP, WS and DB are real.
	const hook = join(dir, "upstream-failure.mjs");
	writeFileSync(
		hook,
		`import { appendFileSync } from "node:fs";
const originalFetch = globalThis.fetch;
let callNumber = 0;
let requestsInFlight = 0;
let contextCount = 0;
globalThis.fetch = async (input, init) => {
  if (${JSON.stringify(mode)} === "old-server" && String(input).endsWith("/api/health")) return Response.json({protocolVersion:1});
  if (String(input) === ${JSON.stringify(JEV_ENDPOINT)}) {
    callNumber++;
    const body = JSON.parse(init.body);
    appendFileSync(${JSON.stringify(join(dir, "bodies.jsonl"))}, init.body + "\\n");
    const mode = ${JSON.stringify(mode)};
    if (mode.startsWith("response-")) {
      requestsInFlight++;
      if (requestsInFlight !== 1) throw new Error("Concurrent model requests");
      if (!body.questions.direction || body.questions.plan) throw new Error("Response mode must request one direction");
      const before = (await (await originalFetch(${JSON.stringify(`${root}/api/matches`)})).json()).matches[0];
      if (before.tick !== body.state.timing.observedTick) throw new Error("Model request used an unconfirmed position");
      console.log(JSON.stringify({type:"test_transport_started",callNumber,observedTick:before.tick,inFlight:requestsInFlight}));
      const delay = mode === "response-slow" ? [120,470,1770][(callNumber - 1) % 3] : mode === "response-cancel" ? 3000 : 10;
      await new Promise((resolve, reject) => {
        if (init.signal.aborted) { reject(init.signal.reason); return; }
        const timer = setTimeout(resolve, delay);
        init.signal.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal.reason); }, {once:true});
      });
      const after = (await (await originalFetch(${JSON.stringify(`${root}/api/matches`)})).json()).matches[0];
      if (before.tick !== after.tick) throw new Error("Response snake moved while awaiting model");
      requestsInFlight--;
      if (mode === "response-error") return new Response("response-test-upstream-error", {status:503});
      const choice = mode === "response-reverse" && callNumber === 1 ? "left" : mode === "response-loop" && callNumber <= 12 ? ["right","down","left","up"][(callNumber - 1) % 4] : "right";
      return Response.json({model:"test-only-response-mode",answers:{direction:{type:"choice",choice,probabilities:Object.fromEntries(["up","right","down","left"].map(direction => [direction,direction === choice ? (mode === "response-rounded" ? 0.99 : 1) : 0])),confidence:1}}});
    }
    if (body.questions.plan) {
      const mode = ${JSON.stringify(mode)};
      const delay = callNumber === 2 ? (mode === "two-step" || mode === "two-error" ? 835 : 3000) : 10;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        init.signal.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal.reason); }, {once:true});
      });
      if (mode === "two-error" && callNumber === 2) return new Response("two-step-test-error", {status:503});
      const choice = mode === "bad-plan" ? "invalid" : callNumber === 1 && ["two-step","two-error"].includes(mode) ? "right_down" : "right_right";
      return Response.json({model:"test-only-plan-response",answers:{plan:{type:"choice",choice,probabilities:Object.fromEntries(Object.keys(body.questions.plan.criteria).map(c=>[c,c===choice?1:0])),confidence:1}}});
    }
    if (${JSON.stringify(mode)} === "failure")
      return new Response("runner-test-upstream-unavailable", { status: 503 });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ${mode === "late-error" ? 2300 : mode === "late" ? 650 : 10});
      if (${JSON.stringify(mode)} !== "late-error") init.signal.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
    });
    if (${JSON.stringify(mode)} === "late-error") return new Response("upstream-after-match-end", { status: 503 });
    return Response.json({model:"typesafe/jev-1.13",answers:{direction:{type:"choice",choice:${JSON.stringify(mode === "late" ? "up" : "right")},probabilities:{up:${mode === "late" ? 1 : 0},right:${mode === "late" ? 0 : mode === "rounded" ? 0.99 : 1},down:0,left:0},confidence:1}}});
  }
  if (!String(input).startsWith(${JSON.stringify(`${root}/`)}))
    throw new Error("Unexpected test network destination");
  if (String(input).endsWith("/decision-context")) {
    const response = await originalFetch(input, init);
    const context = await response.json();
    if (response.ok) appendFileSync(${JSON.stringify(join(dir, "contexts.jsonl"))}, JSON.stringify(context) + "\\n");
    if (response.ok && ${JSON.stringify(mode)} === "response-no-progress") delete context.progress;
    if (response.ok && ${JSON.stringify(mode)} === "response-progress-mismatch") context.progress.throughTick += 1;
    if (response.ok && ++contextCount === 1 && ["response-stale","response-protocol"].includes(${JSON.stringify(mode)})) {
      if (${JSON.stringify(mode)} === "response-stale") context.expectedStateHash = "0".repeat(64);
      else context.targetTick += 1;
    }
    return Response.json(context, {status:response.status});
  }
  return originalFetch(input, init);
};`,
	);
	return {
		game,
		decisionContexts: (): DecisionContext[] =>
			readFileSync(join(dir, "contexts.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		transportBodies: () =>
			readFileSync(join(dir, "bodies.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		async run(
			args: string[] = [],
			apiKey = "runner-test-credential",
			env: Record<string, string> = {},
		) {
			const child = spawn(
				process.execPath,
				[
					"--import",
					"tsx",
					"--import",
					hook,
					resolve("scripts/run-jev.ts"),
					"--url",
					root,
					"--name",
					"Runner failure test - not JEV inference",
					"--width",
					"24",
					"--height",
					"18",
					"--obstacles",
					"0",
					...(mode.startsWith("response-") ? [] : ["--tick-ms", "500"]),
					"--seed",
					"runner-test",
					...(["failure", "fast", "late", "late-error", "rounded"].includes(
						mode,
					)
						? ["--decision-mode", "single_step"]
						: []),
					...args,
				],
				{
					env: {
						...process.env,
						DOTENV_CONFIG_PATH: join(dir, "no-project-env"),
						JEV_PROVIDER: "typesafe",
						JEV_MODEL: "jev-1.13.0",
						TYPESAFE_API_KEY: apiKey,
						OPENROUTER_API_KEY: "",
						GAME_ADMIN_TOKEN: adminToken,
						SNAKE_STEP_MODE: "fixed",
						SNAKE_TICK_MS: "50000",
						...env,
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			disposers.push(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
			});
			let output = "";
			let sentSignal = false;
			child.stdout.on("data", (data) => {
				output += data.toString();
				// The 835ms scenario ends once its replacement plan is accepted.
				// Letting it run to the wall also exercises unrelated later deadlines,
				// where another plan may legitimately consume its own backup.
				if (
					!sentSignal &&
					((mode === "two-step" &&
						output
							.split("\n")
							.slice(0, -1)
							.some(
								(line) =>
									line.startsWith('{"observedTick":2,"targetTick":3,') &&
									line.includes('"status":"accepted"'),
							)) ||
						(mode === "two-signal" && output.includes('"observedTick":1')) ||
						(mode === "response-cancel" &&
							output.includes('"type":"test_transport_started"')))
				) {
					sentSignal = true;
					child.kill("SIGINT");
				}
			});
			child.stderr.on("data", (data) => {
				output += data.toString();
			});
			const [code] = await once(child, "close");
			return { code, output };
		},
	};
}

function expectProgressForwarded(
	contexts: DecisionContext[],
	bodies: (DecisionRequestV3 | PlanRequestV3)[],
) {
	expect(bodies.length).toBeGreaterThan(0);
	for (const body of bodies) {
		const context = contexts.find(
			(item) => item.state.tick === body.state.timing.observedTick,
		);
		expect(context).toBeDefined();
		expect(body.state.progress).toEqual(context?.progress);
		expect(body.state.progress).toMatchObject({
			historyVersion: "progress-v1",
			historyStartTick: 0,
			throughTick: body.state.timing.observedTick,
			lastAppleTick: expect.any(Number),
			movesSinceApple: expect.any(Number),
			positionVisits: expect.any(Number),
		});
		expect(body.state.progress).toHaveProperty("previousVisitTick");
		expect(body.state.progress).toHaveProperty("repeatAfterMoves");
		for (const direction of ["up", "right", "down", "left"] as const) {
			expect(body.state.progress?.actions[direction]).toMatchObject({
				timesTaken: expect.any(Number),
				returnsWithoutApple: expect.any(Number),
			});
			expect(body.state.progress?.actions[direction]).toHaveProperty(
				"lastTakenTick",
			);
		}
	}
}

test("missing JEV credentials do not create a match", async () => {
	const f = await fixture();
	const result = await f.run([], "");
	expect(result.code).not.toBe(0);
	expect(result.output).toContain("Set TYPESAFE_API_KEY");
	expect(f.game.store.list({}).matches).toHaveLength(0);
});

test("the removed lookahead option is rejected before match creation", async () => {
	const f = await fixture();
	const result = await f.run(["--lookahead-ms=500"]);
	expect(result.code).not.toBe(0);
	expect(f.game.store.list({}).matches).toHaveLength(0);
	expect(result.output).toContain("Unknown option '--lookahead-ms'");
});

test("a fast model observes each actual position once and never queues future movements", async () => {
	const f = await fixture("fast");
	const result = await f.run(["--tick-ms", "300", "--width", "10"]);
	expect(result.code).toBe(0);
	const match = f.game.store.list({}).matches[0];
	const events = f.game.store.events(match.id, -1).events;
	expectProgressForwarded(f.decisionContexts(), f.transportBodies());
	const actions = events.filter((e) => e.type === "action_accepted");
	expect(actions.length).toBeGreaterThan(2);
	expect(events.some((e) => e.type === "action_rejected")).toBe(false);
	expect(new Set(actions.map((e) => e.tick)).size).toBe(actions.length);
	for (const action of actions) {
		const observed = events[Number(action.data.observedSeq)].state;
		const request = action.state.lastDecision?.request;
		expect(action.data.targetTick).toBe(observed.tick + 1);
		expect(action.tick).toBe(observed.tick);
		expect(request?.state.timing).toMatchObject({
			stateIsProjected: false,
			observedTick: observed.tick,
			targetTick: observed.tick + 1,
		});
		expect(request?.state.contextVersion).toBe("action-facts-v4");
		expect(request?.state.player).toMatchObject({
			head: observed.snake[0],
			length: observed.snake.length,
		});
		expect(request?.state.player).not.toHaveProperty("bodyHeadToTail");
		expect(
			request &&
				"direction" in request.questions &&
				request.questions.direction.criteria,
		).toMatchObject(analyzeActions(observed));
		expect(f.transportBodies()).toContainEqual(request);
		expect(action.state.lastDecision?.requestBytes).toBe(
			Buffer.byteLength(JSON.stringify(request), "utf8"),
		);
		expect(action.state.lastDecision?.contextBuildMs).toBeGreaterThanOrEqual(0);
		const applied = events.find(
			(e) =>
				e.data.actionStatus === "applied" &&
				e.data.requestId === action.data.requestId,
		);
		expect(applied?.tick).toBe(observed.tick + 1);
	}
});

test("a late model result stays attached to its expired step and is never applied later", async () => {
	const f = await fixture("late");
	const result = await f.run(["--tick-ms", "300", "--width", "10"]);
	expect(result.code).toBe(0);
	expect(result.output).toContain('"type":"model_request_started"');
	expect(result.output).toContain('"type":"model_request_cancelled"');
	expect(result.output).toContain('"reason":"match_ended"');
	const match = f.game.store.list({}).matches[0];
	const events = f.game.store.events(match.id, -1).events;
	expectProgressForwarded(f.decisionContexts(), f.transportBodies());
	for (const body of f.transportBodies()) {
		expect(body.state.progress.movesSinceApple).toBe(
			body.state.timing.observedTick,
		);
		expect(body.state.progress.positionVisits).toBe(1);
	}
	expect(
		f.transportBodies().some((body) => body.state.progress.movesSinceApple > 0),
	).toBe(true);
	const rejected = events.filter((e) => e.type === "action_rejected");
	expect(rejected.length).toBeGreaterThan(1);
	expect(events.some((e) => e.data.actionStatus === "applied")).toBe(false);
	for (const action of rejected) {
		expect(action.data.code).toBe("late_action");
		const observed = events[Number(action.data.observedSeq)].state;
		expect(action.data.targetTick).toBe(observed.tick + 1);
		expect(action.state.direction).toBe("right");
	}
});

test("upstream failure exits unsuccessfully and persists an interrupted match", async () => {
	const f = await fixture();
	const result = await f.run();
	expect(result.code).not.toBe(0);
	expect(result.output).toContain("HTTP 503");
	expect(result.output).toContain("runner-test-upstream-unavailable");
	const matches = f.game.store.list({}).matches;
	expect(matches).toHaveLength(1);
	expect(matches[0].status).toBe("interrupted");
	expect(matches[0].endReason).toBe("model_error");
	const events = f.game.store.events(matches[0].id, -1).events;
	expect(events.at(-1)?.type).toBe("interrupted");
	expect(events.every((event) => event.state.lastDecision === null)).toBe(true);
});

test("a genuine upstream error racing with gameover is exposed rather than treated as cancellation", async () => {
	const f = await fixture("late-error");
	const result = await f.run(["--tick-ms", "300", "--width", "10"]);
	expect(f.game.store.list({}).matches[0].status).toBe("gameover");
	expect(result.code).not.toBe(0);
	expect(result.output).toContain("HTTP 503");
	expect(result.output).toContain("upstream-after-match-end");
	expect(result.output).toContain('"type":"model_request_failed"');
	expect(result.output).not.toContain("runner-test-credential");
});

test("a 0.99 probability total is preserved and the runner keeps playing", async () => {
	const f = await fixture("rounded");
	const result = await f.run(["--tick-ms", "300", "--width", "10"]);
	expect(result.code).toBe(0);
	expect(result.output).toContain("probabilities_not_normalized");
	const match = f.game.store.list({}).matches[0];
	expect(match.status).toBe("gameover");
	expect(match.endReason).toBe("wall");
	const actions = f.game.store
		.events(match.id, -1)
		.events.filter((e) => e.type === "action_accepted");
	expect(actions.length).toBeGreaterThan(2);
	for (const event of actions) {
		expect(event.state.lastDecision?.choice).toBe("right");
		expect(event.state.lastDecision?.probabilities).toEqual({
			up: 0,
			right: 0.99,
			down: 0,
			left: 0,
		});
	}
});

test("default two-step runner uses stored backup during 835ms request, rejects stale plan, then observes the actual fallback position", async () => {
	const f = await fixture("two-step");
	const result = await f.run(["--width", "10"]);
	expect(result.code).toBe(0);
	expect(result.output).toContain("mode two_step_fallback");
	const match = f.game.store.list({}).matches[0];
	expect(match.config.decisionMode).toBe("two_step_fallback");
	expect(match.config.tickIntervalMs).toBe(500);
	expect(match).toMatchObject({
		status: "interrupted",
		endReason: "controller_stop",
	});
	const events = f.game.store.events(match.id, -1).events;
	expectProgressForwarded(f.decisionContexts(), f.transportBodies());
	const first = events.find((e) => e.type === "plan_accepted");
	expect(first?.state.lastDecision?.request?.state.contextVersion).toBe(
		"two-step-plan-v4",
	);
	expect(f.transportBodies()).toContainEqual(
		first?.state.lastDecision?.request,
	);
	expect(first?.state.lastDecision?.requestBytes).toBe(
		Buffer.byteLength(
			JSON.stringify(first?.state.lastDecision?.request),
			"utf8",
		),
	);
	const backup = events.find(
		(e) => e.tick === 2 && e.data.actionStatus === "applied",
	);
	expect(backup?.state.lastAppliedAction).toMatchObject({
		source: "fallback",
		stepIndex: 1,
		requestId: first?.data.requestId,
	});
	const rejected = events.find((e) => e.type === "plan_rejected");
	expect(rejected?.data.code).toBe("late_action");
	const resumed = events.find(
		(e) => e.type === "plan_accepted" && Number(e.data.observedTick) >= 2,
	);
	expect(resumed?.state.lastDecision?.request?.state.player.head).toEqual(
		backup?.state.snake[0],
	);
	expect(resumed?.state.lastDecision?.request?.state).toHaveProperty(
		"progress",
		expect.objectContaining({ throughTick: 2, movesSinceApple: 2 }),
	);
	const starts = result.output
		.split("\n")
		.filter((l) => l.startsWith('{"type":"model_request_started"'))
		.map((l) => JSON.parse(l).observedTick);
	expect(starts).toEqual([0, 1, 2]);
	expect(new Set(starts).size).toBe(starts.length);
	const fallbacks = events.filter(
		(e) =>
			e.state.lastAppliedAction?.source === "fallback" &&
			e.data.actionStatus === "applied",
	);
	expect(
		fallbacks,
		JSON.stringify({
			fallbacks: fallbacks.map((event) => ({
				tick: event.tick,
				requestId: event.data.requestId,
				observedTick: event.state.lastAppliedAction?.observedTick,
			})),
			output: result.output,
		}),
	).toHaveLength(1);
});
test.each(["two-error", "bad-plan"] as const)(
	"%s exposes errors and interrupts without fallback hiding a failed call",
	async (mode) => {
		const f = await fixture(mode);
		const result = await f.run(["--width", "10"]);
		expect(result.code).not.toBe(0);
		expect(result.output).toContain(
			mode === "two-error" ? "HTTP 503" : "Invalid JEV",
		);
		expect(f.game.store.list({}).matches[0]).toMatchObject({
			status: "interrupted",
			endReason: "model_error",
		});
		expect(result.output).not.toContain("runner-test-credential");
	},
);
test.each(["two-cancel", "two-signal"] as const)(
	"%s cancels the pending model request and all unused steps",
	async (mode) => {
		const f = await fixture(mode);
		const result = await f.run(["--width", "7"]);
		expect(result.code).toBe(0);
		expect(result.output).toContain('"type":"model_request_cancelled"');
		const match = f.game.store.list({}).matches[0];
		expect(match.status).toBe(
			mode === "two-signal" ? "interrupted" : "gameover",
		);
		expect(f.game.store.get(match.id).plans).toEqual([]);
	},
);
test("invalid decision mode and unsupported old server reject before creation", async () => {
	const f = await fixture("old-server");
	const invalid = await f.run(["--decision-mode", "invalid"]);
	expect(invalid.code).not.toBe(0);
	expect(invalid.output).toContain("decision-mode must be");
	const unsupported = await f.run();
	expect(unsupported.code).not.toBe(0);
	expect(unsupported.output).toContain("does not support");
	expect(f.game.store.list({}).matches).toHaveLength(0);
});

test.each(["response-fast", "response-slow"] as const)(
	"%s waits for each result and immediately continues after exactly one applied move",
	async (mode) => {
		const f = await fixture(mode);
		const result = await f.run(["--step-mode", "response", "--width", "7"]);
		expect(result.code, result.output).toBe(0);
		const match = f.game.store.list({}).matches[0];
		expect(match.config).toMatchObject({
			stepMode: "response",
			decisionMode: "single_step",
			tickIntervalMs: null,
		});
		expect(match.status).toBe("gameover");
		const events = f.game.store.events(match.id, -1).events;
		expectProgressForwarded(f.decisionContexts(), f.transportBodies());
		const actions = events.filter((e) => e.type === "action_accepted");
		const moves = events.filter((e) => e.data.actionStatus === "applied");
		expect(actions.length).toBeGreaterThan(2);
		expect(moves).toHaveLength(actions.length);
		expect(events.some((e) => e.type === "action_rejected")).toBe(false);
		for (const [index, action] of actions.entries()) {
			const observed = events[Number(action.data.observedSeq)].state;
			expect(f.transportBodies()).toContainEqual(
				action.state.lastDecision?.request,
			);
			expect(action.state.lastDecision?.request?.state.contextVersion).toBe(
				"action-facts-v4",
			);
			expect(action.state.lastDecision?.contextBuildMs).toBeGreaterThanOrEqual(
				0,
			);
			expect(observed.tick).toBe(index);
			expect(action.data.targetTick).toBe(index + 1);
			expect(action.state.lastDecision?.request?.state.timing).toMatchObject({
				stepMode: "response",
				tickIntervalMs: null,
				deadlineInMs: null,
				stateIsProjected: false,
				observedTick: index,
				targetTick: index + 1,
			});
			const applied = moves.find(
				(e) => e.data.requestId === action.data.requestId,
			);
			expect(applied?.tick).toBe(index + 1);
			expect(applied?.gameTimeMs).toBe(action.gameTimeMs);
		}
		const requests = result.output
			.split("\n")
			.filter((line) => line.startsWith('{"type":"test_transport_started"'))
			.map((line) => JSON.parse(line));
		expect(requests).toHaveLength(actions.length);
		expect(requests.map((r) => r.observedTick)).toEqual(
			actions.map((_, i) => i),
		);
		expect(requests.every((r) => r.inFlight === 1)).toBe(true);
		// The environment deliberately contains a 50s fixed interval. Completion and
		// these real persisted times prove response mode never sleeps on that value.
		expect(match.gameTimeMs).toBeLessThan(10000);
		if (mode === "response-slow") {
			const intervals = moves.map(
				(e, i) => e.gameTimeMs - (moves[i - 1]?.gameTimeMs ?? 0),
			);
			expect(intervals[0]).toBeGreaterThanOrEqual(120);
			expect(intervals[1]).toBeGreaterThanOrEqual(470);
			expect(intervals[2]).toBeGreaterThanOrEqual(1770);
		}
	},
);

test.each(["response-stale", "response-reverse"] as const)(
	"%s rereads and asks again at the same tick after rejection",
	async (mode) => {
		const f = await fixture(mode);
		const result = await f.run(["--step-mode", "response", "--width", "7"]);
		expect(result.code, result.output).toBe(0);
		const match = f.game.store.list({}).matches[0];
		const events = f.game.store.events(match.id, -1).events;
		expectProgressForwarded(f.decisionContexts(), f.transportBodies());
		const bodies = f.transportBodies();
		expect(bodies[0].state.progress).toEqual(bodies[1].state.progress);
		expect(bodies[1].state.progress).toMatchObject({
			throughTick: 0,
			movesSinceApple: 0,
			positionVisits: 1,
			previousVisitTick: null,
			repeatAfterMoves: null,
		});
		for (const action of Object.values(bodies[1].state.progress.actions))
			expect(action).toEqual({
				timesTaken: 0,
				returnsWithoutApple: 0,
				lastTakenTick: null,
			});
		const rejection = events.find((e) => e.type === "action_rejected");
		expect(rejection).toMatchObject({
			tick: 0,
			data: {
				code: mode === "response-stale" ? "stale_state" : "invalid_direction",
			},
		});
		const accepted = events.find((e) => e.type === "action_accepted");
		expect(accepted?.tick).toBe(0);
		expect(Number(accepted?.data.observedSeq)).toBeGreaterThanOrEqual(
			rejection?.seq ?? -1,
		);
		const starts = result.output
			.split("\n")
			.filter((line) => line.startsWith('{"type":"model_request_started"'))
			.map((line) => JSON.parse(line).observedTick);
		expect(starts.slice(0, 2)).toEqual([0, 0]);
	},
);

test("response command protocol failures stop explicitly instead of looping", async () => {
	const f = await fixture("response-protocol");
	const result = await f.run(["--step-mode", "response", "--width", "7"]);
	expect(result.code).not.toBe(0);
	expect(result.output).toContain("Response action rejected");
	expect(f.game.store.list({}).matches[0]).toMatchObject({
		status: "interrupted",
		tick: 0,
		endReason: "model_error",
	});
	expect(result.output.match(/"type":"model_request_started"/g)).toHaveLength(
		1,
	);
});

test.each(["response-no-progress", "response-progress-mismatch"] as const)(
	"%s fails before inference instead of sending incomplete history",
	async (mode) => {
		const f = await fixture(mode);
		const result = await f.run(["--step-mode", "response", "--width", "7"]);
		expect(result.code).not.toBe(0);
		expect(result.output).toContain(
			mode === "response-no-progress"
				? "decision context is missing progress history"
				: "progress history does not match observed tick",
		);
		expect(result.output).not.toContain('"type":"test_transport_started"');
		const match = f.game.store.list({}).matches[0];
		expect(f.game.store.get(match.id)).toMatchObject({
			status: "interrupted",
			tick: 0,
			endReason: "model_error",
			lastDecision: null,
		});
	},
);

test("response runner sends and persists actual repeated-position and departure history without replacing choices", async () => {
	const f = await fixture("response-loop");
	const result = await f.run([
		"--step-mode",
		"response",
		"--width",
		"7",
		"--height",
		"5",
	]);
	expect(result.code, result.output).toBe(0);
	const match = f.game.store.list({}).matches[0];
	expect(match).toMatchObject({
		status: "gameover",
		endReason: "wall",
		tick: 16,
	});
	const bodies = f.transportBodies();
	expectProgressForwarded(f.decisionContexts(), bodies);
	const repeated = bodies.find((body) => body.state.timing.observedTick === 11);
	expect(repeated.state.progress).toEqual({
		historyVersion: "progress-v1",
		historyStartTick: 0,
		throughTick: 11,
		lastAppleTick: 0,
		movesSinceApple: 11,
		positionVisits: 3,
		previousVisitTick: 7,
		repeatAfterMoves: 4,
		actions: {
			up: { timesTaken: 2, returnsWithoutApple: 2, lastTakenTick: 8 },
			right: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
			down: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
			left: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
		},
	});
	const events = f.game.store.events(match.id, -1).events;
	const accepted = events.filter((event) => event.type === "action_accepted");
	expect(accepted).toHaveLength(16);
	for (const [index, event] of accepted.entries()) {
		expect(event.state.lastDecision?.request).toEqual(bodies[index]);
		expect(event.state.lastDecision?.choice).toBe(
			index < 12 ? ["right", "down", "left", "up"][index % 4] : "right",
		);
	}
	expect(events.some((event) => event.type === "action_rejected")).toBe(false);
	const repeatedLog = result.output
		.split("\n")
		.filter((line) => line.startsWith('{"type":"model_request_started"'))
		.map((line) => JSON.parse(line))
		.find((entry) => entry.observedTick === 11);
	expect(repeatedLog).toMatchObject({
		movesSinceApple: 11,
		positionVisits: 3,
		repeatAfterMoves: 4,
	});
});

test("response mode config comes from CLI or environment, with conflicts rejected before creation", async () => {
	const f = await fixture("response-fast");
	for (const args of [
		["--step-mode", "invalid"],
		["--step-mode", "response", "--tick-ms", "500"],
		["--step-mode", "response", "--decision-mode", "two_step_fallback"],
	]) {
		const result = await f.run(args);
		expect(result.code).not.toBe(0);
		expect(result.output).toMatch(
			/step-mode must be|cannot be combined|cannot use/,
		);
		expect(f.game.store.list({}).matches).toHaveLength(0);
	}
	const result = await f.run(["--width", "7"], "runner-test-credential", {
		SNAKE_STEP_MODE: "response",
	});
	expect(result.code, result.output).toBe(0);
	expect(f.game.store.list({}).matches[0].config).toMatchObject({
		stepMode: "response",
		tickIntervalMs: null,
		decisionMode: "single_step",
	});
});

test.each(["response-error", "response-cancel"] as const)(
	"%s preserves explicit failure or cancellation while the snake waits",
	async (mode) => {
		const f = await fixture(mode);
		const result = await f.run(["--step-mode", "response", "--width", "7"]);
		expect(result.code).toBe(mode === "response-error" ? 1 : 0);
		expect(result.output).toContain(
			mode === "response-error"
				? '"type":"model_request_failed"'
				: '"type":"model_request_cancelled"',
		);
		expect(result.output).toContain(
			mode === "response-error" ? "HTTP 503" : "controller_stop",
		);
		expect(result.output).not.toContain("runner-test-credential");
		expect(f.game.store.list({}).matches[0]).toMatchObject({
			status: "interrupted",
			tick: 0,
			endReason: mode === "response-error" ? "model_error" : "controller_stop",
		});
	},
);

test("response mode preserves rounded probabilities and keeps moving only on returned decisions", async () => {
	const f = await fixture("response-rounded");
	const result = await f.run(["--step-mode", "response", "--width", "7"]);
	expect(result.code, result.output).toBe(0);
	expect(result.output).toContain("probabilities_not_normalized");
	const match = f.game.store.list({}).matches[0];
	const actions = f.game.store
		.events(match.id, -1)
		.events.filter((e) => e.type === "action_accepted");
	expect(actions.length).toBeGreaterThan(2);
	for (const action of actions)
		expect(action.state.lastDecision?.probabilities.right).toBe(0.99);
});
