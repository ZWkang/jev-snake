import { renderAsciiBoard } from "../../../shared/snake/ascii-board";
import type { DecisionRequestV6 } from "../../../shared/snake/board-context";
import type {
	DecisionRequestV9,
	LocalSearchMove,
} from "../../../shared/snake/bounded-search";
import type { DecisionRequestV16 } from "../../../shared/snake/compact-growth";
import type {
	DecisionRequestV14,
	DynamicMoveFacts,
} from "../../../shared/snake/dynamic-space";
import type { DecisionRequestV8 } from "../../../shared/snake/global-view";
import type {
	DecisionRequestV15,
	GrowthMoveFacts,
	PostAppleCheck as GrowthPostAppleCheck,
} from "../../../shared/snake/growth-space";
import type {
	DecisionRequestV13,
	LegalSpaceMoveFacts,
	MoveExclusion,
} from "../../../shared/snake/legal-space";
import type { DecisionRequestV7 } from "../../../shared/snake/local-moves";
import type { DecisionRequestV11 } from "../../../shared/snake/model-planning";
import type { DecisionRequestV12 } from "../../../shared/snake/non-reverse";
import type {
	DecisionRequestV10,
	PostAppleCheck,
} from "../../../shared/snake/post-apple-search";
import { directions } from "../../../shared/snake/types";
import type {
	DecisionRequest,
	Direction,
	DecisionRequestV3,
	LegacyDecisionRequest,
	LegacyPlanRequest,
	ModelDecision,
	PlanRequest,
	PlanRequestV3,
	DecisionRequestV4,
	PlanRequestV4,
	DecisionRequestV5,
	PublicState,
} from "../../../shared/snake/types";
import { modelName } from "./modelPresentation";

function storedVersion(request: unknown): unknown {
	if (typeof request !== "object" || request === null || !("state" in request))
		return undefined;
	const state = request.state;
	return typeof state === "object" &&
		state !== null &&
		"contextVersion" in state
		? state.contextVersion
		: undefined;
}

function isV3Context(
	request: unknown,
): request is
	| DecisionRequestV3
	| PlanRequestV3
	| DecisionRequestV4
	| PlanRequestV4
	| DecisionRequestV5 {
	const version = storedVersion(request);
	return (
		version === "action-facts-v3" ||
		version === "two-step-plan-v3" ||
		version === "action-facts-v4" ||
		version === "two-step-plan-v4" ||
		version === "action-outcomes-v5"
	);
}

function isLegacyContext(
	request: unknown,
): request is LegacyDecisionRequest | LegacyPlanRequest {
	if (typeof request !== "object" || request === null || !("state" in request))
		return false;
	const version = storedVersion(request);
	return (
		version === undefined ||
		version === "action-facts-v1" ||
		version === "action-facts-v2" ||
		version === "two-step-plan-v1" ||
		version === "two-step-plan-v2"
	);
}

function isLocalMovesContext(request: unknown): request is DecisionRequestV7 {
	return storedVersion(request) === "local-moves-v7";
}

function isGlobalViewContext(request: unknown): request is DecisionRequestV8 {
	return storedVersion(request) === "global-view-v8";
}

function isBoundedSearchContext(
	request: unknown,
): request is DecisionRequestV9 {
	return storedVersion(request) === "bounded-search-v9";
}

function isPostAppleContext(request: unknown): request is DecisionRequestV10 {
	return storedVersion(request) === "post-apple-v10";
}

function isModelPlanningContext(
	request: unknown,
): request is DecisionRequestV11 | DecisionRequestV12 {
	return (
		storedVersion(request) === "model-planning-v11" ||
		isNonReverseContext(request)
	);
}

function isNonReverseContext(request: unknown): request is DecisionRequestV12 {
	return storedVersion(request) === "non-reverse-v12";
}

function isLegalSpaceContext(request: unknown): request is DecisionRequestV13 {
	return storedVersion(request) === "legal-space-v13";
}

function isDynamicSpaceContext(
	request: unknown,
): request is DecisionRequestV14 {
	return storedVersion(request) === "dynamic-space-v14";
}

