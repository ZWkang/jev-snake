import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createState, move } from "../server/game/engine.js";
import { analyzeDynamicSpace } from "../shared/snake/dynamic-space-analysis.js";
import {
	analyzeGrowthSpace,
	defaultGrowthLimits,
	describeGrowthSpaceMove,
	growthSpaceSemantics,
} from "../shared/snake/growth-space-analysis.js";
import { analyzeLegalSpace } from "../shared/snake/legal-space-analysis.js";
import type { LegalSpaceInput } from "../shared/snake/legal-space.js";
import fixtures from "./fixtures/growth-space-cases.json";

function sample(id: string): LegalSpaceInput {
	return fixtures.find((fixture) => fixture.id === id)!
		.input as LegalSpaceInput;
}

test.each([
	["growth-trap-8af-323", "down", 3, 1, "up"],
	["growth-trap-487-77", "right", 6, 3, "left"],
] as const)(
	"$0 rejects the post-apple death that v14 called an arrival with an exit",
	(id, bad, moves, rejected, alternative) => {
		const input = sample(id);
		const old = analyzeDynamicSpace(input).dynamicFacts[bad]!;
		expect(old.trap.status).toBe("unknown_after_apple");
		expect(old.apple.status).toBe("route_with_exit");
		const result = analyzeGrowthSpace(input);
		expect(result.dynamicFacts[bad]!.trap).toMatchObject({
			status: "proven_trap",
			moves,
		});
		expect(result.dynamicFacts[bad]!.apple).toMatchObject({
			status: "no_qualifying_route_found",
			moves: null,
			postApple: null,
			rejectedTrapArrivals: rejected,
			termination: "exhausted",
		});
		expect(result.dynamicFacts[alternative]!.trap.status).not.toBe(
			"proven_trap",
		);
		expect(result.dynamicFacts[alternative]!.apple.status).toBe(
			"route_with_optimistic_continuation",
		);
		expect(Object.keys(result.dynamicFacts)).toEqual(
			Object.keys(analyzeLegalSpace(input).moveFacts),
		);
		expect(
			describeGrowthSpaceMove(
				bad,
				analyzeLegalSpace(input).moveFacts[bad]!,
				result.dynamicFacts[bad]!,
			),
		).toContain("PROVEN_TRAP:");
	},
);

test.each([
	["trap-618-down", "down", 7],
	["trap-688-left", "left", 7],
	["trap-8a-up", "up", 5],
] as const)(
	"$0 preserves the previously verified short dynamic trap",
	(id, direction, moves) => {
		expect(
			analyzeGrowthSpace(sample(id)).dynamicFacts[direction]!.trap,
		).toMatchObject({ status: "proven_trap", moves });
	},
);

test.each([
	["apple-detour-466", 4],
	["apple-detour-549", 5],
] as const)(
	"$0 preserves food progress while separately checking growth consequences",
	(id, moves) => {
		const result = analyzeGrowthSpace(sample(id)).dynamicFacts.down!;
		expect(result.apple).toMatchObject({
			status: "route_with_optimistic_continuation",
			moves,
			nextLegalMoveCount: 1,
			postApple: { status: "optimistic_horizon_reached", moves: 8 },
			postAppleNodes: 9,
			termination: "found",
		});
		expect(JSON.stringify(result)).not.toMatch(/"path"|"recommended"/);
	},
);

test("after rejecting trapped fruit arrivals, other body arrangements can still qualify", () => {
	const result = analyzeGrowthSpace(sample("bad-arrival-before-good-465"))
		.dynamicFacts.right!.apple;
	expect(result).toMatchObject({
		status: "route_with_optimistic_continuation",
		moves: 5,
		rejectedTrapArrivals: 2,
		postAppleNodes: 11,
		postApple: {
			status: "optimistic_horizon_reached",
			moves: 8,
			exploredNodes: 9,
		},
	});
	const cycle = analyzeGrowthSpace(sample("bc44-loop-multi-choice"));
	for (const facts of Object.values(cycle.dynamicFacts)) {
		expect(facts.apple.status).toBe("route_with_optimistic_continuation");
		expect(facts.apple.rejectedTrapArrivals).toBeGreaterThan(0);
		expect(facts.apple.postAppleNodes).toBeGreaterThan(
			facts.apple.postApple!.exploredNodes,
		);
		expect(facts.apple.postAppleNodes).toBeLessThanOrEqual(2048);
	}
});

