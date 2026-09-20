import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { createState } from "../server/game/engine";
import { decisionBodyV5 } from "../server/jev/analysis-context.js";
import {
	decisionBodyV6,
	decisionBodyV11,
} from "../server/jev/board-context.js";
import { decisionBody, decisionBodyV12 } from "../server/jev/client.js";
import { planBody } from "../server/jev/legacy-context.js";
import {
	decisionBodyV7,
	decisionBodyV8,
	decisionBodyV9,
	decisionBodyV10,
} from "../server/jev/search-context.js";
import { renderNamedBoard } from "../shared/snake/ascii-board.js";
import type { LocalSearchMove } from "../shared/snake/bounded-search.js";
import type { PostAppleCheck } from "../shared/snake/post-apple-search.js";
import type {
	DecisionRequest,
	DecisionProgress,
	LegacyDecisionRequest,
	LegacyPlanRequest,
	MatchEvent,
} from "../shared/snake/types";
import { directions, publicState, summary } from "../shared/snake/types";
import {
	allActiveMatches,
	allEvents,
	averageSpeed,
	matchSpeed,
	stepModeName,
} from "../src/features/snake/api";
import { snakeColors } from "../src/features/snake/appearance";
import {
	observedRegionDescription,
	localSearchAppleExitDescription,
	localSearchCutoffDescription,
	localSearchDescription,
	postAppleCutoffDescription,
	postAppleDescription,
	presentDecisionContext,
	presentBoardAscii,
	presentCurrentBoardAscii,
	savedBoardAscii,
	savedStrategyGuide,
	savedDirectionOptions,
	savedProbabilityGaps,
	savedBoardObservationLabel,
} from "../src/features/snake/contextPresentation";
import {
	atTime,
	decisionForPosition,
	decisionObservationFrame,
	nextStep,
	previousStep,
} from "../src/features/snake/replay";
import { elapsedAt, playbackTimeAt } from "../src/features/snake/timing";

const initial = createState(
	"replay-test",
	"Test",
	null,
	{ width: 24, height: 18, obstacleCount: 0, tickIntervalMs: 125, seed: "a" },
	"now",
);
const historicalBoardRequest = decisionBodyV6(
	publicState({
		...initial,
		config: {
			...initial.config,
			stepMode: "response",
			decisionMode: "single_step",
		},
		tick: 19,
		snake: [
			{ x: 3, y: 2 },
			{ x: 2, y: 2 },
			{ x: 1, y: 2 },
		],
		obstacles: [{ x: 7, y: 4 }],
	}),
	"test-model",
);
function event(
	seq: number,
	tick: number,
	gameTimeMs: number,
	type: string,
): MatchEvent {
	const state = publicState({ ...initial, seq, tick, gameTimeMs });
	return {
		matchId: initial.id,
		seq,
		tick,
		gameTimeMs,
		type,
		data: {},
		createdAt: "now",
		state,
	};
}
const rows = [
	event(0, 0, 0, "created"),
	event(1, 0, 0, "started"),
	event(2, 1, 125, "move"),
	event(3, 1, 150, "action_rejected"),
	event(4, 2, 250, "apple"),
	event(5, 2, 260, "interrupted"),
];
afterEach(() => vi.unstubAllGlobals());
test("spectating loads all 30 active matches across status and cursor pages", async () => {
	const matches = Array.from({ length: 30 }, (_, i) =>
		summary({
			...initial,
			id: `active-${i}`,
			status: i < 21 ? "running" : "ready",
		}),
	);
	const transport = vi.fn(async (input: string) => {
		const query = new URL(input, "http://test").searchParams;
		const filtered = matches.filter((m) => m.status === query.get("status"));
		const offset = query.has("cursor") ? 20 : 0;
		return Response.json({
			matches: filtered.slice(offset, offset + 20),
			nextCursor: filtered.length > offset + 20 ? "next-page" : null,
			agents: [],
		});
	});
	vi.stubGlobal("fetch", transport);
	const actual = await allActiveMatches();
	expect(new Set(actual.map((m) => m.id))).toEqual(
		new Set(matches.map((m) => m.id)),
	);
	expect(actual).toHaveLength(30);
	expect(transport).toHaveBeenCalledTimes(3);
});
test("step controls preserve events between movements and include the final record", () => {
	expect(nextStep(rows, 0)).toBe(2);
	expect(nextStep(rows, 2)).toBe(4);
	expect(nextStep(rows, 4)).toBe(5);
	expect(previousStep(rows, 4)).toBe(3);
	expect(previousStep(rows, 0)).toBe(0);
});
test("playback respects equal-time sequence order and exact event boundaries", () => {
	expect(atTime(rows, 0)).toBe(1);
	expect(atTime(rows, 124)).toBe(1);
	expect(atTime(rows, 125)).toBe(2);
	expect(atTime(rows, 150)).toBe(3);
	expect(atTime(rows, 999)).toBe(5);
});
test("replay rejects a sequence gap rather than filling in a board", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(
			Response.json({
				events: [rows[0], rows[2]],
				nextSeq: 2,
				latestSeq: 2,
				hasMore: false,
			}),
		),
	);
	await expect(allEvents(initial.id)).rejects.toThrow("不连续");
});
test("replay rejects empty nonterminal pages and unsupported record versions", async () => {
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValue(
				Response.json({ events: [], nextSeq: -1, latestSeq: 1, hasMore: true }),
			),
	);
	await expect(allEvents(initial.id)).rejects.toThrow("记录缺失");
	const invalid = structuredClone(rows[0]) as MatchEvent;
	Object.assign(invalid.state, { recordVersion: 2 });
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(
			Response.json({
				events: [invalid],
				nextSeq: 0,
				latestSeq: 0,
				hasMore: false,
			}),
		),
	);
	await expect(allEvents(initial.id)).rejects.toThrow("记录版本");
});

