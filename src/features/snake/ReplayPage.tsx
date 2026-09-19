import { Link } from "@tanstack/solid-router";
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import type { MatchEvent, PublicState } from "../../../shared/snake/types";
import { isResponseMode } from "../../../shared/snake/types";
import { Select } from "../../components/ui/select";
import {
	allEvents,
	duration,
	eventName,
	isActiveMatch,
	matchSpeed,
	reasonName,
	statusName,
	stepModeName,
} from "./api";
import { DecisionInput } from "./DecisionInput";
import {
	atTime,
	decisionStatistics,
	isDecisionEvent,
	isKeyEvent,
	nextStep,
	previousStep,
	replayStartIndex,
} from "./replay";
import {
	Clip,
	DecisionPanel,
	EventList,
	MatchInfo,
	Problem,
	ScorePanel,
	Shell,
} from "./Scene";
import { SnakeBoard } from "./SnakeBoard";
import { playbackTimeAt } from "./timing";

export function ReplayPage(props: { matchId: string }) {
	const [events, setEvents] = createSignal<MatchEvent[]>([]);
	const [record, setRecord] = createSignal<PublicState>();
	const [index, setIndex] = createSignal(0);
	const [playing, setPlaying] = createSignal(false);
	const [playbackTime, setPlaybackTime] = createSignal(0);
	const [rate, setRate] = createSignal(1);
	const [error, setError] = createSignal("");
	const [loading, setLoading] = createSignal(true);
	const [mounted, setMounted] = createSignal(false);
	const current = createMemo(() => events()[index()]?.state);
	const nearby = createMemo(() =>
		events().slice(Math.max(0, index() - 4), index() + 5),
	);
	const keyEvents = createMemo(() => events().filter(isKeyEvent));
	const decisions = createMemo(() => events().filter(isDecisionEvent));
	const stats = createMemo(() => decisionStatistics(events()));
	const appliedDecisions = () => stats().primary + stats().fallback;
	let abort: AbortController | undefined;
	let raf = 0;
	function pause() {
		setPlaying(false);
		if (raf) cancelAnimationFrame(raf);
		raf = 0;
	}
	function seek(i: number) {
		pause();
		setIndex(i);
		setPlaybackTime(events()[i].gameTimeMs);
	}
	async function load(matchId = props.matchId) {
		pause();
		abort?.abort();
		abort = new AbortController();
		const signal = abort.signal;
		setError("");
		setLoading(true);
		setIndex(0);
		setPlaybackTime(0);
		try {
			const rows = await allEvents(matchId, signal);
			if (signal.aborted) return;
			if (!rows.length) throw new Error("该对局没有可回放记录");
			const startIndex = replayStartIndex(rows);
			setRecord(rows[rows.length - 1].state);
			setEvents(rows);
			setIndex(startIndex);
			setPlaybackTime(rows[startIndex].gameTimeMs);
		} catch (e) {
			if (!signal.aborted) setError(e instanceof Error ? e.message : String(e));
		} finally {
			if (!signal.aborted) setLoading(false);
		}
	}
	function play() {
		if (playing()) {
			pause();
			return;
		}
		if (index() === events().length - 1) {
			setIndex(0);
			setPlaybackTime(events()[0].gameTimeMs);
		}
		const baseTime = playbackTime();
		const started = performance.now();
		const playbackRate = rate();
		setPlaying(true);
		const draw = (now: number) => {
			const time = playbackTimeAt(
				baseTime,
				now - started,
				playbackRate,
				events()[events().length - 1].gameTimeMs,
			);
			setPlaybackTime(time);
			setIndex(atTime(events(), time));
			if (index() >= events().length - 1) {
				pause();
				return;
			}
			raf = requestAnimationFrame(draw);
		};
		raf = requestAnimationFrame(draw);
	}
	onMount(() => setMounted(true));
	createEffect(() => {
		const id = props.matchId;
		if (mounted()) void load(id);
	});
	onCleanup(() => {
		pause();
		abort?.abort();
	});
	return (
		<Shell page="replay">
			<div class="page-heading">
				<div>
					<p class="page-context">
						对局回放 <span>#{props.matchId.slice(0, 8)}</span>
					</p>
					<h1>回到关键的那一步。</h1>
				</div>
				<Link to="/matches" class="back-link">
					← 返回历史
				</Link>
			</div>
			<Show when={error()}>
				<Problem message={error()} retry={() => void load()} />
			</Show>
			<Show
				when={!loading() && !error() && current()}
				fallback={
					<Show when={loading()}>
						<output class="loading-state">正在读取完整对局序列…</output>
					</Show>
				}
			>
				{(s) => (
					<>
						<div class="replay-info">
							<span>
								{record()?.agentName} <i>/</i>{" "}
								{statusName(record()?.status ?? "")}
							</span>
							<span>
								{isActiveMatch(record()?.status ?? "")
									? "已记录得分"
									: "最终得分"}{" "}
								<b>{record()?.score}</b> <i>/</i> {stepModeName(s().config)} ·{" "}
								{matchSpeed(record() ?? s())}
							</span>
						</div>
						<Show when={isActiveMatch(record()?.status ?? "")}>
							<div class="replay-live-notice">
								<span>当前为回放模式，不会自动跟随新进度。</span>
								<Link to="/watch/$matchId" params={{ matchId: props.matchId }}>
									进入实时观战 →
								</Link>
							</div>
						</Show>
						<div class="game-layout">
							<section class="board-section">
								<MatchInfo state={s()} />
								<SnakeBoard
									state={s()}
									animate={playing()}
									playbackRate={rate()}
								/>
								<Show when={s().star}>
									{(star) => (
										<p class="star-notice">
											星星剩余{" "}
											{Math.max(
												0,
												Math.ceil((star().expiresAt - playbackTime()) / 1000),
											)}{" "}
											秒
										</p>
									)}
								</Show>
								<div class="playback-panel">
									<div class="timeline-head">
										<strong>
											第 {s().tick} <span>/ {record()?.tick} 步</span>
										</strong>
										<span>
											{duration(playbackTime())} /{" "}
											{duration(record()?.gameTimeMs ?? 0)}
										</span>
									</div>
									<input
										class="replay-scrubber"
										type="range"
										aria-label="回放时间轴"
										min="0"
										max={Math.max(0, events().length - 1)}
										step="1"
										value={index()}
										onInput={(e) => seek(Number(e.currentTarget.value))}
									/>
									<div class="playback-controls">
										<Show when={record()?.forkedFrom}>
											<button
												type="button"
												class="text-button"
												onClick={() => seek(replayStartIndex(events()))}
											>
												续跑起点
											</button>
										</Show>
										<button
											type="button"
											class="transport-icon"
											aria-label="从头开始"
											onClick={() => seek(0)}
										>
											↤
										</button>
										<button
											type="button"
											class="transport-icon"
											aria-label="上一步"
											disabled={index() === 0}
											onClick={() => seek(previousStep(events(), index()))}
										>
											←
										</button>
										<button type="button" class="play-button" onClick={play}>
											{playing() ? "Ⅱ 暂停" : "▶ 播放"}
										</button>
										<button
											type="button"
											class="transport-icon"
											aria-label="下一步"
											disabled={index() >= events().length - 1}
											onClick={() => seek(nextStep(events(), index()))}
										>
											→
										</button>
										<div class="rate-label">
											<label for="replay-rate">播放速度</label>
											<Select
												id="replay-rate"
												label="回放倍速"
												value={String(rate())}
												searchable={false}
												options={[0.5, 1, 2, 4].map((value) => ({
													value: String(value),
													label: `${value}×`,
												}))}
												onChange={(value) => {
													const resume = playing();
													pause();
													setRate(Number(value));
													if (resume) play();
												}}
											/>
										</div>
									</div>
									<div class="key-event-picker">
										<label for="key-event">跳到关键事件</label>
										<Select
											id="key-event"
											label="跳到关键事件"
											value={String(events()[index()]?.seq ?? "")}
											placeholder="选择事件"
											searchable
											options={keyEvents().map((event) => ({
												value: String(event.seq),
												label: `第 ${event.tick} 步 · ${eventName(event)}`,
											}))}
											onChange={(value) =>
												seek(
													events().findIndex(
														(event) => event.seq === Number(value),
													),
												)
											}
										/>
									</div>
									<p class="tiny">
										播放速度仅影响观看。局面、得分和动作均来自原始记录。
									</p>
								</div>
								<Show when={index() === events().length - 1}>
									<output class="replay-end">
										{record()?.status === "running" ||
										record()?.status === "ready"
											? "已到当前记录末尾，原局尚未结束。"
											: "已到记录末尾 · " +
												reasonName(record()?.endReason ?? null)}
										<Show when={record()?.status === "running"}>
											{" "}
											<button
												class="text-button"
												type="button"
												onClick={() => void load()}
											>
												读取新记录
											</button>
										</Show>
									</output>
								</Show>
								<Show when={s().status === "won"}>
									<details class="victory-film">
										<summary>看看这场胜利</summary>
										<Clip kind="victory" />
									</details>
								</Show>
							</section>
							<aside
								class="game-sidebar"
								classList={{
									"two-step-sidebar": s().recordVersion === 2,
									"response-sidebar": isResponseMode(s().config),
								}}
							>
								<ScorePanel state={s()} />
								<Show when={record()?.recordVersion === 2}>
									<p class="decision-summary">
										模型请求 {stats().requests} 次 · 新决策 {stats().primary} 步
										· 上轮备用 {stats().fallback} 步 · 沿原方向 {stats().coast}{" "}
										步
									</p>
								</Show>
								<DecisionPanel
									state={s()}
									elapsedGameTimeMs={playbackTime()}
									emptyContent={
										<Show
											when={decisions()[0]}
											fallback={
												<p class="muted">这份对局记录中尚无模型响应。</p>
											}
										>
											{(first) => (
												<div class="decision-empty">
													<p class="muted">
														本局已记录 {decisions().length} 次模型决策，
														{appliedDecisions()}{" "}
														次生效。当前回放尚未到首次响应。
													</p>
													<p class="muted">
														首次响应在 {(first().gameTimeMs / 1000).toFixed(2)}{" "}
														秒 · 第 {first().tick} 步。
													</p>
													<button
														type="button"
														class="text-button"
														onClick={() =>
															seek(
																events().findIndex(
																	(e) => e.seq === first().seq,
																),
															)
														}
													>
														跳到首次决策 →
													</button>
												</div>
											)}
										</Show>
									}
								/>
								<EventList
									events={nearby()}
									currentSeq={events()[index()]?.seq}
									onSelect={(seq) =>
										seek(events().findIndex((e) => e.seq === seq))
									}
								/>
							</aside>
						</div>
						<DecisionInput
							state={s()}
							events={events()}
							onSelect={(seq) =>
								seek(events().findIndex((event) => event.seq === seq))
							}
						/>
						<div class="match-footnote">
							<span>
								地图种子 <code>{s().config.seed}</code>
							</span>
							<span>已读取 {events().length} 条真实事件</span>
						</div>
					</>
				)}
			</Show>
		</Shell>
	);
}
