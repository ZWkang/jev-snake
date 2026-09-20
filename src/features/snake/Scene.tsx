import { Link } from "@tanstack/solid-router";
import {
	createSignal,
	For,
	type JSX,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import {
	isResponseMode,
	type MatchEvent,
	type PublicState,
} from "../../../shared/snake/types";
import {
	actionSourceName,
	choiceName,
	directionName,
	duration,
	eventName,
	matchSpeed,
	reasonName,
	statusName,
	stepModeName,
	stepStatusName,
} from "./api";
import { savedProbabilityGaps } from "./contextPresentation";
import { decisionModelName } from "./modelPresentation";

export function Shell(props: {
	page: "home" | "watch" | "live" | "history" | "replay";
	children: JSX.Element;
}) {
	return (
		<div class="snake-page" data-page={props.page}>
			<main class="snake-main">{props.children}</main>
			<footer class="snake-footer">
				<span>四个方向，无数种可能。</span>
				<span>每次选择，都有迹可循 · 模型决策实验</span>
			</footer>
		</div>
	);
}
export function Problem(props: { message: string; retry?: () => void }) {
	return (
		<div class="snake-problem" role="alert">
			<strong>暂时无法显示</strong>
			<p>{props.message}</p>
			<Show when={props.retry}>
				<button class="snake-button small" type="button" onClick={props.retry}>
					重新加载
				</button>
			</Show>
		</div>
	);
}
export function Clip(props: { kind: "intro" | "victory" }) {
	const [error, setError] = createSignal(false);
	const [reduced, setReduced] = createSignal(false);
	let video: HTMLVideoElement | undefined;
	onMount(() => {
		const preference = matchMedia("(prefers-reduced-motion: reduce)");
		setReduced(preference.matches);
		const change = () => {
			setReduced(preference.matches);
			if (preference.matches) video?.pause();
		};
		preference.addEventListener("change", change);
		onCleanup(() => preference.removeEventListener("change", change));
	});
	return (
		<div class="snake-clip">
			<Show when={!error()} fallback={<Problem message="视频素材加载失败" />}>
				<video
					ref={(element) => {
						video = element;
					}}
					muted
					playsinline
					controls
					preload="metadata"
					poster={`/assets/snake/${props.kind}-poster.jpg`}
					onError={() => setError(true)}
				>
					<source src={`/assets/snake/${props.kind}.mp4`} type="video/mp4" />
					<track
						kind="captions"
						src="/assets/snake/silent.vtt"
						srclang="zh"
						label="无对白动画"
					/>
				</video>
				<span class="clip-caption">
					{props.kind === "intro" ? "糖果色的热身。" : "每一格，都走到了。"}
					{reduced() ? " 动画仅在点击后播放。" : " 点击播放，默认静音。"}
				</span>
			</Show>
		</div>
	);
}
export function ScorePanel(props: { state: PublicState }) {
	return (
		<section class="snake-panel score-panel" aria-label="对局数据">
			<span>本局得分</span>
			<strong class="big-score">
				{props.state.score.toString().padStart(3, "0")}
			</strong>
			<div class="score-grid">
				<div>
					<small>对局步数</small>
					<b>{props.state.tick}</b>
				</div>
				<div>
					<small>蛇身长度</small>
					<b>
						{props.state.snake.length}
						<span> 格</span>
					</b>
				</div>
			</div>
		</section>
	);
}
export function DecisionPanel(props: {
	state: PublicState;
	elapsedGameTimeMs?: number;
	emptyContent?: JSX.Element;
}) {
	const selected = () => props.state.lastDecision;
	const probabilityTotal = () =>
		Object.values(selected()?.probabilities ?? {}).reduce(
			(total, value) => total + value,
			0,
		);
	return (
		<section class="snake-panel decision-panel">
			<div class="panel-title">
				<h2>最近收到的决策</h2>
				<span class="model-tag">{decisionModelName(props.state)}</span>
			</div>
			<p class="agent-name">{props.state.agentName}</p>
			<Show when={props.state.lastAppliedAction}>
				{(action) => (
					<section class="applied-action" aria-label="本步实际动作">
						<b>
							第 {action().tick} 步 · {actionSourceName(action().source)}
						</b>
						<p>
							{directionName(action().direction)}{" "}
							{action().requestId
								? props.state.config.decisionMode === "two_step_fallback"
									? `· 计划 ${action().requestId?.slice(0, 8)} · 第 ${(action().stepIndex ?? 0) + 1} 项`
									: `· 决策 ${action().requestId?.slice(0, 8)}`
								: `· ${reasonName(action().reason ?? null)}`}
						</p>
						<Show when={action().observedTick !== undefined}>
							<p class="tiny">依据第 {action().observedTick} 步观察</p>
						</Show>
					</section>
				)}
			</Show>
			<Show when={props.state.scheduledActions?.length}>
				<section class="scheduled-actions" aria-label="待执行计划">
					<b>待执行</b>
					<For each={props.state.scheduledActions}>
						{(a) => (
							<p class="tiny">
								第 {a.targetTick} 步 · {directionName(a.direction)} ·{" "}
								{a.stepIndex === 0
									? "新主动作"
									: a.eligible
										? "备用就绪"
										: "备用等待首步"}{" "}
								· {a.requestId?.slice(0, 8)}
							</p>
						)}
					</For>
				</section>
			</Show>
			<Show
				when={selected()}
				fallback={
					props.emptyContent ?? (
						<p class="muted">
							{props.state.status === "running"
								? isResponseMode(props.state.config)
									? "尚未收到模型响应，等待下一次决策后移动。"
									: "尚未收到模型响应，蛇按当前方向继续移动。"
								: "还没有收到模型决策。"}
						</p>
					)
				}
			>
				{(decision) => (
					<>
						<div class="decision-main">
							<b>{choiceName(decision().choice)}</b>
							<span>
								{Math.round(decision().requestMs)}
								<small> ms</small>
							</span>
						</div>
						<details
							class="probability-details"
							open={selected()?.kind !== "plan"}
						>
							<summary>
								{selected()?.kind === "plan"
									? "方向对的联合概率（16 项）"
									: "各方向概率"}
							</summary>
							<section class="probabilities" aria-label="模型原始概率">
								<For each={Object.entries(decision().probabilities)}>
									{([direction, probability]) => (
										<div class="probability-row">
											<span>{choiceName(direction)}</span>
											<span class="prob-track">
												<i
													classList={{
														chosen: decision().choice === direction,
													}}
													style={{
														width: `${probability * 100}%`,
													}}
												/>
											</span>
											<b>{Math.round(probability * 100)}%</b>
										</div>
									)}
								</For>
							</section>
							<For
								each={savedProbabilityGaps(
									decision().request,
									decision().probabilities,
								)}
							>
								{(gap) => (
									<p class="tiny">
										{directionName(gap.direction)}：{gap.status}
									</p>
								)}
							</For>
						</details>
						<div class="decision-outcome">
							<span>
								目标第 {decision().targetTick}
								{decision().kind === "plan"
									? ` / ${decision().targetTick + 1}`
									: ""}{" "}
								步
							</span>
							<b>
								{{
									accepted:
										decision().kind === "plan" ? "计划已接纳" : "等待生效",
									applied: "已生效",
									cancelled: "已取消",
								}[decision().outcome] ?? reasonName(decision().outcome)}
							</b>
						</div>
						<For each={decision().steps}>
							{(step, i) => (
								<p class="tiny">
									第 {step.targetTick} 步（{i() === 0 ? "主动作" : "备用"}）·{" "}
									{stepStatusName(step.status)}
									{step.reason ? ` · ${reasonName(step.reason)}` : ""}
								</p>
							)}
						</For>
						<p class="tiny">
							{decision().kind === "plan"
								? "概率和置信度属于整个方向对；两步共用一次请求耗时。"
								: "概率是模型的选择分布；响应耗时来自调用客户端。"}
						</p>
						<Show when={Math.abs(probabilityTotal() - 1) > 0.001}>
							<p class="tiny">
								原始概率合计 {(probabilityTotal() * 100).toFixed(2)}
								%，按原样保存，不影响方向指令。
							</p>
						</Show>
					</>
				)}
			</Show>
			<div class="panel-divider" />
			<div class="detail-row">
				<span>推进模式</span>
				<b>{stepModeName(props.state.config)}</b>
			</div>
			<div class="detail-row">
				<span>
					{isResponseMode(props.state.config) ? "平均步频" : "配置速度"}
				</span>
				<b>{matchSpeed(props.state, props.elapsedGameTimeMs)}</b>
			</div>
			<Show when={isResponseMode(props.state.config)}>
				<div class="detail-row">
					<span>最近一步间隔</span>
					<b>
						{props.state.lastStepDurationMs === undefined
							? "尚未移动"
							: `${Math.round(props.state.lastStepDurationMs)} ms`}
					</b>
				</div>
				<p class="tiny">平均步频按已走步数 / 运行时间计算，包含等待。</p>
			</Show>
			<div class="detail-row">
				<span>运行时间</span>
				<b>{duration(props.elapsedGameTimeMs ?? props.state.gameTimeMs)}</b>
			</div>
		</section>
	);
}
export function EventList(props: {
	events: MatchEvent[];
	currentSeq?: number;
	onSelect?: (index: number) => void;
}) {
	return (
		<section class="snake-panel event-panel">
			<h2>{props.onSelect ? "附近事件" : "最近事件"}</h2>
			<Show
				when={props.events.length > 0}
				fallback={<p class="muted">等待对局事件。</p>}
			>
				<ol class="snake-events">
					<For each={props.events}>
						{(event) => (
							<li classList={{ current: event.seq === props.currentSeq }}>
								<Show
									when={props.onSelect}
									fallback={
										<>
											<span class="event-step">
												{event.tick.toString().padStart(3, "0")}
											</span>
											<span>{eventName(event)}</span>
										</>
									}
								>
									<button
										type="button"
										onClick={() => props.onSelect?.(event.seq)}
										aria-current={
											event.seq === props.currentSeq ? "step" : undefined
										}
									>
										<span class="event-step">
											{event.tick.toString().padStart(3, "0")}
										</span>
										<span>{eventName(event)}</span>
									</button>
								</Show>
							</li>
						)}
					</For>
				</ol>
			</Show>
		</section>
	);
}
export function MatchInfo(props: { state: PublicState }) {
	return (
		<>
			<Show when={props.state.forkedFrom}>
				{(origin) => (
					<aside class="replay-live-notice" aria-label="续跑来源">
						<span>
							从原局第 {origin().tick}{" "}
							步续跑；此前的步数、得分和回放继承自原局。
						</span>
						<Link
							to="/matches/$matchId/replay"
							params={{ matchId: origin().matchId }}
						>
							查看原局 →
						</Link>
					</aside>
				)}
			</Show>
			<div class="board-meta">
				<span>
					{props.state.config.width} × {props.state.config.height} 格 <i>/</i>{" "}
					{props.state.config.obstacleCount} 个障碍
				</span>
				<span
					class="match-state"
					classList={{ running: props.state.status === "running" }}
				>
					{statusName(props.state.status)}
				</span>
			</div>
		</>
	);
}
