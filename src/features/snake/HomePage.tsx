import { Link } from "@tanstack/solid-router";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { api, isActiveMatch, matchSpeed, type MatchList } from "./api";
import { Clip, Problem, Shell } from "./Scene";
import { channelLabel, createWatchChannel } from "./watchChannel";

export function HomePage() {
	const channel = createWatchChannel(),
		[list, setList] = createSignal<MatchList>(),
		[error, setError] = createSignal("");
	let controller: AbortController | undefined;
	async function load() {
		controller?.abort();
		controller = new AbortController();
		const signal = controller.signal;
		try {
			const result = await api<MatchList>("/matches?limit=3", signal);
			if (!signal.aborted) {
				setList(result);
				setError("");
			}
		} catch (e) {
			if (!signal.aborted) setError(e instanceof Error ? e.message : String(e));
		}
	}
	onMount(() => void load());
	onCleanup(() => controller?.abort());
	return (
		<Shell page="home">
			<div class="page-heading">
				<div>
					<p class="page-context">贪吃蛇 · 模型实时决策实验</p>
					<h1>四个方向，无数种可能。</h1>
				</div>
				<span class="outlined-tag">免登录 · 只读观战</span>
			</div>
			<div class="empty-stage">
				<div class="empty-film">
					<Clip kind="intro" />
				</div>
				<div class="empty-copy">
					<span class="empty-symbol" aria-hidden="true">
						↳
					</span>
					<h2>
						看它，
						<br />
						走出下一步。
					</h2>
					<p>
						看模型转弯、吃苹果，以及做出每一次选择。进入连续观战，跟随一场又一场真实发生的对局。
					</p>
					<div class="home-actions">
						<Link to="/watch" class="snake-button yellow">
							进入连续观战
						</Link>
						<Link to="/matches" class="snake-button">
							翻看历史对局
						</Link>
					</div>
					<p class="home-channel-status" role="status">
						{channel.phase() === "live"
							? channelLabel(channel.state(), channel.remaining())
							: "频道状态正在同步"}
					</p>
					<div class="empty-rules">
						<b>四个方向，每步都是一次选择。</b>
						<span>苹果 +10 分并增长</span>
						<span>星星 +30 分，8 秒内有效</span>
						<span>撞墙、障碍或自己，对局结束</span>
					</div>
				</div>
			</div>
			<Show when={channel.error()}>
				<Problem message={channel.error()} retry={channel.refresh} />
			</Show>
			<Show when={error()}>
				<Problem message={error()} retry={() => void load()} />
			</Show>
			<Show when={list()?.matches.length}>
				<section class="latest-matches">
					<div class="section-heading">
						<h2>刚刚发生过的故事</h2>
						<Link to="/matches">全部历史</Link>
					</div>
					<div class="recent-grid">
						<For each={list()?.matches}>
							{(m) => (
								<Link
									class="recent-match"
									to={
										isActiveMatch(m.status)
											? "/watch/$matchId"
											: "/matches/$matchId/replay"
									}
									params={{ matchId: m.id }}
								>
									<span>{m.agentName}</span>
									<strong>
										{m.score}
										<small> 分</small>
									</strong>
									<span>
										{m.tick} 步 · {matchSpeed(m)}{" "}
										<b>{isActiveMatch(m.status) ? "单局观战" : "回放"}</b>
									</span>
								</Link>
							)}
						</For>
					</div>
				</section>
			</Show>
		</Shell>
	);
}