function isCompactGrowthContext(
	request: unknown,
): request is DecisionRequestV16 {
	return storedVersion(request) === "compact-growth-v16";
}

function isGrowthSpaceContext(
	request: unknown,
): request is DecisionRequestV15 | DecisionRequestV16 {
	return (
		storedVersion(request) === "growth-space-v15" ||
		isCompactGrowthContext(request)
	);
}

function isSpaceContext(
	request: unknown,
): request is
	| DecisionRequestV13
	| DecisionRequestV14
	| DecisionRequestV15
	| DecisionRequestV16 {
	return (
		isLegalSpaceContext(request) ||
		isDynamicSpaceContext(request) ||
		isGrowthSpaceContext(request)
	);
}

export function savedDirectionOptions(request: unknown) {
	if (isSpaceContext(request))
		return Object.entries(request.questions.direction.criteria).map(
			([direction, meaning]) => ({ direction, meaning }),
		);
	return isModelPlanningContext(request)
		? Object.entries(request.questions.direction.criteria).map(
				([direction, criterion]) => ({ direction, meaning: criterion.meaning }),
			)
		: [];
}

export function savedProbabilityGaps(
	request: unknown,
	probabilities: Readonly<Record<string, number | undefined>>,
) {
	if (!isNonReverseContext(request) && !isSpaceContext(request)) return [];
	return directions.flatMap((direction) =>
		probabilities[direction] !== undefined
			? []
			: [
					{
						direction,
						status: Object.hasOwn(
							request.questions.direction.criteria,
							direction,
						)
							? "未提供"
							: "不在选项",
					},
				],
	);
}

// The character map is part of the stored HTTP body. Older requests remain
// absent here even when their coordinates could produce a new map today.
export function savedBoardAscii(request: unknown) {
	return isModelPlanningContext(request) || isSpaceContext(request)
		? request.state.board.ascii
		: undefined;
}

export function presentBoardAscii(request: unknown) {
	if (
		(!isModelPlanningContext(request) && !isSpaceContext(request)) ||
		!request.state.board.ascii
	)
		return undefined;
	const saved = request.state.board.ascii;
	if (saved.format !== "named-cells-v2")
		return {
			title: "模型决策前的字符图（历史输入）",
			redrawn: false,
			map: saved.map,
			legend: saved.legend,
			originalNamedText: undefined,
		};
	const state = request.state;
	const compact = renderAsciiBoard({
		width: state.board.width,
		height: state.board.height,
		obstacles: state.board.obstacles,
		bodyHeadToTail: state.player.bodyHeadToTail,
		apple: state.food.apple,
		star: state.food.star?.point ?? null,
	});
	return {
		title: "模型决策前的字符图（历史输入，按本次输入坐标重绘）",
		redrawn: true,
		map: compact.map,
		legend: compact.legend,
		originalNamedText: saved,
	};
}

export function presentCurrentBoardAscii(state: PublicState) {
	return {
		title: `当前回放棋盘字符图 · 第 ${state.tick} 步`,
		...renderAsciiBoard({
			width: state.config.width,
			height: state.config.height,
			obstacles: state.obstacles,
			bodyHeadToTail: state.snake,
			apple: state.apple,
			star: state.star?.point ?? null,
		}),
	};
}

export function savedStrategyGuide(request: unknown) {
	return isModelPlanningContext(request)
		? request.state.strategyGuide
		: undefined;
}

export function savedFactsSemantics(request: unknown) {
	return isSpaceContext(request) && "factsSemantics" in request.state
		? request.state.factsSemantics
		: undefined;
}

export function savedDynamicSemantics(request: unknown) {
	return isSpaceContext(request) && "dynamicSemantics" in request.state
		? request.state.dynamicSemantics
		: undefined;
}

