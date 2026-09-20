import { expect, test } from "vitest";
import { createState } from "../server/game/engine.js";
import { decisionBodyV11 } from "../server/jev/board-context.js";
import type {
	DecisionRequestV14,
	DynamicMoveFacts,
} from "../shared/snake/dynamic-space.js";
import type { DecisionRequestV13 } from "../shared/snake/legal-space.js";
import { publicState } from "../shared/snake/types.js";
import {
	presentBoardAscii,
	presentDecisionContext,
	presentDynamicSpaceMove,
	savedBoardAscii,
	savedBoardObservationLabel,
	savedDirectionOptions,
	savedProbabilityGaps,
} from "../src/features/snake/contextPresentation.js";

const game = createState(
	"dynamic-space-ui",
	"test",
	null,
	{
		width: 8,
		height: 8,
		obstacleCount: 0,
		tickIntervalMs: 125,
		seed: "dynamic-space-ui",
		stepMode: "response",
	},
	"now",
);
Object.assign(game, {
	tick: 12,
	direction: "right",
	snake: [
		{ x: 1, y: 0 },
		{ x: 0, y: 0 },
		{ x: 0, y: 1 },
		{ x: 0, y: 2 },
	],
	obstacles: [{ x: 1, y: 1 }],
	apple: { x: 3, y: 0 },
});
const historical = decisionBodyV11(publicState(game), "test-model");
const { strategyGuide: _guide, ...base } = historical.state;
const dynamic: DynamicMoveFacts = {
	trap: { status: "horizon_reached", moves: 8, exploredNodes: 19 },
	apple: {
		status: "route_with_exit",
		moves: 2,
		nextLegalMoveCount: 2,
		canReachTail: true,
		exploredNodes: 3,
		termination: "found",
	},
};
const request: DecisionRequestV14 = {
	model: historical.model,
	state: {
		...base,
		contextVersion: "dynamic-space-v14",
		moveFacts: {
			right: {
				target: { x: 2, y: 0 },
				turn: "straight",
				eatsApple: false,
				eatsStar: false,
				appleDistance: 1,
				lengthAfter: 4,
				freeCellsAfter: 59,
				reachableFreeCells: 59,
				canReachTail: true,
				nextLegalMoveCount: 2,
				deadEndRisk: false,
				terminal: null,
			},
		},
		excludedMoves: { up: "wall", down: "obstacle", left: "reverse" },
		factsSemantics: "Archived static facts.",
		analysisLimits: { trapDepth: 8, appleDepth: 12, maxNodesPerSearch: 2048 },
		dynamicFacts: { right: dynamic },
		dynamicSemantics:
			"Archived bounded dynamic facts; no future apple sampling.",
	},
	questions: {
		direction: {
			type: "choice",
			instructions: "Choose using the supplied static and dynamic facts.",
			criteria: {
				right: "Straight with an observed two-move apple candidate.",
			},
		},
	},
};

test("V14 preserves archived ASCII, criteria, static and dynamic inputs without rewriting history", () => {
	const before = JSON.stringify(request);
	const view = presentDecisionContext(request);
	expect(view.request).toBe(request);
	expect(view.boardRequest).toBe(request);
	expect(view.legalSpaceRequest).toBe(request);
	expect(view.dynamicSpaceRequest).toBe(request);
	expect(view.modelPlanningRequest).toBeUndefined();
	expect(view.semantics).toContain("模型仍从全部本步合法方向中选择");
	expect(view.semantics).toContain("不替换模型选择");
	expect(view.semantics).toContain("不把未知当安全或无路");
	expect(view.probabilityNote).toBe("模型概率表示方向选项分布，不是存活概率。");
	expect(view.json).toBe(JSON.stringify(request, null, 2));
	expect(savedBoardAscii(request)).toBe(request.state.board.ascii);
	expect(presentBoardAscii(request)?.map).toBe(request.state.board.ascii!.map);
	expect(savedBoardObservationLabel(request, 13)).toBe(
		"第 12 步观察（执行前），用于决定第 13 步；主棋盘当前第 13 步。",
	);
	expect(savedDirectionOptions(request)).toEqual([
		{ direction: "right", meaning: request.questions.direction.criteria.right },
	]);
	expect(JSON.stringify(request)).toBe(before);

	const {
		analysisLimits: _limits,
		dynamicFacts: _dynamicFacts,
		dynamicSemantics: _dynamicSemantics,
		...oldState
	} = request.state;
	const v13: DecisionRequestV13 = {
		...request,
		state: { ...oldState, contextVersion: "legal-space-v13" },
	};
	expect(presentDecisionContext(v13).dynamicSpaceRequest).toBeUndefined();
	expect(presentDecisionContext(v13).legalSpaceRequest).toBe(v13);
	expect(presentDecisionContext(historical).modelPlanningRequest).toBe(
		historical,
	);
});