test("ateApple stays true when the optimistic body revisits the consumed fruit square", () => {
	const input: LegalSpaceInput = {
		width: 2,
		height: 2,
		bodyHeadToTail: [
			{ x: 0, y: 0 },
			{ x: 0, y: 1 },
		],
		direction: "up",
		obstacles: [],
		apple: { x: 1, y: 0 },
		star: null,
	};
	const result = analyzeGrowthSpace(input).dynamicFacts.right!;
	// The three-cell body cycles around the square and crosses (1,0) again.
	// A reset ateApple flag would respawn that old fruit and falsely report a win.
	expect(result.trap).toEqual({
		status: "optimistic_horizon_reached",
		moves: 8,
		exploredNodes: 8,
	});
	expect(result.apple).toMatchObject({
		status: "route_with_optimistic_continuation",
		moves: 1,
		postApple: {
			status: "optimistic_horizon_reached",
			moves: 8,
			exploredNodes: 9,
		},
	});
	expect(result.apple.status).not.toBe("route_wins");
});

test("near completion, further growth may win before optimistic movement ends", () => {
	const input: LegalSpaceInput = {
		width: 7,
		height: 1,
		bodyHeadToTail: [
			{ x: 4, y: 0 },
			{ x: 3, y: 0 },
			{ x: 2, y: 0 },
			{ x: 1, y: 0 },
			{ x: 0, y: 0 },
		],
		direction: "right",
		obstacles: [],
		apple: { x: 5, y: 0 },
		star: null,
	};
	const result = analyzeGrowthSpace(input).dynamicFacts.right!;
	expect(result.trap).toEqual({
		status: "unknown_near_win",
		moves: null,
		exploredNodes: 2,
	});
	expect(result.apple).toMatchObject({
		status: "route_postcheck_unknown",
		moves: 1,
		postApple: { status: "unknown_near_win", moves: null, exploredNodes: 2 },
		rejectedTrapArrivals: 0,
	});
	const state = createState(
		"near-win",
		"test",
		null,
		{
			width: 7,
			height: 1,
			obstacleCount: 0,
			seed: "near-win",
			stepMode: "response",
			tickIntervalMs: null,
		},
		"now",
	);
	state.snake = [...input.bodyHeadToTail];
	state.direction = input.direction;
	state.apple = input.apple;
	move(state, "right");
	expect(state.apple).toEqual({ x: 6, y: 0 });
	expect(move(state, "right").type).toBe("won");
});

test("the currently observed apple can win immediately without a post-apple continuation", () => {
	const input: LegalSpaceInput = {
		width: 7,
		height: 1,
		bodyHeadToTail: Array.from({ length: 6 }, (_, i) => ({ x: 5 - i, y: 0 })),
		direction: "right",
		obstacles: [],
		apple: { x: 6, y: 0 },
		star: null,
	};
	expect(analyzeGrowthSpace(input).dynamicFacts.right).toEqual({
		trap: { status: "board_complete", moves: 1, exploredNodes: 1 },
		apple: {
			status: "route_wins",
			moves: 1,
			nextLegalMoveCount: null,
			canReachTail: null,
			postApple: null,
			exploredNodes: 1,
			termination: "found",
			postAppleNodes: 0,
			rejectedTrapArrivals: 0,
		},
	});
});

test("post-apple depth zero is counted when the arrival already has no legal move", () => {
	const input: LegalSpaceInput = {
		width: 7,
		height: 1,
		bodyHeadToTail: [
			{ x: 5, y: 0 },
			{ x: 4, y: 0 },
			{ x: 3, y: 0 },
			{ x: 2, y: 0 },
		],
		direction: "right",
		obstacles: [],
		apple: { x: 6, y: 0 },
		star: null,
	};
	const result = analyzeGrowthSpace(input).dynamicFacts.right!;
	expect(result.trap).toMatchObject({ status: "proven_trap", moves: 1 });
	expect(result.apple).toMatchObject({
		status: "no_qualifying_route_found",
		rejectedTrapArrivals: 1,
		postAppleNodes: 1,
	});
});

test("post-apple node budgets are shared across arrivals and cannot multiply", () => {
	const exact = analyzeGrowthSpace(sample("growth-trap-8af-323"), {
		...defaultGrowthLimits,
		maxNodesPerSearch: 3,
	}).dynamicFacts.down!;
	expect(exact.trap).toMatchObject({ status: "proven_trap", moves: 3 });
	expect(exact.apple).toMatchObject({
		status: "no_qualifying_route_found",
		termination: "exhausted",
		postAppleNodes: 3,
		rejectedTrapArrivals: 1,
	});
	const input = sample("growth-trap-487-77");
	const short = analyzeGrowthSpace(input, {
		...defaultGrowthLimits,
		maxNodesPerSearch: 4,
	}).dynamicFacts.right!;
	expect(short.trap).toMatchObject({
		status: "node_limit",
		moves: null,
		exploredNodes: 4,
	});
	expect(short.apple).toMatchObject({
		status: "route_postcheck_unknown",
		termination: "postcheck_node_limit",
		postAppleNodes: 4,
		postApple: { status: "node_limit", moves: null, exploredNodes: 4 },
	});
	const shared = analyzeGrowthSpace(input, {
		...defaultGrowthLimits,
		maxNodesPerSearch: 12,
	}).dynamicFacts.right!.apple;
	// Two independently proved bad arrivals consume the same twelve-node budget.
	expect(shared).toMatchObject({
		status: "no_qualifying_route_found",
		termination: "postcheck_node_limit",
		postAppleNodes: 12,
		rejectedTrapArrivals: 2,
	});
	for (const limit of [1, 4, 12, 32])
		for (const facts of Object.values(
			analyzeGrowthSpace(input, {
				...defaultGrowthLimits,
				maxNodesPerSearch: limit,
			}).dynamicFacts,
		)) {
			expect(facts.trap.exploredNodes).toBeLessThanOrEqual(limit);
			expect(facts.apple.exploredNodes).toBeLessThanOrEqual(limit);
			expect(facts.apple.postAppleNodes).toBeLessThanOrEqual(limit);
		}
});

