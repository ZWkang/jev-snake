import { createMemo, For, Show } from "solid-js";
import type { WatchSnapshot } from "../../../shared/snake/watch";
import "./transitions.css";

export function RoundLoading(props: {
	phase: WatchSnapshot["phase"] | undefined;
	remaining: number | null;
	connected: boolean;
}) {
	const mode = createMemo(() => {
		if (props.phase !== "countdown" && props.phase !== "starting") return null;
		if (
			!props.connected ||
			(props.phase === "countdown" && props.remaining === null)
		)
			return "syncing";
		return props.phase === "countdown" &&
			props.remaining !== null &&
			props.remaining > 0
			? "countdown"
			: "starting";
	});
	return (
		<Show when={mode()}>
			<div
				class="round-loading"
				data-state={mode()}
				role="status"
				aria-live="polite"
				aria-atomic="true"
			>
				<svg
					class="round-clock"
					viewBox="0 0 48 48"
					fill="none"
					aria-hidden="true"
				>
					<circle class="round-clock-track" cx="24" cy="24" r="21" />
					<circle
						class="round-clock-sweep"
						cx="24"
						cy="24"
						r="21"
						stroke-dasharray="34 98"
					/>
					<path
						class="round-clock-ticks"
						d="M24 9v2M39 24h-2M24 39v-2M9 24h2"
					/>
					<path class="round-clock-hour" d="M24 24l-7-5" />
					<path class="round-clock-hand" d="M24 24V14" />
					<circle cx="24" cy="24" r="2" fill="currentColor" />
				</svg>
				<div class="round-loading-copy">
					<Show
						when={mode() === "countdown"}
						fallback={
							<>
								<strong>
									{mode() === "syncing" ? "正在同步频道" : "正在准备下一局"}
								</strong>
								<span>
									{mode() === "syncing"
										? "连接恢复后更新倒计时"
										: "等待新棋盘就绪"}
								</span>
							</>
						}
					>
						<span>下一局即将开始</span>
						<strong class="round-countdown">
							<Show when={String(props.remaining)} keyed>
								{(digits) => (
									<span class="t-digit-group is-animating">
										<For each={digits.split("")}>
											{(digit) => <span class="t-digit">{digit}</span>}
										</For>
									</span>
								)}
							</Show>
							<span class="round-countdown-unit">秒后自动开局</span>
						</strong>
					</Show>
				</div>
			</div>
		</Show>
	);
}
