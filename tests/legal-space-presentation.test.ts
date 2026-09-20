import { expect, test } from "vitest";
import { createState } from "../server/game/engine.js";
import { decisionBodyV11 } from "../server/jev/board-context.js";
import type {
	DecisionRequestV13,
	LegalSpaceMoveFacts,
} from "../shared/snake/legal-space.js";
import { publicState } from "../shared/snake/types.js";
import {
	legalSpaceExclusionDescription,
	presentBoardAscii,
	presentDecisionContext,
	presentLegalSpaceMove,
	savedBoardAscii,
	savedBoardObservationLabel,
	savedDirectionOptions,
	savedProbabilityGaps,
	savedStrategyGuide,
} from "../src/features/snake/contextPresentation.js";

const state = createState(
	"legal-space-ui",
	"test",
	null,
	{
		width: 8,
		height: 8,
		obstacleCount: 0,
		tickIntervalMs: 125,
		seed: "legal-space-ui",
		stepMode: "response",
	},
	"now",
);
Object.assign(state, {
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
const historical = decisionBodyV11(publicState(state), "test-model");
const { strategyGuide: _historicalGuide, ...baseState } = historical.state;
const facts: LegalSpaceMoveFacts = {
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
};
const request: DecisionRequestV13 = {
	model: historical.model,
	state: {
		...baseState,
		contextVersion: "legal-space-v13",
		moveFacts: { right: facts },
		excludedMoves: { up: "wall", down: "obstacle", left: "reverse" },
		factsSemantics: "Archived static facts; no route search.",
	},
	questions: {
		direction: {
			type: "choice",
			instructions: "Choose among legal moves using the supplied facts.",
			criteria: { right: "Straight to (2,0), 59 free cells reachable." },
		},
	},
};

test("V13 displays archived board, legal-space facts and exact string criteria without changing historical semantics", () => {
	const before = JSON.stringify(request);
	const presentation = presentDecisionContext(request);
	expect(presentation.request).toBe(request);
	expect(presentation.boardRequest).toBe(request);
	expect(presentation.legalSpaceRequest).toBe(request);
	expect(presentation.modelPlanningRequest).toBeUndefined();
	expect(presentation.semantics).toContain(
		"即使只剩一个合法选项，也会实际调用 JEV",
	);
	expect(presentation.semantics).toContain("启发式风险，不是必死证明");
	expect(presentation.probabilityNote).toBe(
		"模型概率表示方向选项分布，不是存活概率。",
	);
	expect(presentation.json).toBe(JSON.stringify(request, null, 2));
	expect(savedDirectionOptions(request)).toEqual([
		{ direction: "right", meaning: request.questions.direction.criteria.right },
	]);
	expect(savedBoardAscii(request)).toBe(request.state.board.ascii);
	expect(presentBoardAscii(request)?.map).toBe(request.state.board.ascii!.map);
	expect(presentBoardAscii(request)?.title).toBe(
		"模型决策前的字符图（历史输入）",
	);
	expect(savedBoardObservationLabel(request, 13)).toBe(
		"第 12 步观察（执行前），用于决定第 13 步；主棋盘当前第 13 步。",
	);
	expect(savedStrategyGuide(request)).toBeUndefined();
	expect(JSON.stringify(request)).toBe(before);
	expect(presentDecisionContext(historical).modelPlanningRequest).toBe(
		historical,
	);
	expect(savedStrategyGuide(historical)).toBe(_historicalGuide);
	expect(savedDirectionOptions(historical)).toHaveLength(4);
});

test("V13 probability gaps distinguish excluded directions, missing output and genuine zero probability", () => {
	const gaps = [
		{ direction: "up", status: "不在选项" },
		{ direction: "down", status: "不在选项" },
		{ direction: "left", status: "不在选项" },
	];
	expect(savedProbabilityGaps(request, { right: 1 })).toEqual(gaps);
	expect(savedProbabilityGaps(request, { right: 0 })).toEqual(gaps);
	expect(savedProbabilityGaps(request, {})).toContainEqual({
		direction: "right",
		status: "未提供",
	});
	const probabilities = { right: 0.7, down: 0.3 };
	const twoOptions = structuredClone(request);
	twoOptions.questions.direction.criteria.down = "Actual down description";
	delete twoOptions.state.excludedMoves.down;
	expect(savedProbabilityGaps(twoOptions, probabilities)).toEqual([
		{ direction: "up", status: "不在选项" },
		{ direction: "left", status: "不在选项" },
	]);
	expect(probabilities).toEqual({ right: 0.7, down: 0.3 });
	const threeOptions = structuredClone(twoOptions);
	threeOptions.questions.direction.criteria.up = "Actual up description";
	delete threeOptions.state.excludedMoves.up;
	expect(
		savedProbabilityGaps(threeOptions, { up: 0.2, right: 0.5, down: 0.3 }),
	).toEqual([{ direction: "left", status: "不在选项" }]);
});

test("V13 facts describe static tail adjacency and heuristic risk without a safety guarantee", () => {
	const view = presentLegalSpaceMove(facts);
	expect(view.target).toBe("(2, 0)");
	expect(view.space).toBe("59 / 59 格");
	expect(view.appleDistance).toContain("不代表实际有路");
	expect(view.tailConnection).toContain("不代表动态追尾可行");
	expect(view.nextMoves).toContain("有出口不保证长期安全");
	expect(view.deadEndRisk).toBe("未触发死路风险标记，不代表后续安全");
	const risk = presentLegalSpaceMove({
		...facts,
		reachableFreeCells: 0,
		canReachTail: false,
		nextLegalMoveCount: 0,
		deadEndRisk: true,
	});
	expect(risk.space).toBe("0 / 59 格");
	expect(risk.nextMoves).toBe("NO_NEXT_MOVE：本步移动后有 0 个合法出口");
	expect(risk.deadEndRisk).toContain("不是必死证明");
	expect(risk.tailConnection).toBe("蛇头及可达空域均不与蛇尾相邻");
});

test("V13 completed board labels future-space checks not applicable, not as a trap", () => {
	const view = presentLegalSpaceMove({
		...facts,
		eatsApple: true,
		lengthAfter: 63,
		freeCellsAfter: 0,
		reachableFreeCells: 0,
		canReachTail: null,
		nextLegalMoveCount: null,
		deadEndRisk: false,
		terminal: "board_complete",
	});
	expect(view.growth).toBe("吃到苹果，增长为 63 格");
	expect(view.appleDistance).toBe("本步吃到当前苹果");
	expect(view.terminal).toBe("本步填满棋盘");
	for (const key of ["tailConnection", "nextMoves", "deadEndRisk"] as const)
		expect(view[key]).toBe("不适用（本步填满棋盘）");
});

test("V13 all excluded reason labels preserve the actual cause", () => {
	expect(
		["reverse", "wall", "obstacle", "body"].map((reason) =>
			legalSpaceExclusionDescription(
				reason as "reverse" | "wall" | "obstacle" | "body",
			),
		),
	).toEqual(["直接反向", "本步越界", "本步撞障碍", "本步撞蛇身"]);
});
