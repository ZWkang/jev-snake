import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
	analyzeDynamicSpace,
	defaultDynamicLimits,
	describeDynamicSpaceMove,
	dynamicSpaceSemantics,
	dynamicStaticSemantics,
} from "../shared/snake/dynamic-space-analysis.js";
import { analyzeLegalSpace } from "../shared/snake/legal-space-analysis.js";
import type { LegalSpaceInput } from "../shared/snake/legal-space.js";
import { inspectMove } from "../shared/snake/move-rules.js";
import { directions, type Direction } from "../shared/snake/types.js";
import fixtures from "./fixtures/dynamic-space-cases.json";

function sample(id: string): LegalSpaceInput {
	return fixtures.find((fixture) => fixture.id === id)!
		.input as LegalSpaceInput;
}

function openBoard(): LegalSpaceInput {
	return {
		width: 12,
		height: 10,
		bodyHeadToTail: [
			{ x: 4, y: 4 },
			{ x: 3, y: 4 },
			{ x: 2, y: 4 },
			{ x: 1, y: 4 },
		],
		direction: "right",
		obstacles: [],
		apple: { x: 11, y: 9 },
		star: null,
	};
}

function afterPath(input: LegalSpaceInput, path: Direction[]) {
	let state = {
		config: { width: input.width, height: input.height },
		snake: [...input.bodyHeadToTail],
		direction: input.direction,
		obstacles: input.obstacles,
		apple: input.apple,
	};
	let ate = false;
	for (const direction of path) {
		const move = inspectMove(state, direction);
		expect(move.immediateCollision).toBeNull();
		ate ||= move.eatsApple;
		state = {
			...state,
			snake: [
				move.target,
				...(move.eatsApple ? state.snake : state.snake.slice(0, -1)),
			],
			direction,
			apple: move.eatsApple ? null : state.apple,
		};
	}
	return {
		ate,
		exits: directions.filter((d) => !inspectMove(state, d).immediateCollision),
		state,
	};
}

test.each([
	["trap-618-down", "down", 7, "left", 19],
	["trap-688-left", "left", 7, "right", 22],
	["trap-8a-up", "up", 5, "down", 5],
] as const)(
	"$0 proves the failed branch without labeling its alternative safe",
	(id, bad, moves, alternative, nodes) => {
		const input = sample(id);
		const result = analyzeDynamicSpace(input);
		expect(result.dynamicFacts[bad]!.trap).toEqual({
			status: "proven_trap",
			moves,
			exploredNodes: nodes,
		});
		expect(result.dynamicFacts[alternative]!.trap).toMatchObject({
			status: "horizon_reached",
			moves: 8,
		});
		expect(Object.keys(result.dynamicFacts)).toEqual(
			Object.keys(analyzeLegalSpace(input).moveFacts),
		);
		expect(
			describeDynamicSpaceMove(
				bad,
				analyzeLegalSpace(input).moveFacts[bad]!,
				result.dynamicFacts[bad]!,
			),
		).toContain("PROVEN_TRAP:");
		expect(
			describeDynamicSpaceMove(
				alternative,
				analyzeLegalSpace(input).moveFacts[alternative]!,
				result.dynamicFacts[alternative]!,
			),
		).toContain("not long-term safety");
	},
);

test.each([
	["apple-detour-466", 4, ["down", "right", "up", "right"]],
	["apple-detour-549", 5, ["down", "right", "up", "right", "right"]],
] as const)(
	"$0 exposes a short food route after the initially farther direction",
	(id, moves, path) => {
		const input = sample(id);
		const result = analyzeDynamicSpace(input);
		expect(result.dynamicFacts.down!.apple).toMatchObject({
			status: "route_with_exit",
			moves,
			nextLegalMoveCount: 1,
			canReachTail: true,
			termination: "found",
		});
		expect(result.dynamicFacts.right!.apple).toMatchObject({
			status: "no_route_with_exit_found",
			moves: null,
			termination: "node_limit",
		});
		const replay = afterPath(input, [...path]);
		expect(replay.ate).toBe(true);
		expect(replay.exits).toEqual(["up"]);
		expect(replay.state.snake).toHaveLength(input.bodyHeadToTail.length + 1);
		expect(JSON.stringify(result)).not.toContain("path");
	},
);

test("apple search keeps searching after the first fruit arrival would trap the grown body", () => {
	const input = sample("bad-arrival-before-good-465");
	const short = afterPath(input, ["right", "right", "right"]);
	expect(short.ate).toBe(true);
	expect(short.exits).toEqual([]);
	const longer = afterPath(input, ["right", "down", "right", "up", "right"]);
	expect(longer.ate).toBe(true);
	expect(longer.exits).toEqual(["up"]);
	expect(analyzeDynamicSpace(input).dynamicFacts.right!.apple).toMatchObject({
		status: "route_with_exit",
		moves: 5,
		nextLegalMoveCount: 1,
	});
});

