import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { createState } from "../server/game/engine";
import { decisionBody } from "../server/jev/client.js";
import { planBody } from "../server/jev/legacy-context.js";
import type {
	DecisionRequest,
	LegacyDecisionRequest,
	LegacyPlanRequest,
	MatchEvent,
} from "../shared/snake/types";
import { publicState, summary } from "../shared/snake/types";
import {
	allActiveMatches,
	allEvents,
	averageSpeed,
	matchSpeed,
	stepModeName,
} from "../src/features/snake/api";
import { presentDecisionContext } from "../src/features/snake/contextPresentation";
import {
	atTime,
	decisionForPosition,
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

test("v3 decision input presents saved costs and facts semantics without needing coordinate lists", () => {
	const state = publicState(initial);
	for (const request of [decisionBody(state), planBody(state)]) {
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
		presentDecisionContext(decisionBody(state), diagnostics).contextBuildMs,
	).toBe("3.091 ms");
	expect(diagnostics.contextBuildMs).toBe(3.0909169999999904);
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

test("switching accepted and rejected replay decisions retains original inputs independent of current board", () => {
	const requests = [
		legacyContexts.unversioned,
		legacyContexts.v1,
		v2Contexts.opening.single,
		decisionBody(publicState(initial)),
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
	for (const index of [0, 3, 1, 4, 2, 0]) {
		const selected = decisionForPosition(records, records[index].state);
		const view = presentDecisionContext(selected?.request, selected);
		expect(view.json).toBe(JSON.stringify(requests[index], null, 2));
		expect(view.requestBytes).toBe("未记录");
	}
	expect(transport).not.toHaveBeenCalled();
	expect(records).toEqual(original);
});