test("v2 replay reads exact source, separates late decisions and counts requests once", async () => {
	const { decisionForPosition, decisionStatistics, isDecisionEvent } =
		await import("../src/features/snake/replay");
	const { makePlan } = await import("./plan-fixture");
	const state = publicState(
		createState(
			"v2-replay",
			"Test",
			null,
			{ ...initial.config, decisionMode: "two_step_fallback" },
			"now",
		),
	);
	const command = makePlan({
		observedSeq: 0,
		targetTick: 1,
		expectedStateHash: "0".repeat(64),
		state,
		deadlineInMs: 500,
	});
	const first = {
		...command.decision,
		requestId: "A",
		outcome: "accepted",
		targetTick: 1,
	};
	const second = {
		...command.decision,
		requestId: "B",
		outcome: "late_action",
		targetTick: 2,
	};
	const e0: MatchEvent = {
		...event(0, 0, 0, "plan_accepted"),
		state: { ...state, seq: 0, lastDecision: first },
		data: { requestId: "A", decision: first },
	};
	const e1: MatchEvent = {
		...event(1, 1, 500, "move"),
		state: {
			...state,
			seq: 1,
			tick: 1,
			lastDecision: first,
			lastAppliedAction: {
				source: "primary",
				direction: "right",
				tick: 1,
				targetTick: 1,
				requestId: "A",
				stepIndex: 0,
			},
		},
		data: { requestId: "A", actionStatus: "applied" },
	};
	const e2: MatchEvent = {
		...event(2, 2, 1000, "move"),
		state: {
			...e1.state,
			seq: 2,
			tick: 2,
			lastAppliedAction: {
				source: "fallback",
				direction: "down",
				tick: 2,
				targetTick: 2,
				requestId: "A",
				stepIndex: 1,
			},
		},
		data: {
			requestId: "A",
			actionStatus: "applied",
			steps: [
				{ targetTick: 1, direction: "right", status: "applied" },
				{ targetTick: 2, direction: "down", status: "applied" },
			],
		},
	};
	const e3: MatchEvent = {
		...event(3, 2, 1100, "plan_rejected"),
		state: { ...e2.state, seq: 3, lastDecision: second },
		data: { requestId: "B", decision: second, code: "late_action" },
	};
	const e4: MatchEvent = {
		...event(4, 3, 1500, "move"),
		state: {
			...e3.state,
			seq: 4,
			tick: 3,
			lastAppliedAction: {
				source: "coast",
				direction: "down",
				tick: 3,
				targetTick: 3,
				reason: "backup_exhausted",
			},
		},
		data: {},
	};
	const records = [e0, e1, e2, e3, e4];
	expect(decisionForPosition(records, e2.state)).toMatchObject({
		requestId: "A",
		steps: [{ status: "applied" }, { status: "applied" }],
	});
	expect(decisionForPosition(records, e3.state)?.requestId).toBe("B");
	expect(e3.state.lastAppliedAction?.requestId).toBe("A");
	expect(decisionStatistics(records)).toEqual({
		requests: 2,
		primary: 1,
		fallback: 1,
		coast: 1,
	});
	expect(records.filter(isDecisionEvent)).toHaveLength(2);
	expect(nextStep(records, 1)).toBe(2);
	expect(previousStep(records, 4)).toBe(3);
	const transport = vi.fn().mockResolvedValue(
		Response.json({
			events: records,
			nextSeq: 4,
			latestSeq: 4,
			hasMore: false,
		}),
	);
	vi.stubGlobal("fetch", transport);
	expect(await allEvents(state.id)).toEqual(records);
	expect(transport).toHaveBeenCalledOnce();
});

test("fallback movement is a labeled replay key event even without a reward or collision", async () => {
	const { isKeyEvent } = await import("../src/features/snake/replay");
	const { eventName } = await import("../src/features/snake/api");
	const move = event(10, 3, 1500, "move");
	move.data.actionSource = { source: "fallback" };
	expect(isKeyEvent(move)).toBe(true);
	expect(eventName(move)).toContain("上轮备用");
	move.data.actionSource = { source: "primary" };
	expect(isKeyEvent(move)).toBe(false);
});

test("response rates distinguish recorded elapsed time, zero steps and equal-time moves from fixed speed", () => {
	const state = summary(initial);
	const response = {
		...state,
		config: {
			...state.config,
			stepMode: "response" as const,
			decisionMode: "single_step" as const,
			tickIntervalMs: null,
		},
	};
	expect(stepModeName(state.config)).toBe("固定步频");
	expect(matchSpeed(state)).toBe("8 格 / 秒");
	expect(stepModeName(response.config)).toBe("随模型响应");
	expect(matchSpeed(response, 10000)).toBe("平均步频暂无样本");
	expect(matchSpeed({ ...response, tick: 2 }, 0)).toBe("平均步频暂无样本");
	expect(averageSpeed(3, 1770)).toBe(1.69);
	expect(matchSpeed({ ...response, tick: 3, gameTimeMs: 1770 })).toBe(
		"平均 1.69 格 / 秒",
	);
	expect(matchSpeed({ ...response, tick: 3, gameTimeMs: 1770 }, 10000)).toBe(
		"平均 0.3 格 / 秒",
	);
});

test("display time advances from a received monotonic sample without modifying the stored state", () => {
	const state = publicState(initial);
	const original = structuredClone(state);
	const sample = { elapsedGameTimeMs: 1770, receivedAt: 200 };
	expect(elapsedAt(sample, 10200)).toBe(11770);
	expect(elapsedAt(sample, 150)).toBe(1770);
	expect(state).toEqual(original);
});

test("response replay preserves variable gaps and same-time sequence order at each playback rate", () => {
	const responseRows = [
		event(0, 0, 0, "started"),
		event(1, 0, 120, "action_accepted"),
		event(2, 1, 120, "move"),
		event(3, 1, 470, "action_accepted"),
		event(4, 2, 470, "apple"),
		event(5, 2, 1770, "action_accepted"),
		event(6, 3, 1770, "move"),
		event(7, 4, 1770, "gameover"),
	];
	for (const rate of [0.5, 1, 2, 4]) {
		const frame = (elapsed: number) =>
			atTime(responseRows, playbackTimeAt(120, elapsed, rate, 1770));
		expect(frame(349 / rate)).toBe(2);
		expect(frame(350 / rate)).toBe(4);
		expect(frame(1649 / rate)).toBe(4);
		expect(frame(1650 / rate)).toBe(7);
	}
	expect(nextStep(responseRows, 2)).toBe(4);
	expect(nextStep(responseRows, 4)).toBe(6);
	expect(nextStep(responseRows, 6)).toBe(7);
	expect(previousStep(responseRows, 7)).toBe(6);
	// Resuming during a long wait retains the playhead, rather than replaying
	// the delay since the last committed event.
	expect(playbackTimeAt(1000, 100, 2, 1770)).toBe(1200);
	expect(playbackTimeAt(1700, 100, 2, 1770)).toBe(1770);
});

test("v3 response replay loads original confirmed snapshots without model requests or synthetic moves", async () => {
	const response = publicState(
		createState(
			"response-replay",
			"Response test",
			null,
			{
				width: 24,
				height: 18,
				obstacleCount: 0,
				seed: "response",
				stepMode: "response",
				tickIntervalMs: null,
			},
			"now",
		),
	);
	const records = [0, 120, 470, 1770].map((gameTimeMs, seq) => ({
		...event(seq, seq, gameTimeMs, seq === 0 ? "started" : "move"),
		matchId: response.id,
		state: {
			...response,
			seq,
			tick: seq,
			gameTimeMs,
			...(seq ? { lastStepDurationMs: [120, 350, 1300][seq - 1] } : {}),
		},
	}));
	expect(response.recordVersion).toBe(3);
	const transport = vi.fn().mockResolvedValue(
		Response.json({
			events: records,
			nextSeq: 3,
			latestSeq: 3,
			hasMore: false,
		}),
	);
	vi.stubGlobal("fetch", transport);
	expect(await allEvents(response.id)).toEqual(records);
	expect(transport).toHaveBeenCalledOnce();
	expect(transport.mock.calls[0][0]).toBe(
		`/api/matches/${response.id}/events?afterSeq=-1`,
	);
});

const legacyContexts = JSON.parse(
	readFileSync(
		new URL("./fixtures/context-legacy.json", import.meta.url),
		"utf8",
	),
) as { v1: LegacyDecisionRequest; unversioned: LegacyDecisionRequest };
const v2Contexts = JSON.parse(
	readFileSync(new URL("./fixtures/context-v2.json", import.meta.url), "utf8"),
) as { opening: { single: LegacyDecisionRequest; plan: LegacyPlanRequest } };