function isBoardStateContext(
	request: unknown,
): request is
	| DecisionRequestV6
	| DecisionRequestV7
	| DecisionRequestV8
	| DecisionRequestV9
	| DecisionRequestV10
	| DecisionRequestV11
	| DecisionRequestV12
	| DecisionRequestV13
	| DecisionRequestV14
	| DecisionRequestV15
	| DecisionRequestV16 {
	return (
		storedVersion(request) === "board-state-v6" ||
		isLocalMovesContext(request) ||
		isGlobalViewContext(request) ||
		isBoundedSearchContext(request) ||
		isPostAppleContext(request) ||
		isModelPlanningContext(request) ||
		isSpaceContext(request)
	);
}

const exclusionLabels: Record<MoveExclusion, string> = {
	reverse: "直接反向",
	wall: "本步越界",
	obstacle: "本步撞障碍",
	body: "本步撞蛇身",
};

export function legalSpaceExclusionDescription(reason: MoveExclusion): string {
	return exclusionLabels[reason];
}

export function presentLegalSpaceMove(move: LegalSpaceMoveFacts) {
	const completed = move.terminal === "board_complete";
	const notApplicable = "不适用（本步填满棋盘）";
	return {
		target: `(${move.target.x}, ${move.target.y})`,
		turn: {
			straight: "直行",
			"left turn": "左转",
			"right turn": "右转",
		}[move.turn],
		growth: move.eatsApple
			? `吃到苹果，增长为 ${move.lengthAfter} 格`
			: `不吃苹果，保持 ${move.lengthAfter} 格`,
		star: move.eatsStar ? "本步吃到星星" : "本步不吃星星",
		appleDistance: move.eatsApple
			? "本步吃到当前苹果"
			: move.appleDistance === null
				? "没有当前苹果"
				: `${move.appleDistance}（曼哈顿距离，不代表实际有路）`,
		space: `${move.reachableFreeCells} / ${move.freeCellsAfter} 格`,
		tailConnection: completed
			? notApplicable
			: move.canReachTail
				? "蛇头或可达空域与蛇尾相邻；不代表动态追尾可行"
				: "蛇头及可达空域均不与蛇尾相邻",
		nextMoves: completed
			? notApplicable
			: move.nextLegalMoveCount === 0
				? "NO_NEXT_MOVE：本步移动后有 0 个合法出口"
				: `${move.nextLegalMoveCount} 个（有出口不保证长期安全；吃果后未生成新苹果）`,
		deadEndRisk: completed
			? notApplicable
			: move.deadEndRisk
				? "DEAD_END_RISK：空间不足且未连接尾部，是启发式风险，不是必死证明"
				: "未触发死路风险标记，不代表后续安全",
		terminal: completed ? "本步填满棋盘" : "本步未结束",
	};
}

export function presentDynamicSpaceMove(move: DynamicMoveFacts) {
	let trap: string;
	switch (move.trap.status) {
		case "proven_trap":
			trap = `已证明必困：这个方向的全部合法分支最终都无路可走；从当前局面起，最长还能移动 ${move.trap.moves} 步（包含本次候选移动）`;
			break;
		case "horizon_reached":
			trap = `找到可继续移动 ${move.trap.moves} 步的分支（包含本次候选移动）；仅到达分析窗口，不代表长期安全`;
			break;
		case "unknown_after_apple":
			trap =
				"存在到达当前苹果的分支；新苹果未知，未证明此方向必困，也未证明安全";
			break;
		case "node_limit":
			trap = "达到节点限额，必困判断未完成；未知不代表安全或无路";
			break;
		case "board_complete":
			trap = "存在填满棋盘的获胜分支，不作必困判定";
			break;
	}
	let apple: string;
	switch (move.apple.status) {
		case "route_with_exit":
			apple = `找到 ${move.apple.moves} 步吃到当前苹果且增长后仍有即时出口的候选路线（包含本次候选移动）；不保证吃果后长期安全`;
			break;
		case "route_wins":
			apple = `找到 ${move.apple.moves} 步吃到当前苹果并填满棋盘的获胜路线（包含本次候选移动）`;
			break;
		case "no_route_with_exit_found":
			apple =
				"本次搜索未找到吃果后仍有即时出口的候选路线；不等于当前苹果不可达";
			break;
		case "no_apple":
			apple = "没有当前苹果，进食路线分析不适用";
			break;
	}
	const foundExit = move.apple.status === "route_with_exit";
	const notApplicable =
		move.apple.status === "route_wins"
			? "不适用（吃果后填满棋盘）"
			: "未提供候选路线结果";
	return {
		trap,
		trapNodes: `${move.trap.exploredNodes} 个节点`,
		apple,
		appleExit: foundExit
			? `${move.apple.nextLegalMoveCount} 个（仅检查该候选路线增长后的下一步）`
			: notApplicable,
		appleTail: foundExit
			? move.apple.canReachTail
				? "增长后的蛇头或可达空域与蛇尾相邻；不保证动态追尾可行"
				: "增长后的蛇头及可达空域均不与蛇尾相邻"
			: notApplicable,
		appleTermination: {
			found: "找到候选路线后停止，不表示已比较全部进食路线",
			exhausted: "已穷尽本次到当前苹果为止的可达分支；不预测新苹果",
			depth_limit: "达到深度上限，未检查更远路线；不能据此断言无路",
			node_limit: "达到节点限额，搜索未完成；不能据此断言无路",
			not_applicable: "不适用（没有当前苹果）",
		}[move.apple.termination],
		appleNodes: `${move.apple.exploredNodes} 个节点`,
	};
}

