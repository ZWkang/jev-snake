import type {
	EventPage,
	GameConfig,
	MatchEvent,
	MatchSummary,
	PublicState,
} from "../../../shared/snake/types";
import { isResponseMode, supportedRecord } from "../../../shared/snake/types";

export type Health = {
	status: string;
	error: string | null;
	jevConfigured: boolean;
	model: string;
	provider?: string;
};
export type MatchList = {
	matches: MatchSummary[];
	nextCursor: string | null;
	agents: string[];
};
export const isActiveMatch = (status: string) =>
	status === "running" || status === "ready";
export async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
	const response = await fetch(`/api${path}`, { signal });
	const value = await response.json();
	if (!response.ok)
		throw new Error(
			value.error?.message ?? `服务暂不可用（${response.status}）`,
		);
	return value as T;
}
export function assertRecord(state: PublicState) {
	if (!supportedRecord(state)) throw new Error("这场对局的记录版本暂不支持");
}
export async function allActiveMatches(signal?: AbortSignal) {
	const groups = await Promise.all(
		["running", "ready"].map(async (status) => {
			const matches: MatchSummary[] = [];
			let cursor: string | null = null;
			do {
				const query = new URLSearchParams({ status });
				if (cursor) query.set("cursor", cursor);
				const page = await api<MatchList>(`/matches?${query}`, signal);
				matches.push(...page.matches);
				cursor = page.nextCursor;
			} while (cursor);
			return matches;
		}),
	);
	return groups.flat();
}
export async function allEvents(
	id: string,
	signal?: AbortSignal,
): Promise<MatchEvent[]> {
	const events: MatchEvent[] = [];
	let cursor = -1;
	let more = true;
	while (more) {
		const page = await api<EventPage>(
			`/matches/${id}/events?afterSeq=${cursor}`,
			signal,
		);
		for (const event of page.events) {
			assertRecord(event.state);
			if (event.seq !== cursor + 1)
				throw new Error("对局事件不连续，无法准确回放");
			events.push(event);
			cursor = event.seq;
		}
		if (page.hasMore && page.events.length === 0)
			throw new Error("对局记录缺失");
		more = page.hasMore;
	}
	return events;
}
export const statusName = (status: string) =>
	({
		ready: "等待开始",
		running: "进行中",
		gameover: "已结束",
		won: "完成棋盘",
		interrupted: "已中断",
	})[status] ?? status;
export const directionName = (direction: string) =>
	({ up: "向上", right: "向右", down: "向下", left: "向左" })[direction] ??
	direction;
export const reasonName = (reason: string | null) =>
	reason
		? ({
				wall: "撞到边界",
				obstacle: "撞到障碍",
				self: "撞到身体",
				board_complete: "完成棋盘",
				server_restart: "服务重启",
				server_shutdown: "服务关闭",
				controller_stop: "控制者结束对局",
				model_error: "模型调用失败",
				stale_state: "预期局面已变化",
				late_action: "动作抵达时已过期",
				no_plan: "尚无可用计划",
				backup_exhausted: "备用已耗尽",
				backup_invalid: "备用已失效",
				parent_not_applied: "前置动作未生效",
				fresh_decision: "由新决策替代",
				target_expired: "目标步已过期",
				not_running: "到达时对局已结束",
				invalid_plan: "计划内容不一致",
				decision_mode_mismatch: "控制模式不匹配",
				invalid_target_tick: "动作只能控制紧接着的一步",
				projection_unavailable: "无法预判目标局面",
				tick_action_conflict: "该步已有动作",
				invalid_direction: "不允许直接反向",
			}[reason] ?? reason)
		: "—";
export function duration(ms: number) {
	const seconds = Math.floor(ms / 1000);
	return (
		String(Math.floor(seconds / 60)).padStart(2, "0") +
		":" +
		String(seconds % 60).padStart(2, "0")
	);
}
export function speed(ms: number) {
	return Number((1000 / ms).toPrecision(3));
}
export function stepModeName(config: GameConfig) {
	return isResponseMode(config) ? "随模型响应" : "固定步频";
}
export function averageSpeed(tick: number, elapsedGameTimeMs: number) {
	return tick > 0 && elapsedGameTimeMs > 0
		? Number(((tick * 1000) / elapsedGameTimeMs).toPrecision(3))
		: null;
}
export function matchSpeed(
	state: Pick<MatchSummary, "config" | "tick" | "gameTimeMs">,
	elapsedGameTimeMs = state.gameTimeMs,
) {
	const config = state.config;
	if (!isResponseMode(config)) return `${speed(config.tickIntervalMs)} 格 / 秒`;
	const average = averageSpeed(state.tick, elapsedGameTimeMs);
	return average === null ? "平均步频暂无样本" : `平均 ${average} 格 / 秒`;
}
export function eventName(event: MatchEvent) {
	if (event.type.startsWith("plan_step_"))
		return `计划第 ${Number(event.data.stepIndex) + 1} 项 · ${stepStatusName(event.type.slice(10))}`;
	if (event.type === "plan_accepted")
		return `两步计划 ${choiceName(String((event.data.decision as { choice: string }).choice))}`;
	if (event.type === "plan_rejected")
		return `计划拒绝 · ${reasonName(String(event.data.code))}`;
	if (event.type === "action_rejected" || event.type === "action_cancelled")
		return reasonName(String(event.data.code));
	const label =
		{
			created: "生成棋盘",
			forked: "从历史局面续跑",
			started: "开始对局",
			move: directionName(event.state.direction),
			apple: "吃到苹果 +10",
			star: "获得星星 +30",
			star_expired: "星星已消失",
			action_accepted: `选择${directionName(String(event.data.direction))}`,
			gameover: reasonName(event.state.endReason),
			won: "完成棋盘",
			interrupted: reasonName(event.state.endReason),
		}[event.type] ?? event.type;
	const source = (event.data.actionSource as { source?: string } | undefined)
		?.source;
	return source ? `${actionSourceName(source)} · ${label}` : label;
}

export const actionSourceName = (source: string) =>
	({ primary: "最新决策", fallback: "上轮备用", coast: "沿原方向" })[source] ??
	source;
export const choiceName = (choice: string) =>
	choice.split("_").map(directionName).join(" → ");
export const stepStatusName = (status: string) =>
	({
		queued: "等待执行",
		standby: "已预留",
		applied: "已执行",
		superseded: "被新决策覆盖",
		cancelled: "已取消",
		expired: "已过期",
		rejected: "已拒绝",
	})[status] ?? status;
