import type {
	DecisionRequest,
	DecisionRequestV3,
	LegacyDecisionRequest,
	LegacyPlanRequest,
	ModelDecision,
	PlanRequest,
	PlanRequestV3,
	DecisionRequestV4,
	PlanRequestV4,
} from "../../../shared/snake/types";

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
	| PlanRequestV4 {
	const version = storedVersion(request);
	return (
		version === "action-facts-v3" ||
		version === "two-step-plan-v3" ||
		version === "action-facts-v4" ||
		version === "two-step-plan-v4"
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

// This is a presentation of the stored request, never a reconstruction from
// the replay board. Unknown versions stay readable without assuming their shape.
export function presentDecisionContext(
	request: unknown,
	diagnostics?: Pick<ModelDecision, "contextBuildMs" | "requestBytes"> | null,
) {
	const version = storedVersion(request);
	let supportedRequest: DecisionRequest | PlanRequest | undefined;
	let semantics: string;
	if (isV3Context(request)) {
		supportedRequest = request;
		semantics =
			"程序计算碰撞、逃生空间和候选食物路径，JEV 选择方向。静态连通性与单条已验证路线不保证存活，未知也不代表安全。请求使用动作摘要，不含完整蛇身和障碍坐标；棋盘来自保存的观察记录。";
		const progress = request.state.progress;
		if (version === "action-facts-v4" || version === "two-step-plan-v4")
			semantics +=
				" 正向证据包含到当前苹果的真实路线、无增长循环和身体格释放时序；存在路线不代表长期安全。当前几何与先前见证相容不证明走过相同路线，也不代表模型承诺跟随。完整路线单独存档，不属于发送给模型的原始 JSON。";
		if (progress?.historyVersion === "progress-v1") {
			semantics += ` 历史记录覆盖第 ${progress.historyStartTick} 至 ${progress.throughTick} 步，已连续 ${progress.movesSinceApple} 步未吃苹果；当前完整局面在本次苹果周期出现 ${progress.positionVisits} 次。`;
			if (progress.repeatAfterMoves !== null)
				semantics += ` 距上次相同局面 ${progress.repeatAfterMoves} 步。`;
		}
	} else if (isLegacyContext(request)) {
		supportedRequest = request;
		semantics =
			"这是旧坐标 context，保留当时的规则、障碍、蛇身、奖励和可选动作说明。此处不会用新算法重算或补写历史事实。";
	} else {
		semantics =
			"暂不支持此 context 版本的语义说明，仍可查看和复制保存的原始 JSON。";
	}
	return {
		request: supportedRequest,
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
			"模型概率表示选项分布，不是存活概率；两步计划的概率属于完整方向对。",
		json: JSON.stringify(request, null, 2),
	};
}