test("all input observations and random state remain untouched", () => {
	const input = structuredClone(sample("growth-trap-8af-323"));
	const before = structuredClone(input);
	for (const p of [...input.bodyHeadToTail, ...input.obstacles, input.apple!])
		Object.freeze(p);
	Object.freeze(input.bodyHeadToTail);
	Object.freeze(input.obstacles);
	Object.defineProperty(input, "rngState", {
		get() {
			throw Error("RNG state read");
		},
	});
	Object.freeze(input);
	const random = vi.spyOn(Math, "random").mockImplementation(() => {
		throw Error("RNG called");
	});
	try {
		analyzeGrowthSpace(input);
		expect(input).toEqual(before);
	} finally {
		random.mockRestore();
	}
	const noApple = analyzeGrowthSpace({ ...before, apple: null });
	for (const facts of Object.values(noApple.dynamicFacts))
		expect(facts.apple).toMatchObject({
			status: "no_apple",
			moves: null,
			exploredNodes: 0,
			postApple: null,
			postAppleNodes: 0,
			rejectedTrapArrivals: 0,
			termination: "not_applicable",
		});
	expect(growthSpaceSemantics).toContain("optimistic relaxation");
	expect(growthSpaceSemantics).toContain("shared");
});

test("100 mixed full-budget, historic-OOM and repeated apple-arrival checks retain less than 64 MiB of Bun heap after GC", () => {
	const dir = mkdtempSync(join(tmpdir(), "snake-growth-memory-"));
	try {
		const path = join(dir, "check.mjs");
		writeFileSync(
			path,
			`
import {readFileSync} from 'node:fs';
import {analyzeGrowthSpace} from ${JSON.stringify(new URL("../shared/snake/growth-space-analysis.ts", import.meta.url).href)};
const fixtures=JSON.parse(readFileSync(new URL(${JSON.stringify(new URL("./fixtures/growth-space-cases.json", import.meta.url).href)}),'utf8'));
const old=JSON.parse(readFileSync(new URL(${JSON.stringify(new URL("./fixtures/board-v6-oom-tick275.json", import.meta.url).href)}),'utf8'));
const input={width:old.config.width,height:old.config.height,bodyHeadToTail:old.snake,direction:old.direction,obstacles:old.obstacles,apple:old.apple,star:old.star?.point??null};
const open={...input,width:128,height:96,bodyHeadToTail:[{x:64,y:48},{x:63,y:48},{x:62,y:48},{x:61,y:48}],direction:'right',obstacles:[],apple:{x:0,y:0},star:null};
const pool=[open,input,fixtures.find(f=>f.id==='bc44-loop-multi-choice').input,fixtures.find(f=>f.id==='apple-detour-466').input];let maxApple=0,maxPost=0,rejected=0;const start=performance.now();
for(let i=0;i<100;i++){const r=analyzeGrowthSpace(pool[i%pool.length]);for(const f of Object.values(r.dynamicFacts)){if(f.trap.exploredNodes>2048||f.apple.exploredNodes>2048||f.apple.postAppleNodes>2048)throw Error('budget exceeded');maxApple=Math.max(maxApple,f.apple.exploredNodes);maxPost=Math.max(maxPost,f.apple.postAppleNodes);rejected+=f.apple.rejectedTrapArrivals;}}
global.gc();console.log(JSON.stringify({iterations:100,maxApple,maxPost,rejected,elapsedMs:performance.now()-start,heapMiB:process.memoryUsage().heapUsed/1048576}));
`,
		);
		const result = spawnSync(
			process.execPath,
			["--no-env-file", "--expose-gc", path],
			{ cwd: process.cwd(), encoding: "utf8", timeout: 20000 },
		);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.iterations).toBe(100);
		expect(report.maxApple).toBe(2048);
		expect(report.maxPost).toBeLessThanOrEqual(2048);
		expect(report.rejected).toBeGreaterThan(0);
		expect(report.heapMiB).toBeLessThan(64);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 25000);
