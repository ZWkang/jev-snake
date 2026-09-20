import { For, Show } from "solid-js";
import type { DecisionRequestV9 } from "../../../shared/snake/bounded-search";
import type { DecisionRequestV8 } from "../../../shared/snake/global-view";
import type { DecisionRequestV7 } from "../../../shared/snake/local-moves";
import type { DecisionRequestV10 } from "../../../shared/snake/post-apple-search";
import { directions } from "../../../shared/snake/types";
import { directionName } from "./api";

const blockedByLabels = {
	none: "本步可走",
	reverse: "非法反向，会被拒绝",
	wall: "本步撞边界",
	obstacle: "本步撞障碍物",
	body: "本步撞蛇身",
};
const destinationLabels = {
	outside_board: "棋盘外",
	obstacle: "障碍物",
	snake_body: "蛇身",
	vacating_tail: "本步会移走的蛇尾",
	apple: "苹果",
	star: "星星",
	empty: "空格",
};
const appleProgressLabels = {
	eats_now: "本步吃到苹果",
	closer: "到苹果的曼哈顿距离减少",
	farther: "到苹果的曼哈顿距离增加",
	same_distance: "到苹果的曼哈顿距离不变",
	no_apple: "当前没有苹果",
	not_applicable: "本步不可走，不比较距离",
};
const departureHistoryLabels = {
	not_taken_here: "已有记录中，未从当前完整局面选择过此方向",
	taken_without_recorded_return:
		"曾从当前完整局面选择此方向，未记录到未吃苹果就返回",
	returned_without_apple: "曾从当前完整局面选择此方向，并在未吃苹果时返回",
	not_recorded: "未记录历史",
};

export function ImmediateMovesInput(props: {
	request:
		| DecisionRequestV7
		| DecisionRequestV8
		| DecisionRequestV9
		| DecisionRequestV10;
}) {
	return (
		<section aria-label="四方向本步事实">
			<h3>四方向本步事实</h3>
			<p class="decision-input-note">
				以下来自当时发送的请求。本步可走只表示这一次移动符合规则，历史只记录实际发生的移动。这些信息不保证后续安全，也不是推荐路线。
				<Show when={props.request.state.contextVersion === "local-moves-v7"}>
					旧版请求中的苹果距离变化忽略障碍和蛇身。
				</Show>
			</p>
			<For each={directions}>
				{(direction) => {
					const move = () => props.request.state.immediateMoves[direction];
					const criteria = () =>
						props.request.questions.direction.criteria[direction];
					const appleProgress = () => {
						const facts = move();
						return "appleProgress" in facts ? facts.appleProgress : undefined;
					};
					return (
						<div>
							<h4>
								{directionName(direction)} · {blockedByLabels[move().blockedBy]}
							</h4>
							<dl class="decision-input-facts">
								<div>
									<dt>目标格</dt>
									<dd>
										({move().target.x}, {move().target.y})
									</dd>
								</div>
								<div>
									<dt>本步可走</dt>
									<dd>{move().legal ? "是" : "否"}</dd>
								</div>
								<div>
									<dt>格子内容</dt>
									<dd>{destinationLabels[move().destination]}</dd>
								</div>
								<Show when={appleProgress()}>
									{(progress) => (
										<div>
											<dt>苹果距离</dt>
											<dd>{appleProgressLabels[progress()]}</dd>
										</div>
									)}
								</Show>
								<div>
									<dt>真实重复历史</dt>
									<dd>{departureHistoryLabels[move().departureHistory]}</dd>
								</div>
							</dl>
							<details>
								<summary>发送给模型的本方向说明</summary>
								<p>{move().description}</p>
								<dl>
									<dt>方向含义</dt>
									<dd>{criteria().meaning}</dd>
									<dt>选择条件</dt>
									<dd>{criteria().chooseWhen}</dd>
									<dt>排除条件</dt>
									<dd>{criteria().excludeWhen}</dd>
								</dl>
							</details>
						</div>
					);
				}}
			</For>
			<details>
				<summary>发送给模型的问题与约束</summary>
				<dl>
					<For
						each={Object.entries(
							props.request.questions.direction.instructions,
						)}
					>
						{([key, value]) => (
							<>
								<dt>{key}</dt>
								<dd>{value}</dd>
							</>
						)}
					</For>
				</dl>
			</details>
		</section>
	);
}
