import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { inspectMove } from "../server/game/engine.js";
import {
	askJev,
	buildDecisionContext,
	decisionBody,
} from "../server/jev/client.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import {
	directions,
	opposite,
	type PublicState,
} from "../shared/snake/types.js";
import fixture from "./fixtures/board-v6-oom-tick275.json";

// These modules must never enter the live client's dependency graph.
vi.mock("../server/jev/search-context.js", () => {
	throw new Error("Search request builder imported into one-step-space client");
});
vi.mock("../server/jev/post-apple-search.js", () => {
	throw new Error("Post-apple search imported into one-step-space client");
});
vi.mock("../server/jev/bounded-search.js", () => {
	throw new Error("Bounded search imported into one-step-space client");
});
vi.mock("../server/jev/immediate-moves.js", () => {
	throw new Error(
		"Computed movement facts imported into one-step-space client",
	);
});
vi.mock("../server/jev/observed-space.js", () => {
	throw new Error("Space analysis imported into one-step-space client");
});
vi.mock("../server/jev/analysis-context.js", () => {
	throw new Error("Offline analysis imported into live client");
});
vi.mock("../server/jev/branch-death.js", () => {
	throw new Error("Death search imported into live client");
});
vi.mock("../server/jev/apple-alternatives.js", () => {
	throw new Error("Alternative search imported into live client");
});
vi.mock("../server/jev/positive-evidence.js", () => {
	throw new Error("Witness search imported into live client");
});

const state = fixture as PublicState;

test("the actual OOM position becomes a complete independent snapshot without reading old analysis", () => {
	const observed = structuredClone(state);
	const originalBody = structuredClone(observed.snake);
	const originalObstacles = structuredClone(observed.obstacles);
	Object.defineProperty(observed, "lastDecision", {
		get() {
			throw new Error("Old decision archive must not be read");
		},
	});
	const context = buildDecisionContext(observed);
	const request = context.request;
	expect(Object.keys(context)).toEqual(["request"]);
	expect(request.state.contextVersion).toBe("compact-growth-v16");
	expect(Object.keys(request.state).sort()).toEqual([
		"analysisLimits",
		"board",
		"contextVersion",
		"dynamicFacts",
		"excludedMoves",
		"food",
		"moveFacts",
		"player",
		"timing",
	]);
	expect(request.state.timing.observedTick).toBe(275);
	expect(request.state.player.bodyHeadToTail).toEqual(originalBody);
	expect(request.state.board.obstacles).toEqual(originalObstacles);
	expect(request.state.food).toEqual({ apple: state.apple, star: state.star });
	expect(Object.keys(request.questions.direction.criteria)).toEqual(
		directions.filter(
			(direction) =>
				inspectMove(observed, direction).immediateCollision === null,
		),
	);
	for (const entry of Object.values(request.questions.direction.criteria))
		expect(typeof entry).toBe("string");
	expect(decisionRequestSchema.parse(request)).toEqual(request);
	observed.snake[0].x++;
	observed.obstacles[0].y++;
	expect(request.state.player.bodyHeadToTail).toEqual(originalBody);
	expect(request.state.board.obstacles).toEqual(originalObstacles);
});

test("live transport preserves an offered model choice and logs at the HTTP boundary", async () => {
	expect(inspectMove(state, "up").immediateCollision).toBe("obstacle");
	expect(opposite[state.direction]).not.toBe("up");
	const chosen = Object.keys(
		decisionBody(state).questions.direction.criteria,
	)[0];
	const order: string[] = [];
	const transport = vi
		.fn<typeof fetch>()
		.mockImplementation(async (_input, init) => {
			order.push("fetch");
			const request = JSON.parse(init!.body as string);
			expect(request.state.contextVersion).toBe("compact-growth-v16");
			expect(request.state).not.toHaveProperty("immediateMoves");
			expect(request.state).not.toHaveProperty("observedSpace");
			expect(request.state).not.toHaveProperty("localSearch");
			expect(request.state.player.bodyHeadToTail).toEqual(state.snake);
			expect(request.state.board.obstacles).toEqual(state.obstacles);
			return Response.json({
				model: "test-returned-choice",
				answers: {
					direction: {
						type: "choice",
						choice: chosen,
						probabilities: Object.fromEntries(
							Object.keys(request.questions.direction.criteria).map(
								(direction) => [direction, direction === chosen ? 1 : 0],
							),
						),
						confidence: 1,
					},
				},
			});
		});
	const decision = await askJev("test-only-key", state, {
		fetch: transport,
		onRequestStarted: () => order.push("started"),
	});
	expect(order).toEqual(["started", "fetch"]);
	expect(decision.choice).toBe(chosen);
	expect(Object.keys(decision.probabilities)).toEqual(
		Object.keys(decision.request!.questions.direction.criteria),
	);
	expect(decision).not.toHaveProperty("evidence");
	expect(decision.request).toEqual(
		JSON.parse(transport.mock.calls[0][1]!.body as string),
	);
	expect(transport).toHaveBeenCalledOnce();
});

test("old fixed inputs cannot silently enter the new live path", () => {
	expect(() =>
		decisionBody({
			...state,
			config: { ...state.config, stepMode: "fixed", tickIntervalMs: 100 },
		}),
	).toThrow("Only response");
});

test("historical V13 input rebuilding the former 4 GB OOM position 10000 times retains less than 64 MiB of Bun heap after GC", () => {
	const directory = mkdtempSync(join(tmpdir(), "snake-raw-context-"));
	try {
		const script = join(directory, "probe.mjs");
		const source = new URL("../server/jev/client.ts", import.meta.url).href;
		const statePath = new URL(
			"./fixtures/board-v6-oom-tick275.json",
			import.meta.url,
		).href;
		writeFileSync(
			script,
			`import {readFileSync} from 'node:fs';\nimport {decisionBodyV13 as decisionBody} from ${JSON.stringify(source)};\nconst state=JSON.parse(readFileSync(new URL(${JSON.stringify(statePath)}),'utf8'));\nfor(let i=0;i<10000;i++){const r=decisionBody(state);if(r.state.timing.observedTick!==275||r.state.player.bodyHeadToTail.length!==30)throw new Error('Incomplete board');}\nglobal.gc();\nconsole.log(JSON.stringify({iterations:10000,heapMiB:process.memoryUsage().heapUsed/1024/1024}));`,
		);
		const result = spawnSync(
			process.execPath,
			["--no-env-file", "--expose-gc", script],
			{ cwd: process.cwd(), encoding: "utf8", timeout: 15000 },
		);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.iterations).toBe(10000);
		expect(report.heapMiB).toBeLessThan(64);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
