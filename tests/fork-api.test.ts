import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { JEV_ENDPOINT } from "../server/jev/client.js";
import { startServer } from "../server/start.js";
import { inspectMove } from "../shared/snake/move-rules.js";
import {
	directions,
	publicState,
	type DecisionRequestV15,
	type Direction,
	type PublicState,
} from "../shared/snake/types.js";
import { loadLegacy } from "./legacy-fixture.js";

const disposers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function fixture(twoStep = false) {
	const dir = mkdtempSync(join(tmpdir(), "snake-fork-api-"));
	const adminToken = "fork-api-admin".repeat(4);
	const sourceToken = "fork-api-source-control".repeat(3);
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
		throw new Error("No server address");
	const root = `http://127.0.0.1:${address.port}`;
	const source = twoStep
		? publicState(loadLegacy(game.store, "two_step_fallback-ready").state)
		: game.service.create({
				requestId: "source-create",
				controlToken: sourceToken,
				agentName: "Historical source",
				config: {
					width: 7,
					height: 5,
					obstacleCount: 0,
					seed: "runner-test",
					...(twoStep
						? {
								stepMode: "fixed",
								decisionMode: "two_step_fallback",
								tickIntervalMs: 500,
							}
						: {
								stepMode: "response",
								decisionMode: "single_step",
								tickIntervalMs: null,
							}),
				},
			});
	if (!twoStep) {
		game.service.command(source.id, {
			protocolVersion: 1,
			requestId: "source-start",
			type: "start",
		});
		for (let i = 0; i < 12; i++) {
			const context = game.service.decisionContext(source.id);
			const direction: Direction = (["left", "down", "right", "up"] as const)[
				i % 4
			];
			const receipt = game.service.command(source.id, {
				protocolVersion: 1,
				requestId: `source-move-${i}`,
				type: "action",
				direction,
				observedSeq: context.observedSeq,
				targetTick: context.targetTick,
				expectedStateHash: context.expectedStateHash,
			});
			expect(receipt.status).toBe("applied");
		}
		game.service.command(source.id, {
			protocolVersion: 1,
			requestId: "source-stop",
			type: "stop",
			reason: "test_source_complete",
		});
	}
	const sourceState = game.store.get(source.id);
	const sourceEvents = game.store.events(source.id, -1).events;
	const target = twoStep
		? sourceEvents[0]
		: sourceEvents.find((event) => event.tick === 11 && event.type === "move");
	if (!target) throw new Error("Missing test fork target");
	const forkBody = {
		requestId: "fork-create",
		controlToken: "fork-api-new-control".repeat(3),
		agentName: "Historical fork",
		model: null,
		sourceSeq: target.seq,
	};
	return {
		dir,
		game,
		root,
		source,
		sourceToken,
		adminToken,
		sourceState,
		sourceEvents,
		target,
		forkBody,
		assertSourceUnchanged() {
			expect(game.store.get(source.id)).toEqual(sourceState);
			expect(game.store.events(source.id, -1).events).toEqual(sourceEvents);
		},
		post(body: unknown = forkBody, token?: string) {
			return fetch(`${root}/api/matches/${source.id}/fork`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
				body: JSON.stringify(body),
			});
		},
		async run(
			args: string[],
			mode = "normal",
			extraEnv: Record<string, string> = {},
		) {
			const hook = join(dir, "transport.mjs");
			writeFileSync(
				hook,
				`import { appendFileSync } from "node:fs";
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url === ${JSON.stringify(JEV_ENDPOINT)}) {
    const body = JSON.parse(init.body);
    appendFileSync(${JSON.stringify(join(dir, "bodies.jsonl"))}, init.body + "\\n");
    const choice = body.state.timing.observedTick === 11 ? "up" : "right";
    if (!(choice in body.questions.direction.criteria)) throw new Error("Test fixture chose an unoffered direction");
    return Response.json({model:"test-only-fork-response",answers:{direction:{type:"choice",choice,probabilities:Object.fromEntries(Object.keys(body.questions.direction.criteria).map(d=>[d,d===choice?1:0])),confidence:1}}});
  }
  if (!url.startsWith(${JSON.stringify(`${root}/`)})) throw new Error("Unexpected test network destination");
  if (url.endsWith("/fork")) appendFileSync(${JSON.stringify(join(dir, "fork-request.json"))}, init.body);
  if (${JSON.stringify(mode)} === "old-health" && url.endsWith("/api/health")) return Response.json({supportedProtocolVersions:[1]});
  if (${JSON.stringify(mode)} === "unsupported-fork" && url.endsWith("/fork")) return Response.json({error:{code:"not_found",message:"Historical fork API is unavailable"}}, {status:404});
  const response = await originalFetch(input, init);
  if (url.endsWith("/decision-context") && response.ok) {
    const context = await response.clone().json();
    if (context.state.tick === 15) {
      // Four real fork moves suffice to verify continued history and execution.
      // Stop the controller before the old fixture's intentional wall collision.
      process.kill(process.pid, "SIGINT");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  if (url === ${JSON.stringify(`${root}/api/matches/${source.id}`)} && ${JSON.stringify(mode)} === "missing-source") {
    const body = await response.json(); delete body.config.width;
    return Response.json(body, {status:response.status});
  }
  if (url.endsWith("/fork") && ${JSON.stringify(mode)} === "missing-provenance") {
    const body = await response.json(); delete body.forkedFrom;
    return Response.json(body, {status:response.status});
  }
  return response;
};`,
			);
			const child = spawn(
				process.execPath,
				[
					"--no-env-file",
					"--import",
					hook,
					resolve("scripts/run-jev.ts"),
					"--url",
					root,
					"--name",
					"Fork runner transport test",
					...args,
				],
				{
					env: {
						...process.env,
						DOTENV_CONFIG_PATH: join(dir, "no-project-env"),
						GAME_ADMIN_TOKEN: adminToken,
						JEV_PROVIDER: "typesafe",
						JEV_MODEL: "jev-1.13.0",
						TYPESAFE_API_KEY: "fork-test-api-key",
						OPENROUTER_API_KEY: "",
						SNAKE_STEP_MODE: "invalid-create-only-env",
						SNAKE_WIDTH: "900",
						SNAKE_HEIGHT: "800",
						SNAKE_OBSTACLES: "700",
						SNAKE_SEED: "must-not-change-fork",
						SNAKE_TICK_MS: "50000",
						...extraEnv,
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			disposers.push(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
			});
			let output = "";
			child.stdout.on("data", (data) => {
				output += data.toString();
			});
			child.stderr.on("data", (data) => {
				output += data.toString();
			});
			const [code] = await once(child, "close");
			return { code, output };
		},
		bodies(): DecisionRequestV15[] {
			return readFileSync(join(dir, "bodies.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
		},
		forkRequest(): { controlToken: string; sourceSeq: number } {
			return JSON.parse(readFileSync(join(dir, "fork-request.json"), "utf8"));
		},
	};
}

test("historical fork API is admin-only, preserves source and gives the fork a separate control credential", async () => {
	const f = await fixture();
	for (const token of [undefined, f.sourceToken, "wrong-token"])
		expect((await f.post(f.forkBody, token)).status).toBe(401);
	expect(f.game.store.list().matches).toHaveLength(1);
	const response = await f.post(f.forkBody, f.adminToken);
	expect(response.status).toBe(201);
	const fork = (await response.json()) as PublicState;
	expect(fork.id).not.toBe(f.source.id);
	expect(fork).toMatchObject({
		status: "ready",
		tick: 11,
		config: f.source.config,
		forkedFrom: {
			matchId: f.source.id,
			seq: f.target.seq,
			tick: 11,
			gameTimeMs: f.target.gameTimeMs,
		},
	});
	for (const token of [undefined, f.sourceToken]) {
		const denied = await fetch(
			`${f.root}/api/matches/${fork.id}/decision-context`,
			{ headers: token ? { Authorization: `Bearer ${token}` } : {} },
		);
		expect(denied.status).toBe(401);
	}
	f.game.service.command(fork.id, {
		protocolVersion: 1,
		requestId: "fork-start",
		type: "start",
	});
	const contextResponse = await fetch(
		`${f.root}/api/matches/${fork.id}/decision-context`,
		{ headers: { Authorization: `Bearer ${f.forkBody.controlToken}` } },
	);
	expect(contextResponse.status).toBe(200);
	const context = await contextResponse.json();
	expect(context.progress).toMatchObject({
		throughTick: 11,
		positionVisits: 3,
		repeatAfterMoves: 4,
	});
	const publicOutput = JSON.stringify({
		fork,
		context,
		events: f.game.store.events(fork.id, -1).events,
	});
	for (const secret of [
		f.sourceToken,
		f.forkBody.controlToken,
		f.adminToken,
		"control_hash",
		"rngState",
	])
		expect(publicOutput).not.toContain(secret);
	f.assertSourceUnchanged();
});

test("fork API rejects malformed bodies and unsupported source sequences without creating another match", async () => {
	const f = await fixture();
	for (const changes of [
		{ sourceSeq: -1 },
		{ sourceSeq: 0.5 },
		{ sourceSeq: "1" },
		{ controlToken: "short" },
		{ config: f.source.config },
	])
		expect(
			(await f.post({ ...f.forkBody, ...changes }, f.adminToken)).status,
		).toBe(400);
	const invalidJson = await fetch(`${f.root}/api/matches/${f.source.id}/fork`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${f.adminToken}`,
			"Content-Type": "application/json",
		},
		body: "{",
	});
	expect(invalidJson.status).toBe(400);
	expect(
		(await f.post({ ...f.forkBody, sourceSeq: 99999 }, f.adminToken)).ok,
	).toBe(false);
	expect(f.game.store.list().matches).toHaveLength(1);
	f.assertSourceUnchanged();
});

test("fork CLI requires a paired source and sequence and rejects explicit create configuration", async () => {
	const f = await fixture();
	for (const args of [
		["--fork-match", f.source.id],
		["--fork-seq", String(f.target.seq)],
		["--fork-match", f.source.id, "--fork-seq=-1"],
		["--fork-match", f.source.id, "--fork-seq", "1.5"],
	]) {
		const result = await f.run(args);
		expect(result.code).not.toBe(0);
		expect(result.output).toMatch(
			/must be supplied together|nonnegative integer/,
		);
	}
	for (const option of [
		"tick-ms",
		"step-mode",
		"decision-mode",
		"width",
		"height",
		"obstacles",
		"seed",
	]) {
		const result = await f.run([
			"--fork-match",
			f.source.id,
			"--fork-seq",
			String(f.target.seq),
			`--${option}`,
			"1",
		]);
		expect(result.code).not.toBe(0);
		expect(result.output).toContain(`cannot be combined with --${option}`);
	}
	expect(f.game.store.list().matches).toHaveLength(1);
	f.assertSourceUnchanged();
});

test("with spending protection explicitly disabled, fork runner continues from historical progress", async () => {
	const f = await fixture();
	const result = await f.run(
		["--fork-match", f.source.id, "--fork-seq", String(f.target.seq)],
		"normal",
		{ JEV_STAGNATION_GUARD: "false" },
	);
	expect(result.code, result.output).toBe(0);
	const summary = f.game.store
		.list()
		.matches.find((match) => match.id !== f.source.id);
	if (!summary) throw new Error("Runner did not create fork");
	const fork = f.game.store.get(summary.id);
	const forkRequest = f.forkRequest();
	expect(forkRequest.sourceSeq).toBe(f.target.seq);
	expect(forkRequest.controlToken).toMatch(/^[0-9a-f]{64}$/);
	expect(forkRequest.controlToken).not.toBe(f.sourceToken);
	expect(fork.config).toEqual(f.source.config);
	expect(fork).toMatchObject({
		status: "interrupted",
		endReason: "controller_stop",
		tick: 15,
		agentName: "Fork runner transport test",
		model: "jev-1.13.0",
	});
	const bodies = f.bodies();
	expect(bodies.map((body) => body.state.timing.observedTick)).toEqual([
		11, 12, 13, 14,
	]);
	expect(bodies[0].state.contextVersion).toBe("growth-space-v15");
	for (const body of bodies) {
		expect(body.state.contextVersion).toBe("growth-space-v15");
		const geometry = {
			config: body.state.board,
			snake: body.state.player.bodyHeadToTail,
			direction: body.state.player.direction,
			obstacles: body.state.board.obstacles,
			apple: body.state.food.apple,
		};
		expect(Object.keys(body.questions.direction.criteria)).toEqual(
			directions.filter(
				(direction) =>
					inspectMove(geometry, direction).immediateCollision === null,
			),
		);
		expect(Object.keys(body.state).sort()).toEqual([
			"analysisLimits",
			"board",
			"contextVersion",
			"dynamicFacts",
			"dynamicSemantics",
			"excludedMoves",
			"factsSemantics",
			"food",
			"moveFacts",
			"player",
			"progress",
			"rules",
			"timing",
		]);
		for (const criterion of Object.values(body.questions.direction.criteria))
			expect(typeof criterion).toBe("string");
	}
	expect(bodies[0].state.player.bodyHeadToTail).toEqual(f.target.state.snake);
	expect(bodies[0].state.board.obstacles).toEqual(f.target.state.obstacles);
	expect(bodies[0].state.progress).toMatchObject({
		historyStartTick: 0,
		throughTick: 11,
		movesSinceApple: 11,
		positionVisits: 3,
		previousVisitTick: 7,
		repeatAfterMoves: 4,
		actions: {
			up: { timesTaken: 2, returnsWithoutApple: 2, lastTakenTick: 8 },
		},
	});
	const events = f.game.store.events(fork.id, -1).events;
	const newActions = events.filter(
		(event) => event.seq > f.target.seq && event.type === "action_accepted",
	);
	expect(newActions).toHaveLength(bodies.length);
	for (const [index, event] of newActions.entries()) {
		expect(event.state.lastDecision?.request).toEqual(bodies[index]);
		expect(Object.keys(event.state.lastDecision!.probabilities)).toEqual(
			Object.keys(bodies[index].questions.direction.criteria),
		);
		expect(event.data.targetTick).toBe(12 + index);
	}
	expect(result.output).toContain('"sourceTick":11');
	expect(result.output).toContain(`"sourceSeq":${f.target.seq}`);
	expect(result.output).toContain(`"sourceMatchId":"${f.source.id}"`);
	for (const secret of [
		f.sourceToken,
		f.adminToken,
		forkRequest.controlToken,
		"fork-test-api-key",
		"controlToken",
		"control_hash",
	])
		expect(result.output).not.toContain(secret);
	expect(JSON.stringify(events)).not.toContain(forkRequest.controlToken);
	f.assertSourceUnchanged();
});

test.each(["missing-source", "unsupported-fork", "missing-provenance"])(
	"fork runner fails explicitly for %s and never starts from scratch",
	async (mode) => {
		const f = await fixture();
		const result = await f.run(
			["--fork-match", f.source.id, "--fork-seq", String(f.target.seq)],
			mode,
		);
		expect(result.code).not.toBe(0);
		expect(result.output).toMatch(
			/incomplete fork source|fork API is unavailable|invalid fork/,
		);
		expect(result.output).not.toContain('"type":"model_request_started"');
		const forks = f.game.store
			.list()
			.matches.filter((match) => match.id !== f.source.id);
		expect(forks).toHaveLength(mode === "missing-provenance" ? 1 : 0);
		if (forks.length)
			expect(forks[0]).toMatchObject({ status: "ready", tick: 11 });
		f.assertSourceUnchanged();
	},
);

test("old two-step fork is rejected before creation or model invocation", async () => {
	const f = await fixture(true);
	const result = await f.run(
		["--fork-match", f.source.id, "--fork-seq", String(f.target.seq)],
		"old-health",
	);
	expect(result.code).not.toBe(0);
	expect(result.output).toContain("mode_retired");
	expect(f.game.store.list().matches).toHaveLength(1);
	f.assertSourceUnchanged();
});
