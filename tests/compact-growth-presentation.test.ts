import { expect, test, vi } from "vitest";
import { createState } from "../server/game/engine.js";
import { decisionBodyV15 } from "../server/jev/board-context.js";
import { compactGrowthRequest } from "../shared/snake/compact-growth.js";
import * as growthAnalysis from "../shared/snake/growth-space-analysis.js";
import { publicState } from "../shared/snake/types.js";
import {
	presentBoardAscii,
	presentDecisionContext,
	presentGrowthSpaceMove,
	savedBoardAscii,
	savedBoardObservationLabel,
	savedDirectionOptions,
	savedDynamicSemantics,
	savedFactsSemantics,
	savedProbabilityGaps,
} from "../src/features/snake/contextPresentation.js";

const game = createState(
	"compact-ui",
	"test",
	null,
	{
		width: 8,
		height: 8,
		obstacleCount: 0,
		tickIntervalMs: 125,
		seed: "compact-ui",
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
const historical = decisionBodyV15(publicState(game), "test-model");
const compact = compactGrowthRequest(historical);

test("V16 presents the saved compact request and board without filling removed model text", () => {
	const before = JSON.stringify(compact);
	const view = presentDecisionContext(compact);
	expect(view.request).toBe(compact);
	expect(view.boardRequest).toBe(compact);
	expect(view.legalSpaceRequest).toBe(compact);
	expect(view.growthSpaceRequest).toBe(compact);
	expect(view.modelPlanningRequest).toBeUndefined();
	expect(view.dynamicSpaceRequest).toBeUndefined();
	expect(view.version).toBe("compact-growth-v16");
	expect(view.json).toBe(JSON.stringify(compact, null, 2));
	expect(view.semantics).toContain("中文事实解释由回放界面提供");
	expect(view.semantics).toContain("不代表这些解释原文曾发送给模型");
	expect(savedFactsSemantics(compact)).toBeUndefined();
	expect(savedDynamicSemantics(compact)).toBeUndefined();
	const parsed = JSON.parse(view.json);
	for (const field of ["rules", "factsSemantics", "dynamicSemantics"])
		expect(Object.hasOwn(parsed.state, field)).toBe(false);
	expect(savedBoardAscii(compact)).toBe(compact.state.board.ascii);
	expect(presentBoardAscii(compact)?.map).toBe(compact.state.board.ascii!.map);
	expect(presentBoardAscii(compact)?.redrawn).toBe(false);
	expect(savedBoardObservationLabel(compact, 13)).toBe(
		"第 12 步观察（执行前），用于决定第 13 步；主棋盘当前第 13 步。",
	);
	expect(savedDirectionOptions(compact)).toEqual(
		Object.entries(compact.questions.direction.criteria).map(
			([direction, meaning]) => ({ direction, meaning }),
		),
	);
	expect(JSON.stringify(compact)).toBe(before);
});

test("V16 reuses archived growth facts and never reruns search during presentation", () => {
	const search = vi.spyOn(growthAnalysis, "analyzeGrowthSpace");
	try {
		const view = presentDecisionContext(compact);
		expect(view.growthSpaceRequest?.state.dynamicFacts).toEqual(
			historical.state.dynamicFacts,
		);
		expect(view.legalSpaceRequest?.state.moveFacts).toEqual(
			historical.state.moveFacts,
		);
		expect(view.growthSpaceRequest?.state.analysisLimits).toEqual(
			historical.state.analysisLimits,
		);
		for (const facts of Object.values(compact.state.dynamicFacts)) {
			const explained = presentGrowthSpaceMove(facts);
			expect(explained.trap).not.toBe("");
			expect(explained.apple).not.toBe("");
			expect(explained.postAppleTotal).toContain(
				String(facts.apple.postAppleNodes),
			);
		}
		expect(search).not.toHaveBeenCalled();
	} finally {
		search.mockRestore();
	}
});

test("V16 preserves zero and missing probabilities instead of inventing excluded option values", () => {
	const probabilities = { right: 0 };
	expect(savedProbabilityGaps(compact, probabilities)).toEqual([
		{ direction: "up", status: "不在选项" },
		{ direction: "down", status: "不在选项" },
		{ direction: "left", status: "不在选项" },
	]);
	expect(savedProbabilityGaps(compact, {})).toContainEqual({
		direction: "right",
		status: "未提供",
	});
	expect(probabilities).toEqual({ right: 0 });
	expect(presentDecisionContext(compact).probabilityNote).toBe(
		"模型概率表示方向选项分布，不是存活概率。",
	);
});

test("V15 retains its original full definitions and long criteria alongside V16", () => {
	const before = JSON.stringify(historical);
	const view = presentDecisionContext(historical);
	expect(view.version).toBe("growth-space-v15");
	expect(view.growthSpaceRequest).toBe(historical);
	expect(savedFactsSemantics(historical)).toBe(historical.state.factsSemantics);
	expect(savedDynamicSemantics(historical)).toBe(
		historical.state.dynamicSemantics,
	);
	expect(savedDirectionOptions(historical)).toEqual(
		Object.entries(historical.questions.direction.criteria).map(
			([direction, meaning]) => ({ direction, meaning }),
		),
	);
	expect(view.json).toBe(JSON.stringify(historical, null, 2));
	expect(view.semantics).not.toContain("没有另行发送 rules");
	expect(JSON.stringify(historical)).toBe(before);
});
