import { expect, test } from "vitest";
import { createState } from "../server/game/engine.js";
import { decisionBodyV13 } from "../server/jev/board-context.js";
import type { DecisionRequestV14 } from "../shared/snake/dynamic-space.js";
import type {
	DecisionRequestV15,
	GrowthMoveFacts,
	PostAppleCheck,
} from "../shared/snake/growth-space.js";
import { publicState } from "../shared/snake/types.js";
import {
	presentBoardAscii,
	presentDecisionContext,
	presentGrowthPostApple,
	presentGrowthSpaceMove,
	savedBoardAscii,
	savedBoardObservationLabel,
	savedDirectionOptions,
	savedProbabilityGaps,
} from "../src/features/snake/contextPresentation.js";

const game = createState(
	"growth-space-ui",
	"test",
	null,
	{
		width: 8,
		height: 8,
		obstacleCount: 0,
		tickIntervalMs: 125,
		seed: "growth-space-ui",
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
const historical = decisionBodyV13(publicState(game), "test-model");
const facts: GrowthMoveFacts = {
	trap: { status: "optimistic_horizon_reached", moves: 8, exploredNodes: 15 },
	apple: {
		status: "route_with_optimistic_continuation",
		moves: 2,
		nextLegalMoveCount: 2,
		canReachTail: true,
		exploredNodes: 3,
		termination: "found",
		postApple: {
			status: "optimistic_horizon_reached",
			moves: 8,
			exploredNodes: 9,
		},
		postAppleNodes: 23,
		rejectedTrapArrivals: 2,
	},
};
const request: DecisionRequestV15 = {
	model: historical.model,
	state: {
		...historical.state,
		contextVersion: "growth-space-v15",
		analysisLimits: {
			trapDepth: 8,
			appleDepth: 32,
			postAppleDepth: 8,
			maxNodesPerSearch: 2048,
		},
		dynamicFacts: { right: facts },
		dynamicSemantics: "Archived optimistic growth continuation facts.",
	},
	questions: {
		direction: {
			type: "choice",
			instructions: "Consider conditional post-apple evidence.",
			criteria: {
				right:
					"Two moves to the apple, then a conditional eight-move continuation.",
			},
		},
	},
};

test("V15 displays the exact archived board and body and preserves previous versions", () => {
	const before = JSON.stringify(request);
	const view = presentDecisionContext(request);
	expect(view.request).toBe(request);
	expect(view.boardRequest).toBe(request);
	expect(view.legalSpaceRequest).toBe(request);
	expect(view.growthSpaceRequest).toBe(request);
	expect(view.dynamicSpaceRequest).toBeUndefined();
	expect(view.semantics).toContain("吃果后不再增长是乐观条件");
	expect(view.semantics).toContain("不是模型方向");
	expect(view.semantics).toContain("不自动沿路线执行");
	expect(view.json).toBe(JSON.stringify(request, null, 2));
	expect(savedBoardAscii(request)).toBe(request.state.board.ascii);
	expect(presentBoardAscii(request)?.map).toBe(request.state.board.ascii!.map);
	expect(savedBoardObservationLabel(request, 13)).toContain(
		"第 12 步观察（执行前）",
	);
	expect(savedDirectionOptions(request)).toEqual([
		{ direction: "right", meaning: request.questions.direction.criteria.right },
	]);
	expect(JSON.stringify(request)).toBe(before);
	expect(presentDecisionContext(historical).growthSpaceRequest).toBeUndefined();
	expect(presentDecisionContext(historical).legalSpaceRequest).toBe(historical);
	const v14: DecisionRequestV14 = {
		...historical,
		state: {
			...historical.state,
			contextVersion: "dynamic-space-v14",
			analysisLimits: { trapDepth: 8, appleDepth: 32, maxNodesPerSearch: 2048 },
			dynamicSemantics: "Archived V14 one-exit check.",
			dynamicFacts: {
				right: {
					trap: { status: "unknown_after_apple", moves: 2, exploredNodes: 2 },
					apple: {
						status: "route_with_exit",
						moves: 2,
						nextLegalMoveCount: 2,
						canReachTail: true,
						exploredNodes: 3,
						termination: "found",
					},
				},
			},
		},
	};
	expect(presentDecisionContext(v14).dynamicSpaceRequest).toBe(v14);
	expect(presentDecisionContext(v14).growthSpaceRequest).toBeUndefined();
	expect(presentDecisionContext(v14).semantics).toContain("到达苹果后的未知");
});

test("V15 preserves actual probabilities, including zeros and missing outputs", () => {
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
	expect(presentDecisionContext(request).probabilityNote).toBe(
		"模型概率表示方向选项分布，不是存活概率。",
	);
});

test("V15 trap presentation separates conditional survival and near-win uncertainty from proof", () => {
	const trap = (
		status: GrowthMoveFacts["trap"]["status"],
		moves: number | null = 8,
	) =>
		presentGrowthSpaceMove({
			...facts,
			trap: { status, moves, exploredNodes: 32 },
		}).trap;
	expect(trap("proven_trap", 5)).toContain("最长还能移动 5 步");
	expect(trap("proven_trap", 5)).toContain("已排除未来提前填满棋盘的可能");
	expect(trap("horizon_reached")).toContain("未吃果续路");
	expect(trap("optimistic_horizon_reached")).toContain("不再增长的乐观条件");
	expect(trap("optimistic_horizon_reached")).toContain(
		"不保证未来刷果和增长后仍安全",
	);
	expect(trap("unknown_near_win", null)).toContain("这不等于已找到胜路");
	expect(trap("node_limit", null)).toContain("未知不代表安全或无路");
	expect(trap("board_complete", 3)).toContain("3 步填满棋盘的获胜分支");
	expect(trap("board_complete", 3)).not.toContain("本步填满");
});

test("V15 distinguishes apple-arrival moves from subsequent post-apple moves and cumulative budget", () => {
	const view = presentGrowthSpaceMove(facts);
	expect(view.apple).toContain("2 步吃到当前苹果");
	expect(view.postApple).toContain("继续移动 8 步");
	expect(view.postApple).toContain("不含吃果这一步");
	expect(view.postApple).toContain("不保证真实后续安全");
	expect(view.postAppleNodes).toBe("9 个节点（该到达方式）");
	expect(view.postAppleTotal).toBe(
		"23 个节点（本方向所有吃果到达方式累计，共享预算）",
	);
	expect(view.rejectedArrivals).toContain("2 次吃果到达检查");
	expect(view.rejectedArrivals).toContain("未因此移除该方向的 模型 选项");
	expect(view.appleExit).toContain("后续检查另列");
	expect(view.appleTail).toContain("不保证动态追尾可行");
	expect(view.appleTermination).toContain("不表示路线最短");
});

test("V15 post-apple zero continuation is a trapped arrival; unknown is not a passed safety check", () => {
	const trapped: PostAppleCheck = {
		status: "proven_trap",
		moves: 0,
		exploredNodes: 1,
	};
	expect(presentGrowthPostApple(trapped)).toContain("吃果后最多还能移动 0 步");
	expect(presentGrowthPostApple(trapped)).toContain("已排除未来提前满盘的可能");
	for (const status of ["unknown_near_win", "node_limit"] as const) {
		const view = presentGrowthSpaceMove({
			...facts,
			apple: {
				...facts.apple,
				status: "route_postcheck_unknown",
				termination:
					status === "node_limit" ? "postcheck_node_limit" : "exhausted",
				postApple: { status, moves: null, exploredNodes: 3 },
			},
		});
		expect(view.apple).toContain("不能当作已通过安全检查");
		expect(view.postApple).toContain(
			status === "node_limit" ? "结果未知" : "不等于已找到胜路",
		);
		if (status === "node_limit")
			expect(view.appleTermination).toContain("共享的后续检查预算耗尽");
	}
});

test("V15 no qualifying route leaves the direction offered and does not invent a zero exit or safety verdict", () => {
	for (const termination of [
		"exhausted",
		"depth_limit",
		"node_limit",
		"postcheck_node_limit",
	] as const) {
		const view = presentGrowthSpaceMove({
			...facts,
			apple: {
				status: "no_qualifying_route_found",
				moves: null,
				nextLegalMoveCount: null,
				canReachTail: null,
				exploredNodes: 20,
				termination,
				postApple: null,
				postAppleNodes: 30,
				rejectedTrapArrivals: 2,
			},
		});
		expect(view.apple).toContain("不等于当前苹果不可达");
		expect(view.appleExit).toBe("未提供候选路线结果");
		expect(view.postApple).toBe("未提供候选路线结果");
		expect(view.rejectedArrivals).toContain("未因此移除该方向");
	}
});

test("V15 multiple-move wins and absent apples do not imply a missing exit is a trap", () => {
	for (const status of ["route_wins", "no_apple"] as const) {
		const view = presentGrowthSpaceMove({
			...facts,
			apple: {
				status,
				moves: status === "route_wins" ? 3 : null,
				nextLegalMoveCount: null,
				canReachTail: null,
				exploredNodes: status === "route_wins" ? 3 : 0,
				termination: status === "route_wins" ? "found" : "not_applicable",
				postApple: null,
				postAppleNodes: 0,
				rejectedTrapArrivals: 0,
			},
		});
		expect(view.apple).toContain(
			status === "route_wins" ? "3 步吃到" : "不适用",
		);
		expect(view.postApple).toContain("不适用");
		expect(view.appleExit).not.toContain("0 个");
	}
});
