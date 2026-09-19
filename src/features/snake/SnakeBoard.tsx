import {
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	Index,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import type { Point, PublicState } from "../../../shared/snake/types";
import { isResponseMode } from "../../../shared/snake/types";
import { directionName, reasonName, statusName } from "./api";
import { snakeColors } from "./appearance";

export function SnakeBoard(props: {
	state: PublicState;
	animate?: boolean;
	playbackRate?: number;
}) {
	const id = createUniqueId();
	const [positions, setPositions] = createSignal<Point[]>(props.state.snake);
	const [reduced, setReduced] = createSignal(false);
	const [assetError, setAssetError] = createSignal(false);
	const [feedback, setFeedback] = createSignal(0);
	let previous: PublicState | undefined;
	let raf = 0;
	let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
	onMount(() => {
		const m = matchMedia("(prefers-reduced-motion: reduce)");
		setReduced(m.matches);
		const change = () => setReduced(m.matches);
		m.addEventListener("change", change);
		onCleanup(() => m.removeEventListener("change", change));
	});
	createEffect(() => {
		const s = props.state;
		const animate = props.animate !== false && !reduced();
		const old = previous;
		previous = s;
		if (
			old &&
			old.id === s.id &&
			animate &&
			s.tick === old.tick + 1 &&
			s.score > old.score
		) {
			clearTimeout(feedbackTimer);
			setFeedback(s.score - old.score);
			feedbackTimer = setTimeout(() => setFeedback(0), 450);
		} else if (!animate || old?.id !== s.id || s.tick < (old?.tick ?? 0)) {
			clearTimeout(feedbackTimer);
			setFeedback(0);
		}
		if (old?.id === s.id && old.tick === s.tick && animate) return;
		if (raf) cancelAnimationFrame(raf);
		if (
			!old ||
			old.id !== s.id ||
			!animate ||
			isResponseMode(s.config) ||
			s.tick !== old.tick + 1 ||
			s.status === "interrupted"
		) {
			setPositions(s.snake);
			return;
		}
		const start = performance.now();
		const from = old.snake;
		const ms = (s.config.tickIntervalMs / (props.playbackRate ?? 1)) * 0.8;
		const draw = (now: number) => {
			const t = Math.min(1, (now - start) / ms);
			setPositions(
				s.snake.map((point, i) => {
					const p = from[i] ?? point;
					return { x: p.x + (point.x - p.x) * t, y: p.y + (point.y - p.y) * t };
				}),
			);
			if (t < 1) raf = requestAnimationFrame(draw);
		};
		raf = requestAnimationFrame(draw);
	});
	onCleanup(() => {
		if (raf) cancelAnimationFrame(raf);
		clearTimeout(feedbackTimer);
	});
	const width = () => props.state.config.width * 32;
	const height = () => props.state.config.height * 32;
	const colors = createMemo(() => snakeColors(props.state.config));
	const angle = () =>
		({ right: 0, down: 90, left: 180, up: 270 })[props.state.direction];
	function Reward(rewardProps: { point: Point; star: boolean }) {
		return (
			<g
				data-kind={rewardProps.star ? "star" : "apple"}
				transform={`translate(${rewardProps.point.x * 32} ${rewardProps.point.y * 32})`}
			>
				<svg
					x="0"
					y="0"
					width="32"
					height="32"
					viewBox={`${rewardProps.star ? "887" : "0"} 0 887 887`}
					overflow="hidden"
				>
					<title>{rewardProps.star ? "星星奖励" : "苹果奖励"}</title>
					<image
						href="/assets/snake/rewards.png"
						width="1774"
						height="887"
						onError={() => setAssetError(true)}
					/>
				</svg>
			</g>
		);
	}
	return (
		<div class="board-shell">
			<svg
				class="game-board"
				role="img"
				aria-label={
					"贪吃蛇棋盘，" +
					props.state.config.width +
					"列" +
					props.state.config.height +
					"行，蛇长" +
					props.state.snake.length +
					"，" +
					directionName(props.state.direction)
				}
				viewBox={`0 0 ${width()} ${height()}`}
				style={{
					"aspect-ratio": `${props.state.config.width}/${props.state.config.height}`,
				}}
			>
				<defs>
					<pattern
						id={`${id}-grid`}
						width="32"
						height="32"
						patternUnits="userSpaceOnUse"
					>
						<path
							d="M32 0H0V32"
							fill="none"
							stroke="#d4cdb7"
							stroke-width="1"
						/>
					</pattern>
					<pattern
						id={`${id}-hatch`}
						width="7"
						height="7"
						patternUnits="userSpaceOnUse"
						patternTransform="rotate(45)"
					>
						<path d="M0 0V7" stroke="#262131" stroke-width="2" />
					</pattern>
				</defs>
				<rect width={width()} height={height()} fill="#fff9e9" />
				<rect width={width()} height={height()} fill={`url(#${id}-grid)`} />
				<Index each={props.state.obstacles}>
					{(p) => (
						<g
							data-kind="obstacle"
							transform={`translate(${p().x * 32} ${p().y * 32})`}
						>
							<rect
								x="3"
								y="3"
								width="26"
								height="26"
								rx="3"
								fill="#9787be"
								stroke="#171717"
								stroke-width="2"
							/>
							<rect
								x="5"
								y="5"
								width="22"
								height="22"
								fill={`url(#${id}-hatch)`}
							/>
						</g>
					)}
				</Index>
				<Index each={positions()}>
					{(p, i) => (
						<g
							data-kind="snake"
							transform={`translate(${p().x * 32} ${p().y * 32})`}
						>
							<rect
								x="1.5"
								y="2.5"
								width="29"
								height="29"
								rx={i === 0 ? "10" : "7"}
								fill="#171717"
							/>
							<rect
								x="1.5"
								y="1"
								width="29"
								height="29"
								rx={i === 0 ? "10" : "7"}
								fill={colors()[i % colors().length]}
								stroke="#171717"
								stroke-width="2.5"
							/>
							<path
								d="M7 10Q7 6 15 6"
								stroke="#fff8dc"
								stroke-width="3"
								stroke-linecap="round"
								fill="none"
							/>
							<Show when={i === 0}>
								<g transform={`rotate(${angle()} 16 16)`}>
									<ellipse
										cx="23"
										cy="10"
										rx="5"
										ry="6"
										fill="white"
										stroke="#171717"
										stroke-width="1.5"
									/>
									<ellipse
										cx="23"
										cy="23"
										rx="5"
										ry="6"
										fill="white"
										stroke="#171717"
										stroke-width="1.5"
									/>
									<circle cx="25" cy="10" r="2.2" fill="#171717" />
									<circle cx="25" cy="23" r="2.2" fill="#171717" />
								</g>
							</Show>
						</g>
					)}
				</Index>
				<Show when={props.state.apple}>
					{(p) => <Reward point={p()} star={false} />}
				</Show>
				<Show when={props.state.star}>
					{(star) => <Reward point={star().point} star={true} />}
				</Show>
				<Show when={feedback() && !reduced()}>
					<text
						class="pickup-score"
						x={(props.state.snake[0].x + 0.5) * 32}
						y={Math.max(18, props.state.snake[0].y * 32 - 8)}
						text-anchor="middle"
						stroke="#fff9e9"
						stroke-width="4"
						paint-order="stroke"
						fill="#171717"
						font-size="23"
						font-weight="900"
					>
						+{feedback()}
					</text>
				</Show>
			</svg>
			<Show when={props.state.status === "ready"}>
				<div class="board-state">
					<span class="state-sticker">准备好了</span>
					<Show
						when={
							props.state.forkedFrom &&
							props.state.seq > props.state.forkedFrom.seq
						}
						fallback={
							<>
								<h2>等待玩家开始</h2>
								<p>棋盘已生成，时钟尚未启动。</p>
							</>
						}
					>
						<h2>等待继续对局</h2>
						<p>已恢复到第 {props.state.tick} 步，等待新的决策。</p>
					</Show>
				</div>
			</Show>
			<Show
				when={["gameover", "won", "interrupted"].includes(props.state.status)}
			>
				<div class="board-state ended">
					<span class="state-sticker">{statusName(props.state.status)}</span>
					<h2>{reasonName(props.state.endReason)}</h2>
					<p>
						{props.state.score} 分 · {props.state.tick} 步
					</p>
				</div>
			</Show>
			<Show when={assetError()}>
				<p class="board-asset-error" role="alert">
					奖励素材加载失败
				</p>
			</Show>
		</div>
	);
}