test("the old short loop window remains explicitly unresolved", () => {
	const result = analyzeDynamicSpace(sample("bc44-loop-multi-choice"), {
		...defaultDynamicLimits,
		appleDepth: 12,
	});
	expect(Object.keys(result.dynamicFacts)).toEqual(["up", "down", "left"]);
	for (const facts of Object.values(result.dynamicFacts)) {
		expect(facts.trap).toMatchObject({ status: "horizon_reached", moves: 8 });
		expect(facts.apple.status).toBe("no_route_with_exit_found");
		expect(facts.apple.moves).toBeNull();
		expect(["depth_limit", "node_limit"]).toContain(facts.apple.termination);
		expect(facts.apple.exploredNodes).toBeLessThanOrEqual(2048);
	}
	expect(result.dynamicFacts.up!.apple.termination).toBe("node_limit");
	expect(result.dynamicFacts.left!.apple.termination).toBe("node_limit");
});

test("bounded best-first finds current-loop food arrivals without claiming an optimal or safe route", () => {
	const input = sample("bc44-loop-multi-choice");
	const result = analyzeDynamicSpace(input);
	expect(result.analysisLimits).toEqual({
		trapDepth: 8,
		appleDepth: 32,
		maxNodesPerSearch: 2048,
	});
	for (const facts of Object.values(result.dynamicFacts)) {
		expect(facts.apple).toMatchObject({
			status: "route_with_exit",
			moves: 25,
			nextLegalMoveCount: 1,
			canReachTail: false,
			termination: "found",
		});
		expect(facts.apple.exploredNodes).toBeLessThan(250);
	}
	const verified = afterPath(input, [
		"up",
		"left",
		"up",
		"right",
		"up",
		"right",
		"right",
		"up",
		"right",
		"up",
		"right",
		"right",
		"down",
		"left",
		"down",
		"left",
		"down",
		"left",
		"down",
		"right",
		"down",
		"right",
		"up",
		"right",
		"up",
	]);
	expect(verified.ate).toBe(true);
	expect(verified.exits).toEqual(["up"]);
	expect(dynamicSpaceSemantics).toContain(
		"not claimed to be shortest or optimal",
	);
});

test("apple growth is terminal unknown only when a real next exit remains", () => {
	const input = openBoard();
	input.apple = { x: 5, y: 4 };
	expect(analyzeDynamicSpace(input).dynamicFacts.right).toMatchObject({
		trap: { status: "unknown_after_apple", moves: 1, exploredNodes: 1 },
		apple: {
			status: "route_with_exit",
			moves: 1,
			nextLegalMoveCount: 3,
			termination: "found",
		},
	});
	const corridor: LegalSpaceInput = {
		...input,
		width: 7,
		height: 1,
		bodyHeadToTail: [
			{ x: 5, y: 0 },
			{ x: 4, y: 0 },
			{ x: 3, y: 0 },
			{ x: 2, y: 0 },
		],
		apple: { x: 6, y: 0 },
	};
	expect(analyzeDynamicSpace(corridor).dynamicFacts.right).toEqual({
		trap: { status: "proven_trap", moves: 1, exploredNodes: 1 },
		apple: {
			status: "no_route_with_exit_found",
			moves: null,
			nextLegalMoveCount: null,
			canReachTail: null,
			exploredNodes: 1,
			termination: "exhausted",
		},
	});
});

test("entering the vacating tail follows the same growth rule as live movement", () => {
	const input: LegalSpaceInput = {
		...openBoard(),
		bodyHeadToTail: [
			{ x: 1, y: 1 },
			{ x: 2, y: 1 },
			{ x: 2, y: 2 },
			{ x: 1, y: 2 },
		],
		direction: "left",
		apple: null,
	};
	expect(analyzeDynamicSpace(input).dynamicFacts.down).toBeDefined();
	input.apple = { x: 1, y: 2 };
	expect(analyzeDynamicSpace(input).dynamicFacts.down).toBeUndefined();
});

test("filling the board is a win rather than a no-exit fruit arrival", () => {
	const input: LegalSpaceInput = {
		width: 2,
		height: 3,
		bodyHeadToTail: [
			{ x: 0, y: 1 },
			{ x: 1, y: 1 },
			{ x: 1, y: 2 },
			{ x: 0, y: 2 },
		],
		direction: "left",
		obstacles: [{ x: 1, y: 0 }],
		apple: { x: 0, y: 0 },
		star: null,
	};
	expect(analyzeDynamicSpace(input).dynamicFacts.up).toEqual({
		trap: { status: "board_complete", moves: 1, exploredNodes: 1 },
		apple: {
			status: "route_wins",
			moves: 1,
			nextLegalMoveCount: null,
			canReachTail: null,
			exploredNodes: 1,
			termination: "found",
		},
	});
});