test("decision input preserves historical JSON and leaves missing cost diagnostics unrecorded", () => {
	for (const request of [
		legacyContexts.unversioned,
		legacyContexts.v1,
		v2Contexts.opening.single,
		v2Contexts.opening.plan,
	]) {
		const saved = structuredClone(request);
		const view = presentDecisionContext(request);
		expect(view.request).toBe(request);
		expect(view.version).toBe(
			request.state.contextVersion ?? "未记录（旧格式）",
		);
		expect(view.contextBuildMs).toBe("未记录");
		expect(view.requestBytes).toBe("未记录");
		expect(view.semantics).toContain("旧坐标 context");
		expect(JSON.parse(view.json ?? "")).toEqual(saved);
		expect(request).toEqual(saved);
	}
	expect(presentDecisionContext(undefined).json).toBeUndefined();
});

test("historical action-facts input presents saved costs without needing coordinate lists", () => {
	const state = publicState(initial);
	for (const request of [decisionBodyV5(state), planBody(state)]) {
		const saved = structuredClone(request);
		const view = presentDecisionContext(request, {
			contextBuildMs: 0,
			requestBytes: 12345,
		});
		expect(view.request).toBe(request);
		expect(view.version).toBe(request.state.contextVersion);
		expect(view.contextBuildMs).toBe("0.000 ms");
		expect(view.requestBytes).toBe("12345 字节");
		expect(view.semantics).toContain("程序计算");
		expect(view.semantics).toContain("JEV 选择方向");
		expect(view.semantics).toContain("不保证存活");
		expect(view.probabilityNote).toContain("不是存活概率");
		expect(request.state.player).not.toHaveProperty("bodyHeadToTail");
		expect(request.state.board).not.toHaveProperty("obstacles");
		expect(JSON.parse(view.json ?? "")).toEqual(saved);
		expect(request).toEqual(saved);
	}
	const diagnostics = { contextBuildMs: 3.0909169999999904 };
	expect(
		presentDecisionContext(decisionBodyV5(state), diagnostics).contextBuildMs,
	).toBe("3.091 ms");
	expect(diagnostics.contextBuildMs).toBe(3.0909169999999904);
});

test("v6 decision input presents the saved full board and history without action analysis", () => {
	const progress: DecisionProgress = {
		historyVersion: "progress-v1",
		historyStartTick: 0,
		throughTick: 19,
		lastAppleTick: 7,
		movesSinceApple: 12,
		positionVisits: 2,
		previousVisitTick: 11,
		repeatAfterMoves: 8,
		actions: {
			up: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
			right: { timesTaken: 1, returnsWithoutApple: 1, lastTakenTick: 11 },
			down: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
			left: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
		},
	};
	const request = structuredClone(historicalBoardRequest);
	request.state.progress = progress;
	const saved = structuredClone(request);
	const view = presentDecisionContext(request, {
		contextBuildMs: 0.25,
		requestBytes: 3456,
	});
	expect(view.request).toBe(request);
	expect(view.boardRequest).toBe(request);
	expect(view.immediateRequest).toBeUndefined();
	expect(view.observedRequest).toBeUndefined();
	expect(view.localSearchRequest).toBeUndefined();
	expect(view.head).toEqual({ x: 3, y: 2 });
	expect(request.state.player).not.toHaveProperty("head");
	expect(view.version).toBe("board-state-v6");
	expect(view.semantics).toContain("完整真实棋盘");
	expect(view.semantics).toContain("由模型自行判断");
	expect(view.semantics).toContain("连续 12 步未吃苹果");
	expect(view.semantics).toContain("距上次相同局面 8 步");
	expect(view.semantics).not.toMatch(/程序计算|路径|死亡证明|路线见证/);
	expect(view.contextBuildMs).toBe("0.250 ms");
	expect(view.requestBytes).toBe("3456 字节");
	expect(view.json).toBe(JSON.stringify(saved, null, 2));
	expect(request).toEqual(saved);
});

test("v7 decision input presents stored immediate facts and original question without reconstructing the board", () => {
	const state = publicState({
		...initial,
		config: {
			...initial.config,
			stepMode: "response",
			decisionMode: "single_step",
		},
		tick: 19,
		snake: [
			{ x: 3, y: 2 },
			{ x: 2, y: 2 },
			{ x: 1, y: 2 },
		],
		direction: "right",
		obstacles: [{ x: 3, y: 3 }],
		apple: { x: 5, y: 2 },
		star: null,
	});
	const progress: DecisionProgress = {
		historyVersion: "progress-v1",
		historyStartTick: 0,
		throughTick: 19,
		lastAppleTick: 7,
		movesSinceApple: 12,
		positionVisits: 2,
		previousVisitTick: 11,
		repeatAfterMoves: 8,
		actions: {
			up: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
			right: { timesTaken: 1, returnsWithoutApple: 1, lastTakenTick: 11 },
			down: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
			left: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
		},
	};
	const request = decisionBodyV7(state, "test-model", undefined, progress);
	const saved = structuredClone(request);
	const view = presentDecisionContext(request, {
		contextBuildMs: 0.25,
		requestBytes: 4567,
	});
	expect(view.request).toBe(request);
	expect(view.boardRequest).toBe(request);
	expect(view.immediateRequest).toBe(request);
	expect(view.observedRequest).toBeUndefined();
	expect(view.localSearchRequest).toBeUndefined();
	expect(view.head).toEqual({ x: 3, y: 2 });
	expect(view.version).toBe("local-moves-v7");
	expect(view.immediateRequest?.state.immediateMoves).toMatchObject({
		up: { legal: true, appleProgress: "farther" },
		right: {
			legal: true,
			appleProgress: "closer",
			departureHistory: "returned_without_apple",
		},
		down: {
			target: { x: 3, y: 3 },
			legal: false,
			blockedBy: "obstacle",
			destination: "obstacle",
		},
		left: { legal: false, blockedBy: "reverse" },
	});
	expect(view.semantics).toContain("本步规则事实");
	expect(view.semantics).toContain("由 JEV 选择方向");
	expect(view.semantics).toContain("不是推荐路线");
	expect(view.semantics).toContain("不保证多步安全");
	expect(view.semantics).toContain("连续 12 步未吃苹果");
	expect(view.contextBuildMs).toBe("0.250 ms");
	expect(view.requestBytes).toBe("4567 字节");
	expect(view.json).toBe(JSON.stringify(saved, null, 2));
	expect(request).toEqual(saved);
	// The view retains stored wording even if today's builder changes it.
	request.state.immediateMoves.down.description = "Archived explanation";
	expect(JSON.parse(presentDecisionContext(request).json ?? "")).toEqual(
		request,
	);
});