test("V14 missing probabilities remain distinguishable from excluded and genuine zero", () => {
	const probabilities = { right: 0 };
	expect(savedProbabilityGaps(request, probabilities)).toEqual([
		{ direction: "up", status: "不在选项" },
		{ direction: "down", status: "不在选项" },
		{ direction: "left", status: "不在选项" },
	]);
	expect(savedProbabilityGaps(request, {})).toContainEqual({
		direction: "right",
		status: "未提供",
	});
	expect(probabilities).toEqual({ right: 0 });
});

test("V14 trap labels distinguish complete proof, survival horizon, food boundary and unfinished search", () => {
	const trap = (
		status: DynamicMoveFacts["trap"]["status"],
		moves: number | null,
	) =>
		presentDynamicSpaceMove({
			...dynamic,
			trap: { status, moves, exploredNodes: 24 },
		});
	expect(trap("proven_trap", 3).trap).toContain("最长还能移动 3 步");
	expect(trap("proven_trap", 3).trap).toContain("全部合法分支");
	expect(trap("proven_trap", 3).trap).toContain("包含本次候选移动");
	expect(trap("horizon_reached", 8).trap).toContain(
		"仅到达分析窗口，不代表长期安全",
	);
	expect(trap("unknown_after_apple", null).trap).toContain(
		"未证明此方向必困，也未证明安全",
	);
	expect(trap("node_limit", null).trap).toContain("未知不代表安全或无路");
	expect(trap("board_complete", 1).trap).toContain("填满棋盘的获胜分支");
	expect(trap("proven_trap", 3).trapNodes).toBe("24 个节点");
});

test("V14 apple witness reports growth exit and static tail adjacency without promising continued safety", () => {
	const view = presentDynamicSpaceMove(dynamic);
	expect(view.apple).toContain("2 步吃到当前苹果");
	expect(view.apple).toContain("不保证吃果后长期安全");
	expect(view.appleExit).toContain("2 个");
	expect(view.appleTail).toContain("不保证动态追尾可行");
	expect(view.appleTermination).toContain("不表示已比较全部进食路线");
	expect(view.appleNodes).toBe("3 个节点");
	expect(
		presentDynamicSpaceMove({
			...dynamic,
			apple: { ...dynamic.apple, canReachTail: false },
		}).appleTail,
	).toBe("增长后的蛇头及可达空域均不与蛇尾相邻");
});

test("V14 unsuccessful bounded apple search is not displayed as no route or zero exits", () => {
	for (const termination of [
		"depth_limit",
		"node_limit",
		"exhausted",
	] as const) {
		const view = presentDynamicSpaceMove({
			...dynamic,
			apple: {
				status: "no_route_with_exit_found",
				moves: null,
				nextLegalMoveCount: null,
				canReachTail: null,
				exploredNodes: 100,
				termination,
			},
		});
		expect(view.apple).toContain("不等于当前苹果不可达");
		expect(view.appleExit).toBe("未提供候选路线结果");
		expect(view.appleTail).toBe("未提供候选路线结果");
		if (termination !== "exhausted")
			expect(view.appleTermination).toMatch(/不能据此断言无路/);
	}
});

test("V14 winning or absent-apple results do not show a missing exit as a trap", () => {
	for (const status of ["route_wins", "no_apple"] as const) {
		const view = presentDynamicSpaceMove({
			...dynamic,
			apple: {
				status,
				moves: status === "route_wins" ? 1 : null,
				nextLegalMoveCount: null,
				canReachTail: null,
				exploredNodes: status === "route_wins" ? 1 : 0,
				termination: status === "route_wins" ? "found" : "not_applicable",
			},
		});
		expect(view.apple).toContain(
			status === "route_wins" ? "填满棋盘" : "分析不适用",
		);
		expect(view.appleExit).not.toContain("0 个");
		expect(view.appleTail).not.toContain("无路");
	}
});