test("per-option node exhaustion is unresolved and never treated as an exhausted proof", () => {
	const result = analyzeDynamicSpace(openBoard(), {
		trapDepth: 8,
		appleDepth: 12,
		maxNodesPerSearch: 1,
	});
	expect(Object.keys(result.dynamicFacts)).toEqual(["up", "right", "down"]);
	for (const facts of Object.values(result.dynamicFacts)) {
		expect(facts.trap).toEqual({
			status: "node_limit",
			moves: null,
			exploredNodes: 1,
		});
		expect(facts.apple).toEqual({
			status: "no_route_with_exit_found",
			moves: null,
			nextLegalMoveCount: null,
			canReachTail: null,
			exploredNodes: 1,
			termination: "node_limit",
		});
	}
	for (const facts of Object.values(
		analyzeDynamicSpace(openBoard(), {
			trapDepth: 1,
			appleDepth: 1,
			maxNodesPerSearch: 10,
		}).dynamicFacts,
	)) {
		expect(facts.trap).toMatchObject({ status: "horizon_reached", moves: 1 });
		expect(facts.apple.termination).toBe("depth_limit");
	}
});

test("no apple is explicit and observation, random state and limits are untouched", () => {
	const input = openBoard();
	input.apple = null;
	const before = structuredClone(input);
	for (const point of input.bodyHeadToTail) Object.freeze(point);
	Object.freeze(input.bodyHeadToTail);
	Object.freeze(input.obstacles);
	Object.defineProperty(input, "rngState", {
		get() {
			throw new Error("RNG state must not be read");
		},
	});
	Object.freeze(input);
	const random = vi.spyOn(Math, "random").mockImplementation(() => {
		throw new Error("Randomness must not be used");
	});
	try {
		const result = analyzeDynamicSpace(input);
		for (const facts of Object.values(result.dynamicFacts))
			expect(facts.apple).toEqual({
				status: "no_apple",
				moves: null,
				nextLegalMoveCount: null,
				canReachTail: null,
				exploredNodes: 0,
				termination: "not_applicable",
			});
		expect(input).toEqual(before);
		expect(result.analysisLimits).toEqual(defaultDynamicLimits);
		expect(result.analysisLimits).not.toBe(defaultDynamicLimits);
	} finally {
		random.mockRestore();
	}
	expect(dynamicSpaceSemantics).toContain(
		"frontier cannot grow beyond the limit",
	);
	expect(dynamicStaticSemantics).not.toContain("No multi-step routes");
	expect(dynamicStaticSemantics).toContain("separate bounded dynamic facts");
});

test("100 repeated former-OOM and full-frontier analyses retain less than 64 MiB of Bun heap after GC", () => {
	const directory = mkdtempSync(join(tmpdir(), "snake-dynamic-memory-"));
	try {
		const script = join(directory, "probe.mjs");
		writeFileSync(
			script,
			`
import {readFileSync} from 'node:fs';
import {analyzeDynamicSpace} from ${JSON.stringify(new URL("../shared/snake/dynamic-space-analysis.ts", import.meta.url).href)};
const old=JSON.parse(readFileSync(new URL(${JSON.stringify(new URL("./fixtures/board-v6-oom-tick275.json", import.meta.url).href)}),'utf8'));
const input={width:old.config.width,height:old.config.height,bodyHeadToTail:old.snake,direction:old.direction,obstacles:old.obstacles,apple:old.apple,star:old.star?.point??null};
const open={...input,width:128,height:96,bodyHeadToTail:[{x:64,y:48},{x:63,y:48},{x:62,y:48},{x:61,y:48}],direction:'right',obstacles:[],apple:{x:0,y:0},star:null};
const started=performance.now();let maxExplored=0,nodeLimited=0;
for(let i=0;i<100;i++){const r=analyzeDynamicSpace(i%2?input:open);for(const f of Object.values(r.dynamicFacts)){if(f.apple.exploredNodes>2048||f.trap.exploredNodes>2048)throw Error('budget exceeded');maxExplored=Math.max(maxExplored,f.apple.exploredNodes);nodeLimited+=f.apple.termination==='node_limit';}}
global.gc();console.log(JSON.stringify({iterations:100,maxExplored,nodeLimited,elapsedMs:performance.now()-started,heapMiB:process.memoryUsage().heapUsed/1048576}));
`,
		);
		const result = spawnSync(
			process.execPath,
			["--no-env-file", "--expose-gc", script],
			{ cwd: process.cwd(), encoding: "utf8", timeout: 20000 },
		);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.iterations).toBe(100);
		expect(report.maxExplored).toBe(2048);
		expect(report.nodeLimited).toBeGreaterThan(0);
		expect(report.heapMiB).toBeLessThan(64);
		console.log("dynamic-space-memory", report);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 25000);