test("v8 replay presents the stored global snapshot without inferring dynamic routes or a tail dead end", () => {
	const state = publicState({
		...initial,
		config: {
			...initial.config,
			width: 8,
			height: 6,
			obstacleCount: 1,
			stepMode: "response",
			decisionMode: "single_step",
		},
		snake: [
			{ x: 2, y: 2 },
			{ x: 2, y: 3 },
			{ x: 1, y: 3 },
			{ x: 1, y: 2 },
		],
		direction: "up",
		obstacles: [{ x: 7, y: 5 }],
		apple: { x: 5, y: 2 },
		star: null,
	});
	const request = decisionBodyV8(state, "test-model");
	const saved = structuredClone(request);
	const view = presentDecisionContext(request, {
		contextBuildMs: 0.5,
		requestBytes: 5678,
	});
	expect(view.request).toBe(request);
	expect(view.boardRequest).toBe(request);
	expect(view.immediateRequest).toBe(request);
	expect(view.observedRequest).toBe(request);
	expect(view.localSearchRequest).toBeUndefined();
	expect(view.head).toEqual({ x: 2, y: 2 });
	expect(view.version).toBe("global-view-v8");
	expect(view.observedRequest?.state.observedSpace).toMatchObject({
		basis: "current_occupancy",
		regions: [{ cells: 43, containsApple: true }],
		moves: {
			right: { entry: "open_cell", region: { cells: 43, containsApple: true } },
			left: {
				entry: "vacating_tail",
				region: null,
				openAdjacentDirections: ["up", "left"],
				openAdjacentCells: 2,
			},
			down: { entry: "blocked", region: null },
		},
	});
	expect(view.immediateRequest?.state.immediateMoves.left).not.toHaveProperty(
		"appleProgress",
	);
	expect(view.semantics).toContain("当前占用快照");
	expect(view.semantics).toContain("由 JEV 选择方向");
	expect(view.semantics).toContain("不等于动态可达性");
	expect(view.semantics).toContain("不是必死或安全证明");
	expect(view.semantics).not.toContain("苹果距离变化");
	expect(
		observedRegionDescription(request.state.observedSpace.moves.right),
	).toBe("43 格 · 含当前苹果");
	const tailDescription = observedRegionDescription(
		request.state.observedSpace.moves.left,
	);
	expect(tailDescription).toContain("区域信息不适用");
	expect(tailDescription).not.toMatch(/0|零|死路|必死/);
	expect(view.contextBuildMs).toBe("0.500 ms");
	expect(view.requestBytes).toBe("5678 字节");
	expect(view.json).toBe(JSON.stringify(saved, null, 2));
	expect(request).toEqual(saved);
	// A stored snapshot is displayed verbatim, not recomputed from today's board.
	request.state.observedSpace.regions[0].cells = 17;
	const archived = presentDecisionContext(request);
	expect(archived.observedRequest?.state.observedSpace.regions[0].cells).toBe(
		17,
	);
	expect(JSON.parse(archived.json ?? "")).toEqual(request);
});

test("v9 replay retains the full board, occupancy and recorded bounded search without recomputing evidence", () => {
	const state = publicState(
		createState(
			"bounded-replay",
			"Test",
			null,
			{
				...initial.config,
				width: 8,
				height: 6,
				obstacleCount: 1,
				stepMode: "response",
				decisionMode: "single_step",
				seed: "bounded-replay",
			},
			"now",
		),
	);
	const request = decisionBodyV9(state, "test-model");
	const saved = structuredClone(request);
	const view = presentDecisionContext(request, {
		contextBuildMs: 1.25,
		requestBytes: 6789,
	});
	expect(view.version).toBe("bounded-search-v9");
	expect(view.request).toBe(request);
	expect(view.boardRequest).toBe(request);
	expect(view.immediateRequest).toBe(request);
	expect(view.observedRequest).toBe(request);
	expect(view.localSearchRequest).toBe(request);
	expect(view.head).toEqual(state.snake[0]);
	expect(view.semantics).toContain("深度和节点预算");
	expect(view.semantics).toContain("未知不代表安全或必死");
	expect(view.semantics).toContain("有限步可存活不保证长期安全");
	expect(view.semantics).toContain("不自动沿见证路线移动");
	expect(view.semantics).not.toContain("吃果后的乐观检查");
	expect(view.contextBuildMs).toBe("1.250 ms");
	expect(view.requestBytes).toBe("6789 字节");
	expect(view.json).toBe(JSON.stringify(saved, null, 2));
	expect(request).toEqual(saved);
	// Historical configured budgets are displayed as saved rather than replaced
	// with today's defaults or used to rerun the search on the replay board.
	request.state.localSearch.maxDepth = 99;
	const archived = presentDecisionContext(request);
	expect(archived.localSearchRequest?.state.localSearch.maxDepth).toBe(99);
	expect(JSON.parse(archived.json ?? "")).toEqual(request);
});

test("v10 replay shows saved optimistic post-apple evidence and preserves the shared search budgets", () => {
	const state = publicState(
		createState(
			"post-apple-replay",
			"Test",
			null,
			{
				...initial.config,
				width: 8,
				height: 6,
				obstacleCount: 1,
				stepMode: "response",
				decisionMode: "single_step",
				seed: "post-apple-replay",
			},
			"now",
		),
	);
	const request = decisionBodyV10(state, "test-model");
	const saved = structuredClone(request);
	const view = presentDecisionContext(request);
	expect(view.version).toBe("post-apple-v10");
	expect(view.request).toBe(request);
	expect(view.boardRequest).toBe(request);
	expect(view.immediateRequest).toBe(request);
	expect(view.observedRequest).toBe(request);
	expect(view.localSearchRequest).toBe(request);
	expect(view.head).toEqual(state.snake[0]);
	expect(view.semantics).toContain("吃果后的乐观检查假设不再增长");
	expect(view.semantics).toContain("不保证真实未来安全");
	expect(view.semantics).toContain("吃后节点已计入总数");
	expect(view.semantics).toContain("包含重复访问，不是唯一不同路线数");
	expect(view.semantics).toContain("不生成或预测新苹果");
	expect(view.semantics).toContain("不自动沿见证路线移动");
	expect(view.json).toBe(JSON.stringify(saved, null, 2));
	expect(request).toEqual(saved);
	request.state.localSearch.moves.up.rejectedAppleEndpoints = 17;
	const archived = presentDecisionContext(request);
	expect(
		archived.localSearchRequest?.state.localSearch.moves.up,
	).toHaveProperty("rejectedAppleEndpoints", 17);
	expect(JSON.parse(archived.json ?? "")).toEqual(request);
});