export function presentGrowthPostApple(check: GrowthPostAppleCheck | null) {
	if (!check) return "未提供吃果后续检查结果";
	switch (check.status) {
		case "proven_trap":
			return `已证明该吃果到达方式困死：吃果后最多还能移动 ${check.moves} 步（不含吃果这一步）；不再增长的乐观续路也全部耗尽，并已排除未来提前满盘的可能`;
		case "optimistic_horizon_reached":
			return `在吃果后不再增长的乐观条件下，找到继续移动 ${check.moves} 步的分支（不含吃果这一步）；仅覆盖检查窗口，不保证真实后续安全`;
		case "unknown_near_win":
			return "未排除未来提前填满棋盘的可能，吃果后续检查不能给出必困证明；这不等于已找到胜路或确认安全";
		case "node_limit":
			return "同方向共享的吃果后续检查节点预算耗尽，结果未知；不代表安全或无路";
	}
}

export function presentGrowthSpaceMove(
	move: GrowthMoveFacts,
	modelLabel = "模型",
) {
	let trap: string;
	switch (move.trap.status) {
		case "proven_trap":
			trap = `已证明必困：该方向全部合法续路都耗尽，最长还能移动 ${move.trap.moves} 步（从当前观察起，包含本次候选移动）；已排除未来提前填满棋盘的可能`;
			break;
		case "horizon_reached":
			trap = `找到 ${move.trap.moves} 步的未吃果续路（包含本次候选移动）；只覆盖分析窗口，不代表长期安全`;
			break;
		case "optimistic_horizon_reached":
			trap = `在吃到当前苹果后不再增长的乐观条件下，找到从当前观察起移动 ${move.trap.moves} 步的分支（包含本次候选移动）；不保证未来刷果和增长后仍安全`;
			break;
		case "unknown_near_win":
			trap =
				"未排除未来提前填满棋盘的可能，停止必困证明；这不等于已找到胜路，也不是安全结论";
			break;
		case "node_limit":
			trap = "达到节点限额，必困判断未完成；未知不代表安全或无路";
			break;
		case "board_complete":
			trap = `找到 ${move.trap.moves} 步填满棋盘的获胜分支（包含本次候选移动）`;
			break;
	}
	let apple: string;
	switch (move.apple.status) {
		case "route_with_optimistic_continuation":
			apple = `找到 ${move.apple.moves} 步吃到当前苹果的候选路线，吃果后还有乐观条件下的窗口续路；不是长期安全保证`;
			break;
		case "route_postcheck_unknown":
			apple = `找到 ${move.apple.moves} 步吃到当前苹果的候选路线，但吃果后续检查未得出结论；不能当作已通过安全检查`;
			break;
		case "route_wins":
			apple = `找到 ${move.apple.moves} 步吃到当前苹果并填满棋盘的获胜路线`;
			break;
		case "no_qualifying_route_found":
			apple = "本次搜索未找到符合后续检查条件的进食路线；不等于当前苹果不可达";
			break;
		case "no_apple":
			apple = "没有当前苹果，进食路线与吃果后续检查不适用";
			break;
	}
	const foundArrival =
		move.apple.status === "route_with_optimistic_continuation" ||
		move.apple.status === "route_postcheck_unknown";
	const notApplicable =
		move.apple.status === "route_wins"
			? "不适用（候选路线吃果后填满棋盘）"
			: move.apple.status === "no_apple"
				? "不适用（没有当前苹果）"
				: "未提供候选路线结果";
	return {
		trap,
		trapNodes: `${move.trap.exploredNodes} 个节点`,
		apple,
		appleExit: foundArrival
			? `${move.apple.nextLegalMoveCount} 个（只说明该到达方式吃果后的下一步，后续检查另列）`
			: notApplicable,
		appleTail: foundArrival
			? move.apple.canReachTail
				? "增长后的蛇头或可达空域与蛇尾相邻；不保证动态追尾可行"
				: "增长后的蛇头及可达空域均不与蛇尾相邻"
			: notApplicable,
		postApple: move.apple.postApple
			? presentGrowthPostApple(move.apple.postApple)
			: notApplicable,
		postAppleNodes:
			move.apple.postApple === null
				? "无单个到达方式的检查结果"
				: `${move.apple.postApple.exploredNodes} 个节点（该到达方式）`,
		postAppleTotal: `${move.apple.postAppleNodes} 个节点（本方向所有吃果到达方式累计，共享预算）`,
		rejectedArrivals: `${move.apple.rejectedTrapArrivals} 次吃果到达检查被证明困死并跳过（按检查次数统计）；未因此移除该方向的 ${modelLabel} 选项`,
		appleTermination: {
			found: "找到候选到达方式后停止，不表示路线最短或已比较全部路线",
			exhausted:
				"已穷尽本次进食搜索；候选到达方式的后续结果另列，不能据此推断安全或无路",
			depth_limit: "达到进食搜索深度上限，未检查更远路线；不能据此断言无路",
			node_limit: "达到进食搜索节点限额，搜索未完成；不能据此断言无路",
			postcheck_node_limit:
				"同方向所有吃果到达方式共享的后续检查预算耗尽，结果未知",
			not_applicable: "不适用（没有当前苹果）",
		}[move.apple.termination],
		appleNodes: `${move.apple.exploredNodes} 个节点（进食搜索）`,
	};
}

