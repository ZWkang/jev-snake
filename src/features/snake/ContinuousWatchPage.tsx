import { Link } from "@tanstack/solid-router";
import { Show } from "solid-js";
import { LiveMatch } from "./LiveMatch";
import { OwnerControl } from "./OwnerControl";
import { RoundLoading } from "./RoundLoading";
import { Problem, Shell } from "./Scene";
import { channelLabel, createWatchChannel } from "./watchChannel";

export function ContinuousWatchPage(props: { admin?: boolean }) {
	const channel = createWatchChannel();
	const displayed = () =>
		channel.state()?.currentMatchId ?? channel.state()?.lastMatchId;
	return (
		<Shell page="watch">
			<div class="page-heading">
				<div>
					<p class="page-context">连续观战 · 跟随每一场真实对局</p>
					<h1>下一局，接着看。</h1>
				</div>
				<Link to="/matches" class="back-link">
					历史对局
				</Link>
			</div>
			<Show when={props.admin}>
				<OwnerControl state={channel.state()} onUpdate={channel.accept} />
			</Show>
			<div
				class="watch-channel-status"
				data-phase={channel.state()?.phase ?? "loading"}
				role="status"
			>
				<Show
					when={
						channel.state()?.phase === "starting" &&
						(channel.state()?.currentMatchId || !displayed())
					}
					fallback={
						<strong>
							{channelLabel(
								channel.state(),
								channel.phase() === "live" ? channel.remaining() : null,
							)}
						</strong>
					}
				>
					<RoundLoading
						phase={channel.state()?.phase}
						remaining={channel.remaining()}
						connected={channel.phase() === "live"}
					/>
				</Show>
				<span>
					{channel.phase() === "live"
						? "频道已同步"
						: channel.phase() === "reconnecting"
							? "频道连接中断，正在重连"
							: "频道状态正在同步"}
				</span>
			</div>
			<Show when={channel.error()}>
				<Problem message={channel.error()} retry={channel.refresh} />
			</Show>
			<Show when={channel.state()?.error}>
				{(error) => (
					<div class="snake-problem" role="alert">
						<strong>连续观战遇到错误</strong>
						<p>{error().message}</p>
						<p>等待管理员恢复后继续。</p>
					</div>
				)}
			</Show>
			<Show
				when={displayed()}
				keyed
				fallback={
					<div class="watch-empty">
						<h2>
							{channel.state()?.phase === "starting"
								? "正在准备第一场对局"
								: "等待连续观战开启"}
						</h2>
						<p>开启后，每场结束都会自动接着下一场。观看页面不会触发开局。</p>
						<Link to="/matches" class="snake-button yellow">
							翻看历史对局
						</Link>
					</div>
				}
			>
				{(id) => (
					<LiveMatch
						matchId={id}
						endContent={
							<RoundLoading
								phase={channel.state()?.phase}
								remaining={channel.remaining()}
								connected={channel.phase() === "live"}
							/>
						}
					/>
				)}
			</Show>
		</Shell>
	);
}