test("v11 replay shows the original board and real history with only model-chosen direction meanings", () => {
	const state = publicState({
		...initial,
		config: {
			...initial.config,
			stepMode: "response",
			decisionMode: "single_step",
		},
		tick: 19,
	});
	const progress: DecisionProgress = {
		historyVersion: "progress-v1",
		historyStartTick: 0,
		throughTick: 19,
		lastAppleTick: 7,
		movesSinceApple: 12,
		positionVisits: 2,
		previousVisitTick: 11,
		repeatAfterMoves: 8,
		actions: {
			up: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
			right: { timesTaken: 1, returnsWithoutApple: 1, lastTakenTick: 11 },
			down: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
			left: { timesTaken: 0, returnsWithoutApple: 0, lastTakenTick: null },
		},
	};
	const request = decisionBodyV11(state, "test-model", undefined, progress);
	const saved = structuredClone(request);
	const view = presentDecisionContext(request);
	expect(view.version).toBe("model-planning-v11");
	expect(view.request).toBe(request);
	expect(view.boardRequest).toBe(request);
	expect(view.modelPlanningRequest).toBe(request);
	expect(view.immediateRequest).toBeUndefined();
	expect(view.observedRequest).toBeUndefined();
	expect(view.localSearchRequest).toBeUndefined();
	expect(view.head).toEqual(state.snake[0]);
	expect(view.semantics).toContain("自行理解局面、规划路线并决定下一步方向");
	expect(view.semantics).toContain("四个选项只说明方向含义");
	expect(view.semantics).toContain("只按游戏规则校验并执行模型选择");
	expect(view.semantics).toContain("连续 12 步未吃苹果");
	expect(view.semantics).not.toMatch(/局部搜索|吃后检查|即时出口|程序计算/);
	for (const property of [
		"immediateMoves",
		"observedSpace",
		"localSearch",
		"actionFacts",
		"witnessContinuity",
	])
		expect(request.state).not.toHaveProperty(property);
	for (const direction of directions)
		expect(
			Object.keys(request.questions.direction.criteria[direction]),
		).toEqual(["meaning"]);
	expect(
		savedDirectionOptions(request).map((option) => option.direction),
	).toEqual(directions);
	expect(view.json).toBe(JSON.stringify(saved, null, 2));
	expect(request).toEqual(saved);
	request.questions.direction.instructions =
		"Archived independent model instructions";
	const archived = presentDecisionContext(request);
	expect(archived.modelPlanningRequest?.questions.direction.instructions).toBe(
		"Archived independent model instructions",
	);
	expect(JSON.parse(archived.json ?? "")).toEqual(request);
});

test("replay displays the saved character map verbatim and never adds one to an older v11 request", () => {
	const request = decisionBodyV11(
		publicState({
			...initial,
			config: {
				...initial.config,
				stepMode: "response",
				decisionMode: "single_step",
			},
		}),
	);
	const ascii = savedBoardAscii(request);
	expect(ascii).toBe(request.state.board.ascii);
	expect(ascii?.legend).toEqual(expect.any(String));
	expect(ascii?.map).toContain("\n");
	const saved = structuredClone(request);
	expect(presentDecisionContext(request).json).toBe(
		JSON.stringify(saved, null, 2),
	);
	expect(request).toEqual(saved);
	// Preserve all saved whitespace and wording instead of formatting coordinates
	// again using today's map renderer or the current replay board.
	request.state.board.ascii = {
		legend: "Archived legend",
		map: "  saved map  \n  A . #    \n",
	};
	expect(savedBoardAscii(request)).toEqual({
		legend: "Archived legend",
		map: "  saved map  \n  A . #    \n",
	});
	expect(JSON.parse(presentDecisionContext(request).json ?? "")).toEqual(
		request,
	);
	const legacy = structuredClone(saved);
	delete legacy.state.board.ascii;
	const originalLegacy = structuredClone(legacy);
	expect(savedBoardAscii(legacy)).toBeUndefined();
	expect(presentBoardAscii(legacy)).toBeUndefined();
	expect(savedBoardAscii(historicalBoardRequest)).toBeUndefined();
	expect(presentDecisionContext(legacy).modelPlanningRequest).toBe(legacy);
	expect(presentDecisionContext(legacy).json).toBe(
		JSON.stringify(originalLegacy, null, 2),
	);
	expect(legacy).toEqual(originalLegacy);
});

test("named-cell replay draws a labelled compact board from saved coordinates while retaining the exact sent text", () => {
	const state = publicState({
		...initial,
		config: {
			...initial.config,
			width: 8,
			height: 6,
			obstacleCount: 1,
			stepMode: "response",
			decisionMode: "single_step",
		},
		tick: 18,
		snake: [
			{ x: 3, y: 2 },
			{ x: 2, y: 2 },
			{ x: 1, y: 2 },
			{ x: 0, y: 2 },
		],
		direction: "right",
		obstacles: [{ x: 1, y: 3 }],
		apple: { x: 6, y: 4 },
		star: { point: { x: 7, y: 5 }, expiresAt: 5000 },
	});
	const request = decisionBody(state);
	const symbol = presentBoardAscii(request);
	expect(symbol?.redrawn).toBe(false);
	expect(symbol?.title).toBe("模型决策前的字符图（历史输入）");
	expect(symbol?.map).toBe(request.state.board.ascii?.map);
	expect(symbol?.legend).toBe(request.state.board.ascii?.legend);
	expect(symbol?.originalNamedText).toBeUndefined();
	request.state.board.ascii = renderNamedBoard({
		width: state.config.width,
		height: state.config.height,
		obstacles: state.obstacles,
		bodyHeadToTail: state.snake,
		apple: state.apple,
		star: state.star?.point ?? null,
	});
	const saved = structuredClone(request);
	const view = presentBoardAscii(request);
	expect(view?.redrawn).toBe(true);
	expect(view?.title).toBe(
		"模型决策前的字符图（历史输入，按本次输入坐标重绘）",
	);
	expect(view?.map).toBe(
		[
			"y\\x 0 1 2 3 4 5 6 7",
			"  0 . . . . . . . .",
			"  1 . . . . . . . .",
			"  2 T B B H . . . .",
			"  3 . # . . . . . .",
			"  4 . . . . . . A .",
			"  5 . . . . . . . *",
		].join("\n"),
	);
	expect(view?.originalNamedText).toBe(request.state.board.ascii);
	expect(view?.originalNamedText?.map).toContain("(3,2)=HEAD");
	expect(savedBoardAscii(request)).toEqual(saved.state.board.ascii);
	expect(presentDecisionContext(request).json).toBe(
		JSON.stringify(saved, null, 2),
	);
	expect(savedBoardObservationLabel(request, 19)).toBe(
		"第 18 步观察（执行前），用于决定第 19 步；主棋盘当前第 19 步。",
	);
	expect(request).toEqual(saved);
	const withoutAscii = structuredClone(request);
	delete withoutAscii.state.board.ascii;
	expect(presentBoardAscii(withoutAscii)).toBeUndefined();
});

test("replay displays saved strategy guidance and leaves earlier v11 requests unchanged", () => {
	const request = decisionBodyV11(
		publicState({
			...initial,
			config: {
				...initial.config,
				stepMode: "response",
				decisionMode: "single_step",
			},
		}),
	);
	const guide = savedStrategyGuide(request);
	expect(guide).toEqual(expect.any(String));
	expect(guide).toBe(request.state.strategyGuide);
	expect(request.questions.direction.instructions).toContain(guide);
	const saved = structuredClone(request);
	expect(presentDecisionContext(request).json).toBe(
		JSON.stringify(saved, null, 2),
	);
	expect(request).toEqual(saved);
	request.state.strategyGuide =
		"  Archived strategy guidance\nPreserve original wording and whitespace.  ";
	expect(savedStrategyGuide(request)).toBe(
		"  Archived strategy guidance\nPreserve original wording and whitespace.  ",
	);
	expect(JSON.parse(presentDecisionContext(request).json ?? "")).toEqual(
		request,
	);
	const legacy = structuredClone(saved);
	delete legacy.state.strategyGuide;
	const originalLegacy = structuredClone(legacy);
	expect(savedStrategyGuide(legacy)).toBeUndefined();
	expect(savedStrategyGuide(historicalBoardRequest)).toBeUndefined();
	expect(presentDecisionContext(legacy).modelPlanningRequest).toBe(legacy);
	expect(presentDecisionContext(legacy).json).toBe(
		JSON.stringify(originalLegacy, null, 2),
	);
	expect(legacy).toEqual(originalLegacy);
});