export function savedBoardObservationLabel(
	request: unknown,
	currentTick?: number,
) {
	if (!isBoardStateContext(request)) return undefined;
	const timing = request.state.timing;
	return `第 ${timing.observedTick} 步观察（执行前），用于决定第 ${timing.targetTick} 步${currentTick === undefined ? "。" : `；主棋盘当前第 ${currentTick} 步。`}`;
}

export function localSearchDescription(move: LocalSearchMove): string {
	switch (move.status) {
		case "blocked":
			return "本步被阻挡，无法从此方向继续";
		case "proven_dead":
			return "已证明必死：此方向的合法续路均无路可走或发生碰撞";
		case "apple_reachable":
			return "找到到达当前苹果的路线；新苹果与长期结果未知";
		case "win_reachable":
			return "找到填满棋盘的获胜路线";
		case "survival_found":
			return `仅找到有限步可存活路线；${move.cutoff === "nodes" ? "节点预算耗尽，搜索未完成；" : ""}更远结果未知`;
		case "unknown":
			return "预算内未完成判断；未知不代表安全或必死";
	}
}

export function localSearchAppleExitDescription(exits: Direction[]): string {
	return exits.length === 0
		? "这条已验证路线吃后立即无出口；不代表整个候选方向的所有路线都必死。"
		: `这条路线增长后有 ${exits.length} 个即时出口，只说明下一步可走，不保证长期安全。`;
}

