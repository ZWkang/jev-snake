import { Link } from "@tanstack/solid-router";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import type {
	EventPage,
	MatchEvent,
	PublicState,
} from "../../../shared/snake/types";
import { isResponseMode } from "../../../shared/snake/types";
import {
	api,
	assertRecord,
	isActiveMatch,
	matchSpeed,
	stepModeName,
} from "./api";
import {
	Clip,
	DecisionPanel,
	EventList,
	MatchInfo,
	Problem,
	ScorePanel,
} from "./Scene";
import { SnakeBoard } from "./SnakeBoard";
import { type ElapsedSample, elapsedAt } from "./timing";

export function LiveMatch(props: { matchId: string }) {
	const [mounted, setMounted] = createSignal(false);
	onMount(() => setMounted(true));
	const [state, setState] = createSignal<PublicState>();
	const [recent, setRecent] = createSignal<MatchEvent[]>([]);
	const [phase, setPhase] = createSignal("loading");
	const [error, setError] = createSignal("");
	const [retry, setRetry] = createSignal(0);
	const [elapsedGameTimeMs, setElapsedGameTimeMs] = createSignal(0);
	const [elapsedSample, setElapsedSample] = createSignal<ElapsedSample>();
	function sampleElapsed(elapsed: number) {
		setElapsedSample({
			elapsedGameTimeMs: elapsed,
			receivedAt: performance.now(),
		});
		setElapsedGameTimeMs(elapsed);
	}
	createEffect(() => {
		const sample = elapsedSample();
		if (!sample || phase() !== "live" || state()?.status !== "running") return;
		const refresh = () =>
			setElapsedGameTimeMs(elapsedAt(sample, performance.now()));
		refresh();
		const timer = setInterval(refresh, 100);
		onCleanup(() => clearInterval(timer));
	});
	createEffect(() => {
		const id = props.matchId;
		retry();
		if (!mounted() || !id) return;
		const abort = new AbortController();
		let disposed = false;
		let socket: WebSocket | undefined;
		let reconnect: ReturnType<typeof setTimeout> | undefined;
		let cursor = -1;
		let fatal = false;
		setError("");
		setPhase("loading");
		setState(undefined);
		setRecent([]);
		setElapsedSample(undefined);
		setElapsedGameTimeMs(0);
		function open() {
			if (disposed || fatal) return;
			socket = new WebSocket(
				(location.protocol === "https:" ? "wss://" : "ws://") +
					location.host +
					"/ws/matches/" +
					id +
					"/watch",
			);
			socket.onopen = () => {
				if (disposed) return;
				socket?.send(JSON.stringify({ type: "subscribe", afterSeq: cursor }));
				setPhase("syncing");
			};
			socket.onmessage = (message) => {
				if (disposed) return;
				try {
					const packet = JSON.parse(message.data) as {
						type: string;
						event?: MatchEvent;
						latestSeq?: number;
						elapsedGameTimeMs: number;
						serverTime?: number;
						error?: { message: string };
					};
					if (packet.type === "subscribed") {
						sampleElapsed(packet.elapsedGameTimeMs);
						if ((packet.latestSeq ?? cursor) <= cursor) setPhase("live");
						return;
					}
					if (packet.type === "error" || packet.type === "service_error")
						throw new Error(packet.error?.message ?? "实时连接发生错误");
					if (packet.type !== "event" || !packet.event) return;
					const event = packet.event;
					assertRecord(event.state);
					if (event.seq <= cursor) return;
					if (event.seq !== cursor + 1)
						throw new Error("事件序列缺失，请重新同步");
					cursor = event.seq;
					setState(event.state);
					sampleElapsed(
						event.state.status === "running"
							? packet.elapsedGameTimeMs
							: event.gameTimeMs,
					);
					setRecent((events) => [...events, event].slice(-8));
					setPhase("live");
					setError("");
				} catch (e) {
					fatal = true;
					setError(e instanceof Error ? e.message : String(e));
					setPhase("error");
					socket?.close();
				}
			};
			socket.onerror = () => {
				if (!disposed) setPhase("reconnecting");
			};
			socket.onclose = () => {
				if (disposed || fatal) return;
				setPhase("reconnecting");
				reconnect = setTimeout(open, 1000);
			};
		}
		void (async () => {
			try {
				const current = await api<
					PublicState & { elapsedGameTimeMs: number; serverTime: number }
				>(`/matches/${id}`, abort.signal);
				const receivedAt = performance.now();
				assertRecord(current);
				const page = await api<EventPage>(
					"/matches/" +
						id +
						"/events?afterSeq=" +
						Math.max(-1, current.seq - 8),
					abort.signal,
				);
				if (disposed) return;
				const last = page.events.at(-1);
				setState(last?.state ?? current);
				const displayedElapsed =
					last && last.state.status !== "running"
						? last.gameTimeMs
						: current.elapsedGameTimeMs;
				setElapsedSample({
					elapsedGameTimeMs: displayedElapsed,
					receivedAt,
				});
				setElapsedGameTimeMs(displayedElapsed);
				cursor = last?.seq ?? current.seq;
				setRecent(page.events.slice(-8));
				open();
			} catch (e) {
				if (!disposed) {
					setError(e instanceof Error ? e.message : String(e));
					setPhase("error");
				}
			}
		})();
		onCleanup(() => {
			disposed = true;
			abort.abort();
			clearTimeout(reconnect);
			socket?.close();
		});
	});
	const syncLabel = () =>
		({
			loading: "正在载入",
			syncing: "补齐对局记录",
			live: state()?.status === "running" ? "实时更新" : "已同步",
			reconnecting: "连接中断，重连中",
			error: "更新已停止",
		})[phase()];
	return (
		<section class="live-match" data-match-id={props.matchId}>
			<Show when={error()}>
				<Problem message={error()} retry={() => setRetry((v) => v + 1)} />
			</Show>
			<Show
				when={state()}
				fallback={<output class="loading-state">正在读取真实对局记录…</output>}
			>
				{(s) => (
					<>
						<div class="live-toolbar">
							<span
								class="sync-status"
								classList={{ disconnected: phase() !== "live" }}
								aria-live="polite"
							>
								<i />
								{syncLabel()}
							</span>
							<span>
								{s().agentName} <i>/</i> {s().id.slice(0, 8)}
							</span>

							<Link to="/matches/$matchId/replay" params={{ matchId: s().id }}>
								{isActiveMatch(s().status) ? "回看已记录片段 ↗" : "查看回放 ↗"}
							</Link>
						</div>
						<div class="game-layout">
							<section class="board-section">
								<MatchInfo state={s()} />
								<SnakeBoard state={s()} animate={phase() === "live"} />
								<Show
									when={
										isResponseMode(s().config) &&
										s().status === "running" &&
										phase() === "live"
									}
								>
									<output class="response-waiting">等待下一次决策后移动</output>
								</Show>
								<div class="board-legend">
									<span>
										<i class="legend-apple" />
										苹果 +10
									</span>
									<span>
										<i class="legend-star" />
										星星 +30
									</span>
									<span>
										<i class="legend-obstacle" />
										随机障碍
									</span>
									<span class="speed-note">
										{stepModeName(s().config)} ·{" "}
										{matchSpeed(s(), elapsedGameTimeMs())}
									</span>
								</div>
								<Show when={s().star}>
									{(star) => (
										<p class="star-notice">
											星星剩余{" "}
											{Math.max(
												0,
												Math.ceil(
													(star().expiresAt - elapsedGameTimeMs()) / 1000,
												),
											)}{" "}
											秒
										</p>
									)}
								</Show>
								<Show when={s().status === "won"}>
									<details class="victory-film">
										<summary>庆祝这场胜利</summary>
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
								<DecisionPanel
									state={s()}
									elapsedGameTimeMs={elapsedGameTimeMs()}
								/>
								<EventList events={[...recent()].reverse()} />
							</aside>
						</div>
						<div class="match-footnote">
							<span>
								地图种子 <code>{s().config.seed}</code>
							</span>
							<span>观战操作不会改变原始对局。</span>
						</div>
					</>
				)}
			</Show>
		</section>
	);
}