test("v12 replay displays only saved non-reverse choices while retaining the full board and strategy", () => {
	const state = publicState({
		...initial,
		config: {
			...initial.config,
			stepMode: "response",
			decisionMode: "single_step",
		},
		direction: "right",
	});
	const request = decisionBodyV12(state, "test-model");
	const saved = structuredClone(request);
	const view = presentDecisionContext(request);
	expect(view.version).toBe("non-reverse-v12");
	expect(view.request).toBe(request);
	expect(view.boardRequest).toBe(request);
	expect(view.modelPlanningRequest).toBe(request);
	expect(view.immediateRequest).toBeUndefined();
	expect(view.observedRequest).toBeUndefined();
	expect(view.localSearchRequest).toBeUndefined();
	expect(savedDirectionOptions(request)).toEqual([
		{
			direction: "up",
			meaning: request.questions.direction.criteria.up?.meaning,
		},
		{
			direction: "right",
			meaning: request.questions.direction.criteria.right?.meaning,
		},
		{
			direction: "down",
			meaning: request.questions.direction.criteria.down?.meaning,
		},
	]);
	expect(
		savedDirectionOptions(request).map((option) => option.direction),
	).not.toContain("left");
	expect(savedBoardAscii(request)).toEqual(request.state.board.ascii);
	expect(savedStrategyGuide(request)).toBe(request.state.strategyGuide);
	expect(view.semantics).toContain("选项排除观察时朝向的直接反向");
	expect(view.semantics).toContain("这些方向仍可能撞墙或蛇身");
	expect(view.semantics).not.toContain("四个选项");
	expect(view.json).toBe(JSON.stringify(saved, null, 2));
	expect(request).toEqual(saved);
	// Display the exact saved choices, without reconstructing options from the
	// current board or today's direction-filtering rule.
	delete request.questions.direction.criteria.up;
	expect(
		savedDirectionOptions(request).map((option) => option.direction),
	).toEqual(["right", "down"]);
	expect(JSON.parse(presentDecisionContext(request).json ?? "")).toEqual(
		request,
	);
});

test("missing v12 probabilities are explicitly absent and historical four-option probabilities remain unchanged", () => {
	const state = publicState({
		...initial,
		config: {
			...initial.config,
			stepMode: "response",
			decisionMode: "single_step",
		},
		direction: "right",
	});
	const request = decisionBodyV12(state);
	const probabilities = { up: 0.2, right: 0, down: 0.3 };
	const original = structuredClone(probabilities);
	expect(savedProbabilityGaps(request, probabilities)).toEqual([
		{ direction: "left", status: "不在选项" },
	]);
	expect(savedProbabilityGaps(request, { right: 0, down: 0.3 })).toEqual([
		{ direction: "up", status: "未提供" },
		{ direction: "left", status: "不在选项" },
	]);
	expect(probabilities).toEqual(original);
	expect(
		Object.values(probabilities).reduce((total, value) => total + value, 0),
	).toBe(0.5);
	expect(probabilities).not.toHaveProperty("left");
	const historical = decisionBodyV11(state);
	const allFour = { ...probabilities, left: 0.5 };
	expect(savedDirectionOptions(historical)).toHaveLength(4);
	expect(savedProbabilityGaps(historical, allFour)).toEqual([]);
	expect(allFour).toEqual({ up: 0.2, right: 0, down: 0.3, left: 0.5 });
	// Older sparse probability records keep their existing display as well.
	expect(savedProbabilityGaps(historical, probabilities)).toEqual([]);
});

test("post-apple wording never treats optimistic survival or an early possible win as real-world safety", () => {
	const check: PostAppleCheck = {
		assumption: "no_further_growth",
		result: "survival_possible",
		maxDepth: 5,
		maxDepthReached: 5,
		expandedNodes: 13,
		cutoff: "depth",
	};
	expect(postAppleDescription(check)).toContain("不再增长的乐观假设");
	expect(postAppleDescription(check)).toContain("尚未证明死亡");
	expect(postAppleDescription(check)).toContain("不保证真实未来安全");
	expect(
		postAppleDescription({ ...check, result: "unknown", cutoff: "nodes" }),
	).toContain("不能当作安全或必死");
	expect(postAppleCutoffDescription("depth")).toContain(
		"整条路径剩余的深度上限",
	);
	expect(postAppleCutoffDescription("nodes")).toContain("共享节点预算耗尽");
	expect(postAppleCutoffDescription("possible_win")).toContain(
		"未排除未来提前填满棋盘的可能",
	);
	expect(postAppleCutoffDescription("possible_win")).toContain("停止死亡证明");
	expect(localSearchCutoffDescription("apple", "post-apple-v10")).toContain(
		"吃后检查结果另列",
	);
	expect(
		localSearchCutoffDescription("apple", "bounded-search-v9"),
	).not.toContain("吃后检查结果另列");
});

test("new map layouts preserve the seeded snake appearance during replay", () => {
	const classic = snakeColors({ seed: "a", layoutVersion: 1 });
	const seeded = ["a", "b", "c", "seed-99"].map((seed) => {
		const previous = snakeColors({ seed, layoutVersion: 2 });
		expect(snakeColors({ seed, layoutVersion: 3 })).toEqual(previous);
		return previous;
	});
	expect(
		seeded.some(
			(palette) => JSON.stringify(palette) !== JSON.stringify(classic),
		),
	).toBe(true);
});

test("bounded search wording distinguishes proof, current-apple witnesses and incomplete survival searches", () => {
	const move: LocalSearchMove = {
		status: "unknown",
		expandedNodes: 10,
		nodeBudget: 10,
		maxDepthReached: 2,
		cutoff: "nodes",
		witness: null,
		appleExitDirections: null,
	};
	expect(localSearchDescription(move)).toContain("未完成判断");
	expect(localSearchDescription(move)).toContain("未知不代表安全或必死");
	expect(localSearchDescription(move)).not.toContain("已证明");
	expect(
		localSearchDescription({ ...move, status: "blocked", cutoff: "none" }),
	).toContain("本步被阻挡");
	expect(
		localSearchDescription({ ...move, status: "proven_dead", cutoff: "none" }),
	).toContain("已证明必死");
	expect(
		localSearchDescription({
			...move,
			status: "apple_reachable",
			cutoff: "apple",
			witness: ["up", "right"],
			appleExitDirections: ["right", "down"],
		}),
	).toContain("新苹果与长期结果未知");
	const trappedApple = localSearchAppleExitDescription([]);
	expect(trappedApple).toContain("这条已验证路线吃后立即无出口");
	expect(trappedApple).toContain("不代表整个候选方向的所有路线都必死");
	const openApple = localSearchAppleExitDescription(["right", "down"]);
	expect(openApple).toContain("2 个即时出口");
	expect(openApple).toContain("只说明下一步可走");
	expect(openApple).toContain("不保证长期安全");
	expect(
		localSearchDescription({
			...move,
			status: "win_reachable",
			cutoff: "apple",
			witness: ["up"],
		}),
	).toContain("获胜路线");
	const partial = localSearchDescription({
		...move,
		status: "survival_found",
		witness: ["up", "right"],
	});
	expect(partial).toContain("有限步");
	expect(partial).toContain("搜索未完成");
	expect(partial).toContain("更远结果未知");
	const horizon = localSearchDescription({
		...move,
		status: "survival_found",
		cutoff: "depth",
		witness: ["up", "right"],
	});
	expect(horizon).toContain("更远结果未知");
	expect(horizon).not.toContain("节点预算耗尽");
	expect(localSearchCutoffDescription("nodes")).toContain("未完成剩余搜索");
	expect(localSearchCutoffDescription("depth")).toContain("未搜索更远局面");
	expect(localSearchCutoffDescription("apple")).toContain("不预测新苹果");
	expect(localSearchCutoffDescription("none")).toContain("未触发");
});