export function localSearchCutoffDescription(
	cutoff: LocalSearchMove["cutoff"],
	version: "bounded-search-v9" | "post-apple-v10" = "bounded-search-v9",
): string {
	switch (cutoff) {
		case "none":
			return "未触发预算或苹果边界";
		case "depth":
			return "达到深度上限，未搜索更远局面";
		case "nodes":
			return "达到节点预算，未完成剩余搜索";
		case "apple":
			return version === "post-apple-v10"
				? "进食见证到达当前苹果；吃后检查结果另列，不预测新苹果"
				: "到达当前苹果；检查增长后的即时出口，不预测新苹果";
	}
}

export function postAppleDescription(check: PostAppleCheck): string {
	return check.result === "survival_possible"
		? "在不再增长的乐观假设下，尚未证明死亡；不保证真实未来安全。"
		: "吃后检查未完成，结果未知；不能当作安全或必死。";
}

export function postAppleCutoffDescription(
	cutoff: PostAppleCheck["cutoff"],
): string {
	switch (cutoff) {
		case "depth":
			return "达到整条路径剩余的深度上限";
		case "nodes":
			return "共享节点预算耗尽，检查未完成";
		case "possible_win":
			return "未排除未来提前填满棋盘的可能，停止死亡证明";
	}
}

export function observedRegionDescription(
	move: DecisionRequestV8["state"]["observedSpace"]["moves"]["up"],
): string {
	if (move.region !== null)
		return `${move.region.cells} 格 · ${move.region.containsApple ? "含当前苹果" : "不含当前苹果"}`;
	return move.entry === "vacating_tail"
		? "本步移走的蛇尾：当前占用快照未把尾格计入开放区域，区域信息不适用"
		: "本步入口被阻挡，区域信息不适用";
}

