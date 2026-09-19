import { Link } from "@tanstack/solid-router";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { MatchSummary } from "../../../shared/snake/types";
import { Select } from "../../components/ui/select";
import {
	api,
	duration,
	isActiveMatch,
	type MatchList,
	matchSpeed,
	reasonName,
	statusName,
	stepModeName,
} from "./api";
import { Problem, Shell } from "./Scene";

export function HistoryPage() {
	const [matches, setMatches] = createSignal<MatchSummary[]>([]);
	const [agents, setAgents] = createSignal<string[]>([]);
	const [agent, setAgent] = createSignal("");
	const [status, setStatus] = createSignal("");
	const [cursor, setCursor] = createSignal<string | null>(null);
	const [loading, setLoading] = createSignal(true);
	const [error, setError] = createSignal("");
	let abort: AbortController | undefined;
	async function load(append = false) {
		abort?.abort();
		abort = new AbortController();
		const signal = abort.signal;
		const query = new URLSearchParams();
		if (agent()) query.set("agent", agent());
		if (status()) query.set("status", status());
		if (append && cursor()) query.set("cursor", cursor() as string);
		setLoading(true);
		setError("");
		if (!append) setMatches([]);
		try {
			const result = await api<MatchList>(`/matches?${query}`, signal);
			if (signal.aborted) return;
			setMatches((old) =>
				append ? [...old, ...result.matches] : result.matches,
			);
			setCursor(result.nextCursor);
			setAgents(result.agents);
		} catch (e) {
			if (!signal.aborted) setError(e instanceof Error ? e.message : String(e));
		} finally {
			if (!signal.aborted) setLoading(false);
		}
	}
	onMount(() => void load());
	onCleanup(() => abort?.abort());
	return (
		<Shell page="history">
			<div class="page-heading">
				<div>
					<p class="page-context">对局档案</p>
					<h1>每一局，都有迹可循。</h1>
				</div>
				<span class="outlined-tag lavender">记录真实发生的过程</span>
			</div>
			<div class="history-filters">
				<div>
					<label for="filter-agent">参与者</label>
					<Select
						id="filter-agent"
						label="参与者"
						value={agent()}
						searchable
						options={[
							{ value: "", label: "全部参与者" },
							...agents().map((name) => ({ value: name, label: name })),
						]}
						onChange={(value) => {
							setAgent(value);
							void load();
						}}
					/>
				</div>
				<div>
					<label for="filter-status">对局状态</label>
					<Select
						id="filter-status"
						label="对局状态"
						value={status()}
						searchable={false}
						options={[
							{ value: "", label: "全部状态" },
							{ value: "running", label: "进行中" },
							{ value: "ready", label: "等待开始" },
							{ value: "gameover", label: "已结束" },
							{ value: "won", label: "完成棋盘" },
							{ value: "interrupted", label: "已中断" },
						]}
						onChange={(value) => {
							setStatus(value);
							void load();
						}}
					/>
				</div>
				<button
					type="button"
					class="text-button"
					disabled={loading()}
					onClick={() => void load()}
				>
					刷新记录 ↻
				</button>
			</div>
			<Show when={error()}>
				<Problem message={error()} retry={() => void load()} />
			</Show>
			<Show
				when={matches().length > 0}
				fallback={
					<div class="history-empty">
						<span aria-hidden="true">□</span>
						<h2>{loading() ? "正在读取对局记录…" : "这里还没有对局。"}</h2>
						<p>
							{loading()
								? "历史与回放来自同一份已保存记录。"
								: "对局开始后会出现在这里。你也可以调整筛选条件。"}
						</p>
					</div>
				}
			>
				<div class="history-table-wrap">
					<table class="history-table">
						<thead>
							<tr>
								<th>对局 / 开始时间</th>
								<th>参与者</th>
								<th>得分</th>
								<th>模式 / 步频</th>
								<th>步数 / 时长</th>
								<th>结果</th>
								<th>
									<span class="sr-only">查看记录</span>
								</th>
							</tr>
						</thead>
						<tbody>
							<For each={matches()}>
								{(m) => (
									<tr>
										<td>
											<strong>#{m.id.slice(0, 8)}</strong>
											<small>
												{new Date(m.startedAt ?? m.createdAt).toLocaleString(
													"zh-CN",
													{
														month: "2-digit",
														day: "2-digit",
														hour: "2-digit",
														minute: "2-digit",
													},
												)}
											</small>
										</td>
										<td>
											<b>{m.agentName}</b>
											<small>{m.model ?? "程序化玩家"}</small>
										</td>
										<td class="table-score">{m.score}</td>
										<td>
											{stepModeName(m.config)}
											<small>{matchSpeed(m)}</small>
										</td>
										<td>
											{m.tick} 步<small>{duration(m.gameTimeMs)}</small>
										</td>
										<td>
											<span
												class="status-pill"
												classList={{
													running: m.status === "running",
													interrupted: m.status === "interrupted",
													won: m.status === "won",
												}}
											>
												{statusName(m.status)}
											</span>
											<small>
												{m.endReason
													? reasonName(m.endReason)
													: `已记录至第 ${m.tick} 步`}
											</small>
										</td>
										<td>
											<Link
												to={
													isActiveMatch(m.status)
														? "/watch/$matchId"
														: "/matches/$matchId/replay"
												}
												params={{ matchId: m.id }}
												class="replay-link"
											>
												{isActiveMatch(m.status) ? "观战" : "回放"}
											</Link>
										</td>
									</tr>
								)}
							</For>
						</tbody>
					</table>
				</div>
				<div class="history-bottom">
					<span>{matches().length} 场已显示 · 按开始时间排序</span>
					<Show when={cursor()}>
						<button
							class="snake-button small"
							type="button"
							disabled={loading()}
							onClick={() => void load(true)}
						>
							{loading() ? "正在读取…" : "加载更多"}
						</button>
					</Show>
				</div>
			</Show>
			<div class="archive-note">
				<b>一场对局，一份记录。</b>
				<p>
					回放保留原始速度、随机地图与实际动作。中断的对局也会保留已保存的片段。
				</p>
			</div>
		</Shell>
	);
}