test("unknown context versions keep raw JSON available without assuming player or timing fields", () => {
	const request = {
		model: "future-context",
		state: { contextVersion: "action-facts-v99", futureFacts: ["原始记录"] },
	};
	const saved = structuredClone(request);
	const view = presentDecisionContext(request, { requestBytes: 987 });
	expect(view.version).toBe("action-facts-v99");
	expect(view.request).toBeUndefined();
	expect(view.semantics).toContain("暂不支持");
	expect(view.semantics).not.toContain("程序计算");
	expect(view.contextBuildMs).toBe("未记录");
	expect(view.requestBytes).toBe("987 字节");
	expect(JSON.parse(view.json ?? "")).toEqual(saved);
	expect(request).toEqual(saved);
});

test("a post-move replay keeps the pre-move input and aligns through its accepted frame without changing requests", () => {
	const observed = publicState({
		...initial,
		config: {
			...initial.config,
			width: 8,
			height: 6,
			obstacleCount: 0,
			stepMode: "response",
			decisionMode: "single_step",
		},
		tick: 18,
		snake: [
			{ x: 7, y: 2 },
			{ x: 7, y: 1 },
			{ x: 6, y: 1 },
			{ x: 5, y: 1 },
		],
		direction: "down",
		obstacles: [],
		apple: { x: 0, y: 5 },
		star: null,
	});
	const before = {
		...observed,
		tick: 17,
		direction: "right" as const,
		snake: [
			{ x: 7, y: 1 },
			{ x: 6, y: 1 },
			{ x: 5, y: 1 },
			{ x: 4, y: 1 },
		],
	};
	const after = {
		...observed,
		tick: 19,
		snake: [
			{ x: 7, y: 3 },
			{ x: 7, y: 2 },
			{ x: 7, y: 1 },
			{ x: 6, y: 1 },
		],
	};
	const savedDecision = (
		request: ReturnType<typeof decisionBody>,
		requestId: string,
	) => ({
		model: request.model,
		request,
		requestId,
		choice: "down" as const,
		probabilities: { down: 1 },
		confidence: 1,
		requestMs: 42,
		targetTick: request.state.timing.targetTick,
		outcome: "accepted",
	});
	const previousDecision = savedDecision(decisionBody(before), "previous");
	const currentDecision = savedDecision(decisionBody(observed), "current");
	const followingDecision = savedDecision(decisionBody(after), "following");
	const preceding = event(38, 17, 1700, "action_accepted");
	preceding.data = {
		requestId: "previous",
		observedSeq: 37,
		decision: previousDecision,
	};
	preceding.state = { ...before, seq: 38, lastDecision: previousDecision };
	const observation = event(39, 18, 1800, "move");
	observation.state = {
		...observed,
		seq: 39,
		lastDecision: previousDecision,
		lastAppliedAction: {
			source: "primary",
			direction: "down",
			tick: 18,
			targetTick: 18,
			observedTick: 17,
			requestId: "previous",
		},
	};
	const accepted = event(40, 18, 1842, "action_accepted");
	accepted.data = {
		requestId: "current",
		observedSeq: 39,
		decision: currentDecision,
	};
	accepted.state = {
		...observation.state,
		seq: 40,
		lastDecision: currentDecision,
	};
	const applied = event(41, 19, 1842, "move");
	applied.state = {
		...after,
		seq: 41,
		lastDecision: currentDecision,
		lastAppliedAction: {
			source: "primary",
			direction: "down",
			tick: 19,
			targetTick: 19,
			observedTick: 18,
			requestId: "current",
		},
	};
	const following = event(42, 19, 1884, "action_accepted");
	following.data = {
		requestId: "following",
		observedSeq: 41,
		decision: followingDecision,
	};
	following.state = {
		...applied.state,
		seq: 42,
		lastDecision: followingDecision,
	};
	const records = [preceding, observation, accepted, applied, following];
	const original = structuredClone(records);
	const selected = decisionForPosition(records, applied.state);
	expect(selected?.requestId).toBe("current");
	expect(presentDecisionContext(selected?.request).head).toEqual({
		x: 7,
		y: 2,
	});
	expect(applied.state.snake[0]).toEqual({ x: 7, y: 3 });
	expect(
		savedBoardObservationLabel(selected?.request, applied.state.tick),
	).toBe("第 18 步观察（执行前），用于决定第 19 步；主棋盘当前第 19 步。");
	expect(savedBoardObservationLabel(selected?.request)).toBe(
		"第 18 步观察（执行前），用于决定第 19 步。",
	);
	const frameSeq = decisionObservationFrame(accepted, applied.state.tick);
	expect(frameSeq).toBe(40);
	expect(frameSeq).not.toBe(accepted.data.observedSeq);
	const frame = records.find((row) => row.seq === frameSeq)!;
	expect(frame.state.snake).toEqual(observed.snake);
	expect(decisionForPosition(records, frame.state)?.requestId).toBe("current");
	expect(decisionForPosition(records, observation.state)?.requestId).toBe(
		"previous",
	);
	expect(decisionForPosition(records, following.state)?.requestId).toBe(
		"following",
	);
	expect(
		savedBoardAscii(decisionForPosition(records, frame.state)?.request),
	).toEqual(savedBoardAscii(selected?.request));
	expect(decisionObservationFrame(accepted, frame.state.tick)).toBeUndefined();
	expect(
		decisionObservationFrame(
			{ ...accepted, type: "action_rejected" },
			applied.state.tick,
		),
	).toBeUndefined();
	expect(
		decisionObservationFrame(
			{ ...accepted, type: "plan_accepted" },
			applied.state.tick,
		),
	).toBeUndefined();
	const projected = structuredClone(legacyContexts.v1);
	projected.state.timing = {
		stateIsProjected: true,
		projectedBeforeTick: 19,
		gameTimeMs: 1800,
		tickIntervalMs: 125,
	};
	const projectedFrame = {
		...accepted,
		state: {
			...accepted.state,
			lastDecision: { ...currentDecision, request: projected },
		},
	};
	expect(
		decisionObservationFrame(projectedFrame, applied.state.tick),
	).toBeUndefined();
	expect(
		savedBoardObservationLabel(projected, applied.state.tick),
	).toBeUndefined();
	const fixed = structuredClone(legacyContexts.v1);
	fixed.state.timing = {
		stateIsProjected: false,
		observedTick: 18,
		targetTick: 19,
		stepMode: "fixed",
		gameTimeMs: 1800,
		tickIntervalMs: 125,
	};
	expect(
		decisionObservationFrame(
			{
				...accepted,
				state: {
					...accepted.state,
					lastDecision: { ...currentDecision, request: fixed },
				},
			},
			applied.state.tick,
		),
	).toBeUndefined();
	expect(records).toEqual(original);
});