// This is a presentation of the stored request, never a reconstruction from
// the replay board. Unknown versions stay readable without assuming their shape.
export function presentDecisionContext(
	request: unknown,
	diagnostics?: Pick<ModelDecision, "contextBuildMs" | "requestBytes"> | null,
) {
	const version = storedVersion(request);
	let supportedRequest: DecisionRequest | PlanRequest | undefined;
	let semantics: string;
	if (isCompactGrowthContext(request)) {
		supportedRequest = request;
		semantics = `这是精简后的真实请求：完整字符图、坐标、静态事实、动态检查、预算和历史仍按保存值展示；方向选项使用实际发送的短字符串。规则与判定要求集中在 instructions，没有另行发送 rules、factsSemantics 或 dynamicSemantics。下面的中文事实解释由回放界面提供，不代表这些解释原文曾发送给模型；复制 JSON 只包含实际保存的正文。有限窗口和乐观续路不保证安全，未知不等于无路；${modelName(request.model)} 仍自行选择，本地不会自动沿路线执行。`;
	} else if (isGrowthSpaceContext(request)) {
		supportedRequest = request;
		semantics = `程序为全部本步合法方向计算静态事实和有限动态续路，并继续检查候选路线吃果后的身体移动。吃果后不再增长是乐观条件，不代表真实未来；只有穷尽续路且排除未来提前满盘的可能，才标记必困。窗口续路、近满盘未知与节点限额均不等于安全。被跳过的是已证明困死的吃果到达方式，不是模型方向；同方向所有到达方式共享吃果后续检查预算。${modelName(request.model)} 仍从全部本步合法方向中真实选择，程序不替换选择、不自动沿路线执行，也不预测新苹果。`;
	} else if (isDynamicSpaceContext(request)) {
		supportedRequest = request;
		semantics = `程序先排除直接反向及本步碰撞，再为全部本步合法方向提供静态空间事实和有限动态分析。动态分析跟随身体与蛇尾移动，区分全部分支已证明必困、仅窗口内存活、到达苹果后的未知和节点限额；另查当前苹果候选路线及其增长后的即时出口与静态尾部邻接。不预测新苹果，不把未知当安全或无路。模型仍从全部本步合法方向中选择，程序不替换模型选择，也不自动沿候选路线移动；只有一个合法选项时仍调用 ${modelName(request.model)}。`;
	} else if (isLegalSpaceContext(request)) {
		supportedRequest = request;
		semantics = `程序先排除直接反向及本步会撞墙、障碍或蛇身的方向，再为每个合法方向模拟一步，计算静态可达空格、尾部邻接和下一步合法出口。${modelName(request.model)} 根据这些事实和完整棋盘选择方向；本步合法不保证长期安全，DEAD_END_RISK 是启发式风险，不是必死证明。即使只剩一个合法选项，也会实际调用 ${modelName(request.model)}。`;
	} else if (isNonReverseContext(request)) {
		supportedRequest = request;
		semantics =
			"模型收到完整真实棋盘、游戏规则和真实历史，自行理解局面、规划路线并决定下一步方向。选项排除观察时朝向的直接反向，以下只展示当时实际发送的方向及含义；这些方向仍可能撞墙或蛇身，由模型自行判断。程序按游戏规则校验并执行模型选择。";
	} else if (isModelPlanningContext(request)) {
		supportedRequest = request;
		semantics =
			"模型收到完整真实棋盘、游戏规则和真实历史，自行理解局面、规划路线并决定下一步方向。四个选项只说明方向含义；程序不提供推荐方向或路径结论，只按游戏规则校验并执行模型选择。";
	} else if (isPostAppleContext(request)) {
		supportedRequest = request;
		semantics =
			"模型收到完整真实棋盘、规则与实际历史、本步事实、当前占用快照和有限局部搜索结果。吃果后的乐观检查假设不再增长，不生成或预测新苹果；只有穷尽续路且排除可能提前填满棋盘后，才判定该端点困死并回溯。仍可存活只代表尚未证明死亡，不保证真实未来安全。吃果前路线与吃后检查共用记录中的总深度和总节点预算，吃后节点已计入总数。被回溯的端点按访问次数统计，包含重复访问，不是唯一不同路线数。未知不代表安全或必死。由 JEV 自行选择方向，引擎只执行模型当前选择的一步，不自动沿见证路线移动。";
	} else if (isBoundedSearchContext(request)) {
		supportedRequest = request;
		semantics =
			"模型收到完整真实棋盘、规则与实际历史、四方向本步事实、当前占用快照，以及有明确深度和节点预算的局部搜索结果。搜索区分已证明必死、找到当前苹果路线、找到获胜路线、仅有限步可存活和预算内未完成判断；路线搜索以当前苹果为边界，并检查增长后的即时出口，不生成或预测新苹果。这条路线吃后无出口不代表整个候选方向必死，有出口也不保证长期安全。未知不代表安全或必死，有限步可存活不保证长期安全。见证路线仅说明已检查的路径，由 JEV 选择方向，本地引擎只执行模型当前选择的一步，不自动沿见证路线移动。";
	} else if (isGlobalViewContext(request)) {
		supportedRequest = request;
		semantics =
			"模型收到完整真实棋盘、规则与实际历史，以及四方向本步事实和当前占用快照中的全局开放区域、区域是否含苹果、入口目标周边的当前开放方向。由 JEV 选择方向，本地引擎校验并执行。静态占用快照不等于动态可达性，不是必死或安全证明；身体与蛇尾后续移动会改变连通关系。尾格未计入当前开放区域不代表零格死路。这些信息不是推荐路线。";
	} else if (isLocalMovesContext(request)) {
		supportedRequest = request;
		semantics =
			"模型收到完整真实棋盘、规则与实际历史，以及四方向的本步目标格、合法性、苹果距离变化和真实重复记录。程序只整理本步规则事实，由 JEV 选择方向，本地引擎校验并执行。这些事实不是推荐路线，不保证多步安全；距离苹果更近也不表示有路可达。";
	} else if (isBoardStateContext(request)) {
		supportedRequest = request;
		semantics =
			"模型收到完整真实棋盘：棋盘尺寸、全部障碍坐标、从头到尾的蛇身、当前方向、食物、规则与实际历史，由模型自行判断并选择下一步方向。本地引擎校验并执行这一步。";
	} else if (isV3Context(request)) {
		supportedRequest = request;
		semantics =
			"程序计算碰撞、逃生空间和候选食物路径，JEV 选择方向。静态连通性与单条已验证路线不保证存活，未知也不代表安全。请求使用动作摘要，不含完整蛇身和障碍坐标；棋盘来自保存的观察记录。";
		if (version === "action-outcomes-v5")
			semantics =
				"程序计算每个方向的即时结果、所有续路的死亡证明、具体进食路线及其增长后结果，合并为完整后果，由 JEV 选择方向。这些事实不保证存活。未证明必死不等于安全；一条路线的结论不扩展到同方向的所有路线。模型输入不含旧见证下一方向或重复的静态食物路线；实际历史与四方向选择完整保留，JEV仍自主决定。完整路线仅在后台存档。";
		if (version === "action-facts-v4" || version === "two-step-plan-v4")
			semantics +=
				" 正向证据包含到当前苹果的真实路线、无增长循环和身体格释放时序；存在路线不代表长期安全。当前几何与先前见证相容不证明走过相同路线，也不代表模型承诺跟随。完整路线单独存档，不属于发送给模型的原始 JSON。";
	} else if (isLegacyContext(request)) {
		supportedRequest = request;
		semantics =
			"这是旧坐标 context，保留当时的规则、障碍、蛇身、奖励和可选动作说明。此处不会用新算法重算或补写历史事实。";
	} else {
		semantics =
			"暂不支持此 context 版本的语义说明，仍可查看和复制保存的原始 JSON。";
	}
	const progress =
		supportedRequest && "progress" in supportedRequest.state
			? supportedRequest.state.progress
			: undefined;
	if (progress?.historyVersion === "progress-v1") {
		semantics += ` 历史记录覆盖第 ${progress.historyStartTick} 至 ${progress.throughTick} 步，已连续 ${progress.movesSinceApple} 步未吃苹果；当前完整局面在本次苹果周期出现 ${progress.positionVisits} 次。`;
		if (progress.repeatAfterMoves !== null)
			semantics += ` 距上次相同局面 ${progress.repeatAfterMoves} 步。`;
	}
	return {
		request: supportedRequest,
		boardRequest: isBoardStateContext(request) ? request : undefined,
		modelPlanningRequest: isModelPlanningContext(request) ? request : undefined,
		legalSpaceRequest: isSpaceContext(request) ? request : undefined,
		dynamicSpaceRequest: isDynamicSpaceContext(request) ? request : undefined,
		growthSpaceRequest: isGrowthSpaceContext(request) ? request : undefined,
		immediateRequest:
			isLocalMovesContext(request) ||
			isGlobalViewContext(request) ||
			isBoundedSearchContext(request) ||
			isPostAppleContext(request)
				? request
				: undefined,
		observedRequest:
			isGlobalViewContext(request) ||
			isBoundedSearchContext(request) ||
			isPostAppleContext(request)
				? request
				: undefined,
		localSearchRequest:
			isBoundedSearchContext(request) || isPostAppleContext(request)
				? request
				: undefined,
		head: isBoardStateContext(supportedRequest)
			? supportedRequest.state.player.bodyHeadToTail[0]
			: supportedRequest?.state.player.head,
		version: version === undefined ? "未记录（旧格式）" : String(version),
		contextBuildMs:
			diagnostics?.contextBuildMs === undefined
				? "未记录"
				: `${diagnostics.contextBuildMs.toFixed(3)} ms`,
		requestBytes:
			diagnostics?.requestBytes === undefined
				? "未记录"
				: `${diagnostics.requestBytes} 字节`,
		semantics,
		probabilityNote:
			isModelPlanningContext(request) || isSpaceContext(request)
				? "模型概率表示方向选项分布，不是存活概率。"
				: "模型概率表示选项分布，不是存活概率；两步计划的概率属于完整方向对。",
		json: JSON.stringify(request, null, 2),
	};
}
