import { For, Show } from "solid-js";
import type { DecisionRequestV9 } from "../../../shared/snake/bounded-search";
import type { DecisionRequestV8 } from "../../../shared/snake/global-view";
import type { DecisionRequestV10 } from "../../../shared/snake/post-apple-search";
import { directions } from "../../../shared/snake/types";
import { directionName } from "./api";
import { observedRegionDescription } from "./contextPresentation";

const entryLabels = {
	open_cell: "当前开放格",
	vacating_tail: "本步会移走的蛇尾",
	blocked: "本步入口被阻挡",
};

export function ObservedSpaceInput(props: {
	request: DecisionRequestV8 | DecisionRequestV9 | DecisionRequestV10;
}) {
	const space = () => props.request.state.observedSpace;
	return (
		<section aria-label="当前开放空间快照">
			<h3>当前开放空间快照</h3>
			<p class="decision-input-note">
				<strong>静态占用快照，不是动态可达、必死或安全证明。</strong>
				蛇身和障碍按观察时的位置占用棋盘；区域包含苹果只表示当时静态相连。身体与蛇尾后续移动会改变连通关系，入口周边开放方向也不表示下一步都能走。
			</p>
			<h4>全局开放区域</h4>
			<Show when={space().regions.length} fallback={<p>当前没有开放区域。</p>}>
				<dl class="decision-input-facts">
					<For each={space().regions}>
						{(region, index) => (
							<div>
								<dt>区域 {index() + 1}</dt>
								<dd>{region.cells} 格</dd>
								<small>
									{region.containsApple ? "含当前苹果" : "不含当前苹果"}
								</small>
							</div>
						)}
					</For>
				</dl>
			</Show>
			<h4>四方向的入口与周边</h4>
			<For each={directions}>
				{(direction) => {
					const move = () => space().moves[direction];
					return (
						<div>
							<h4>
								{directionName(direction)} · {entryLabels[move().entry]}
							</h4>
							<dl class="decision-input-facts">
								<div>
									<dt>入口所在开放区域</dt>
									<dd>{observedRegionDescription(move())}</dd>
								</div>
								<div>
									<dt>目标格周边当前开放格</dt>
									<dd>{move().openAdjacentCells} 格</dd>
								</div>
								<div>
									<dt>目标格周边当前开放方向</dt>
									<dd>
										{move()
											.openAdjacentDirections.map(directionName)
											.join("、") || "无"}
									</dd>
								</div>
							</dl>
						</div>
					);
				}}
			</For>
		</section>
	);
}