test("the current character board advances on seq 123 while historical input updates only at accepted seq 124", () => {
	const observed = publicState({
		...initial,
		config: {
			...initial.config,
			width: 10,
			height: 8,
			obstacleCount: 0,
			stepMode: "response",
			tickIntervalMs: null,
			decisionMode: "single_step",
		},
		tick: 60,
		snake: [
			{ x: 6, y: 7 },
			{ x: 7, y: 7 },
			{ x: 8, y: 7 },
			{ x: 9, y: 7 },
		],
		direction: "left",
		obstacles: [],
		apple: { x: 0, y: 0 },
		star: null,
	});
	const moved = {
		...observed,
		tick: 61,
		direction: "up" as const,
		snake: [
			{ x: 6, y: 6 },
			{ x: 6, y: 7 },
			{ x: 7, y: 7 },
			{ x: 8, y: 7 },
		],
	};
	const recorded = (state: typeof observed, requestId: string) => ({
		model: "test-model",
		request: decisionBody(state, "test-model"),
		requestId,
		choice: "up" as const,
		probabilities: { up: 1 },
		confidence: 1,
		requestMs: 42,
		targetTick: state.tick + 1,
		outcome: "accepted",
	});
	const first = recorded(observed, "input-at-60");
	const next = recorded(moved, "input-at-61");
	const accepted = event(122, 60, 6000, "action_accepted");
	accepted.data = {
		requestId: first.requestId,
		observedSeq: 121,
		decision: first,
	};
	accepted.state = { ...observed, seq: 122, lastDecision: first };
	const applied = event(123, 61, 6000, "move");
	applied.state = {
		...moved,
		seq: 123,
		lastDecision: first,
		lastAppliedAction: {
			source: "primary",
			direction: "up",
			tick: 61,
			targetTick: 61,
			observedTick: 60,
			requestId: first.requestId,
		},
	};
	const following = event(124, 61, 6042, "action_accepted");
	following.data = {
		requestId: next.requestId,
		observedSeq: 123,
		decision: next,
	};
	following.state = { ...applied.state, seq: 124, lastDecision: next };
	const records = [accepted, applied, following];
	const original = structuredClone(records);
	const headInMap = (map: string) => {
		const rows = map
			.split("\n")
			.slice(1)
			.map((line) => line.trim().split(/\s+/));
		const row = rows.find((cells) => cells.slice(1).includes("H"))!;
		return { x: row.slice(1).indexOf("H"), y: Number(row[0]) };
	};
	expect(headInMap(presentCurrentBoardAscii(accepted.state).map)).toEqual({
		x: 6,
		y: 7,
	});
	const currentAt123 = presentCurrentBoardAscii(applied.state);
	const historicalAt123 = decisionForPosition(records, applied.state);
	expect(currentAt123.title).toBe("当前回放棋盘字符图 · 第 61 步");
	expect(headInMap(currentAt123.map)).toEqual({ x: 6, y: 6 });
	expect(historicalAt123?.requestId).toBe("input-at-60");
	expect(headInMap(presentBoardAscii(historicalAt123?.request)!.map)).toEqual({
		x: 6,
		y: 7,
	});
	expect(presentBoardAscii(historicalAt123?.request)?.title).toBe(
		"模型决策前的字符图（历史输入）",
	);
	const currentAt124 = presentCurrentBoardAscii(following.state);
	const historicalAt124 = decisionForPosition(records, following.state);
	expect(currentAt124.map).toBe(currentAt123.map);
	expect(historicalAt124?.requestId).toBe("input-at-61");
	expect(headInMap(presentBoardAscii(historicalAt124?.request)!.map)).toEqual({
		x: 6,
		y: 6,
	});
	expect(decisionObservationFrame(accepted, applied.state.tick)).toBe(122);
	expect(records).toEqual(original);
});

test("switching accepted and rejected replay decisions retains original inputs independent of current board", () => {
	const requests = [
		legacyContexts.unversioned,
		legacyContexts.v1,
		v2Contexts.opening.single,
		decisionBodyV5(publicState(initial)),
		historicalBoardRequest,
		decisionBodyV7(
			publicState({
				...initial,
				config: {
					...initial.config,
					stepMode: "response",
					decisionMode: "single_step",
				},
			}),
		),
		decisionBodyV8(
			publicState({
				...initial,
				config: {
					...initial.config,
					stepMode: "response",
					decisionMode: "single_step",
				},
			}),
		),
		decisionBodyV9(
			publicState({
				...initial,
				config: {
					...initial.config,
					stepMode: "response",
					decisionMode: "single_step",
				},
			}),
		),
		decisionBodyV10(
			publicState({
				...initial,
				config: {
					...initial.config,
					stepMode: "response",
					decisionMode: "single_step",
				},
			}),
		),
		decisionBodyV11(
			publicState({
				...initial,
				config: {
					...initial.config,
					stepMode: "response",
					decisionMode: "single_step",
				},
			}),
		),
		decisionBody(
			publicState({
				...initial,
				config: {
					...initial.config,
					stepMode: "response",
					decisionMode: "single_step",
				},
			}),
		),
		{
			model: "future-context",
			state: { contextVersion: "action-facts-v99" },
		} as unknown as DecisionRequest,
	];
	const records = requests.map((request, seq) => {
		const decision = {
			model: request.model,
			request,
			requestId: `context-${seq}`,
			choice: "right" as const,
			probabilities: { right: 0.99 },
			confidence: 0.99,
			requestMs: 42,
			targetTick: seq + 1,
			outcome: seq % 2 ? "late_action" : "accepted",
		};
		const row = event(
			seq,
			seq,
			seq * 125,
			seq % 2 ? "action_rejected" : "action_accepted",
		);
		row.data = { requestId: decision.requestId, decision, observedSeq: seq };
		row.state.lastDecision = decision;
		row.state.snake = [{ x: 23, y: 17 }];
		return row;
	});
	const original = structuredClone(records);
	const transport = vi.fn();
	vi.stubGlobal("fetch", transport);
	for (const index of [0, 3, 1, 4, 5, 6, 7, 8, 9, 10, 11, 2, 0]) {
		const selected = decisionForPosition(records, records[index].state);
		const view = presentDecisionContext(selected?.request, selected);
		expect(view.json).toBe(JSON.stringify(requests[index], null, 2));
		expect(view.requestBytes).toBe("未记录");
	}
	expect(transport).not.toHaveBeenCalled();
	expect(records).toEqual(original);
});
