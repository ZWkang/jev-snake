import { Show } from "solid-js";
import type { DecisionRequestV6 } from "../../../shared/snake/board-context";
import type { DecisionRequestV9 } from "../../../shared/snake/bounded-search";
import type { DecisionRequestV14 } from "../../../shared/snake/dynamic-space";
import type { DecisionRequestV8 } from "../../../shared/snake/global-view";
import type { DecisionRequestV15 } from "../../../shared/snake/growth-space";
import type { DecisionRequestV13 } from "../../../shared/snake/legal-space";
import type { DecisionRequestV7 } from "../../../shared/snake/local-moves";
import type { DecisionRequestV11 } from "../../../shared/snake/model-planning";
import type { DecisionRequestV12 } from "../../../shared/snake/non-reverse";
import type { DecisionRequestV10 } from "../../../shared/snake/post-apple-search";
import type { Point } from "../../../shared/snake/types";
import {
	presentBoardAscii,
	savedBoardAscii,
	savedBoardObservationLabel,
	savedStrategyGuide,
} from "./contextPresentation";

const coordinate = (point: Point) => `(${point.x}, ${point.y})`;
const mapStyle = {
	"font-family": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
	"white-space": "pre",
	"overflow-x": "auto",
	"max-width": "100%",
} as const;

export function BoardStateInput(props: {
	request:
		| DecisionRequestV6
		| DecisionRequestV7
		| DecisionRequestV8
		| DecisionRequestV9
		| DecisionRequestV10
		| DecisionRequestV11
		| DecisionRequestV12
		| DecisionRequestV13
		| DecisionRequestV14
		| DecisionRequestV15;
	currentTick?: number;
	onShowDecisionFrame?: () => void;
}) {
	const state = () => props.request.state;
	const observationNotice = () => (
		<div>
			<p class="decision-input-note" aria-label="输入棋盘观察时间">
				{savedBoardObservationLabel(props.request, props.currentTick)}
			</p>
			<Show when={props.onShowDecisionFrame}>
				{(showFrame) => (
					<button
						class="snake-button small"
						type="button"
						onClick={() => showFrame()()}
					>
						查看这步执行前棋盘
					</button>
				)}
			</Show>
		</div>
	);
	return (
		<section aria-label="完整棋盘输入">
			<h3>完整棋盘输入</h3>
			<Show when={!savedBoardAscii(props.request)}>{observationNotice()}</Show>
			<dl class="decision-input-facts">
				<div>
					<dt>棋盘尺寸</dt>
					<dd>
						{state().board.width} × {state().board.height}
					</dd>
				</div>
				<div>
					<dt>障碍物</dt>
					<dd>{state().board.obstacles.length} 个</dd>
				</div>
				<div>
					<dt>蛇身长度</dt>
					<dd>{state().player.bodyHeadToTail.length} 格</dd>
				</div>
				<div>
					<dt>苹果位置</dt>
					<dd>
						<Show when={state().food.apple} fallback="无">
							{(apple) => coordinate(apple())}
						</Show>
					</dd>
				</div>
				<div>
					<dt>星星位置</dt>
					<dd>
						<Show when={state().food.star} fallback="无">
							{(star) => coordinate(star().point)}
						</Show>
					</dd>
				</div>
			</dl>
			<Show when={presentBoardAscii(props.request)}>
				{(ascii) => (
					<div style={{ "min-width": "0", "max-width": "100%" }}>
						<h4>{ascii().title}</h4>
						{observationNotice()}
						<p class="decision-input-note">{ascii().legend}</p>
						<pre
							aria-label={
								ascii().redrawn
									? "按历史输入坐标重绘的决策前字符图"
									: "模型决策前的字符图（历史输入）"
							}
							tabIndex={0}
							style={mapStyle}
						>
							{ascii().map}
						</pre>
						<Show when={ascii().originalNamedText}>
							{(original) => (
								<details>
									<summary>实际发送给模型的逐格文字</summary>
									<p class="decision-input-note">{original().legend}</p>
									<pre
										aria-label="实际发送给模型的逐格文字"
										tabIndex={0}
										style={mapStyle}
									>
										{original().map}
									</pre>
								</details>
							)}
						</Show>
					</div>
				)}
			</Show>
			<Show when={savedStrategyGuide(props.request)}>
				{(guide) => (
					<section aria-label="通用策略说明">
						<h4>通用策略说明</h4>
						<p class="decision-input-note">
							这是当时发送的通用策略说明，由模型结合棋盘自行判断适用性并选择方向。
						</p>
						<p style={{ "white-space": "pre-wrap" }}>{guide()}</p>
					</section>
				)}
			</Show>
			<details>
				<summary>模型收到的蛇身与障碍坐标</summary>
				<p>
					蛇身（从头到尾）：
					{state().player.bodyHeadToTail.map(coordinate).join(" → ")}
				</p>
				<p>
					障碍物：{state().board.obstacles.map(coordinate).join("、") || "无"}
				</p>
			</details>
		</section>
	);
}
