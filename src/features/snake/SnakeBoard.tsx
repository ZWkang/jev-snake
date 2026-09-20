import {
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	Index,
	type JSX,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import type { Point, PublicState } from "../../../shared/snake/types";
import { directionName, reasonName, statusName } from "./api";
import { snakeColors } from "./appearance";
import {
	canInterpolateSnakeMove,
	snakeColorBands,
	snakeGeometry,
} from "./snakeGeometry";
import { motionDuration, SnakeMotion } from "./snakeMotion";

export function SnakeBoard(props: {
	state: PublicState;
	animate?: boolean;
	playbackRate?: number;
	endContent?: JSX.Element;
}) {
	const id = createUniqueId();
	const motion = new SnakeMotion(props.state.snake);
	const [geometry, setGeometry] = createSignal(
		snakeGeometry(props.state.snake),
	);
	const directionAngle = (direction: PublicState["direction"]) =>
		({ right: 0, down: 90, left: 180, up: 270 })[direction];
	let orientation = directionAngle(props.state.direction);
	const [heading, setHeading] = createSignal(orientation);
	const [turnDuration, setTurnDuration] = createSignal(0);
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
	function stopAnimation() {
		if (raf) cancelAnimationFrame(raf);
		raf = 0;
	}
	function face(direction: PublicState["direction"], milliseconds = 0) {
		const target = directionAngle(direction);
		orientation =
			milliseconds > 0
				? orientation +
					((((target - orientation + 540) % 360) + 360) % 360) -
					180
				: target;
		setTurnDuration(Math.min(140, milliseconds));
		setHeading(orientation);
	}
	function snap(state: PublicState) {
		stopAnimation();
		motion.snap(state.snake);
		setGeometry(motion.sample(performance.now()));
		face(state.direction);
	}
	const draw = (now: number) => {
		raf = 0;
		setGeometry(motion.sample(now));
		if (motion.isAnimating) raf = requestAnimationFrame(draw);
	};
	createEffect(() => {
		const state = props.state;
		const animate = props.animate !== false && !reduced();
		const old = previous;
		previous = state;
		if (
			old?.id === state.id &&
			animate &&
			state.tick === old.tick + 1 &&
			state.score > old.score
		) {
			clearTimeout(feedbackTimer);
			setFeedback(state.score - old.score);
			feedbackTimer = setTimeout(() => setFeedback(0), 450);
		} else if (
			!animate ||
			old?.id !== state.id ||
			state.tick < (old?.tick ?? 0)
		) {
			clearTimeout(feedbackTimer);
			setFeedback(0);
		}
		// Turning animation off, seeking or receiving a terminal snapshot must stop
		// an in-flight tween even when the committed tick has not changed.
		if (!old || old.id !== state.id || !animate || state.status !== "running") {
			snap(state);
			return;
		}
		if (
			state.tick === old.tick &&
			state.snake.length === old.snake.length &&
			state.snake.every(
				(point, index) =>
					point.x === old.snake[index].x && point.y === old.snake[index].y,
			)
		)
			return;
		if (
			state.tick !== old.tick + 1 ||
			!canInterpolateSnakeMove(old.snake, state.snake)
		) {
			snap(state);
			return;
		}
		stopAnimation();
		const now = performance.now();
		const duration = motionDuration(state, props.playbackRate ?? 1);
		motion.move(old.snake, state.snake, now, duration);
		setGeometry(motion.sample(now));
		face(state.direction, duration);
		if (motion.isAnimating) raf = requestAnimationFrame(draw);
	});
	onCleanup(() => {
		if (raf) cancelAnimationFrame(raf);
		clearTimeout(feedbackTimer);
	});
	const width = () => props.state.config.width * 32;
	const height = () => props.state.config.height * 32;
	const colors = createMemo(() => snakeColors(props.state.config));
	const bands = createMemo(() =>
		colors().length > 1 ? snakeColorBands(geometry()) : [],
	);
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
					<Index each={bands()}>
						{(band, index) => (
							<linearGradient
								id={`${id}-body-${index}`}
								gradientUnits="userSpaceOnUse"
								x1={band().head.x}
								y1={band().head.y}
								x2={band().tail.x}
								y2={band().tail.y}
							>
								<stop
									offset="0"
									stop-color={colors()[index % colors().length]}
								/>
								<stop
									offset="1"
									stop-color={colors()[(index + 1) % colors().length]}
								/>
							</linearGradient>
						)}
					</Index>
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
				<g
					data-kind="snake"
					fill="none"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path
						class="snake-body-outline"
						d={geometry().path}
						stroke="#171717"
						stroke-width="28"
					/>
					<path
						class="snake-body-fill"
						d={geometry().path}
						stroke={colors()[0]}
						stroke-width="24"
					/>
					<Index each={bands()}>
						{(band, index) => (
							<path
								class="snake-body-color"
								d={band().path}
								stroke={`url(#${id}-body-${index})`}
								stroke-width="24"
							/>
						)}
					</Index>
				</g>
				<g
					data-kind="snake-head"
					transform={`translate(${geometry().head.x} ${geometry().head.y})`}
				>
					<g
						class="snake-face"
						style={{
							transform: `rotate(${heading()}deg)`,
							"--snake-turn-duration": `${turnDuration()}ms`,
						}}
					>
						<ellipse
							cx="4"
							cy="-5.5"
							rx="3.6"
							ry="4.5"
							fill="#fffef7"
							stroke="#171717"
							stroke-width="1.2"
						/>
						<ellipse
							cx="4"
							cy="5.5"
							rx="3.6"
							ry="4.5"
							fill="#fffef7"
							stroke="#171717"
							stroke-width="1.2"
						/>
						<circle cx="5.8" cy="-5.5" r="1.6" fill="#171717" />
						<circle cx="5.8" cy="5.5" r="1.6" fill="#171717" />
					</g>
				</g>
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
					{props.endContent}
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
