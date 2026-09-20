import { For, Show } from "solid-js";
import type { DecisionRequestV14 } from "../../../shared/snake/dynamic-space";
import { directions } from "../../../shared/snake/types";
import { directionName } from "./api";
import { presentDynamicSpaceMove } from "./contextPresentation";

export function DynamicSpaceInput(props: { request: DecisionRequestV14 }) {
	const limits = () => props.request.state.analysisLimits;
	const options = () =>
		directions.filter((direction) =>
			Object.hasOwn(props.request.questions.direction.criteria, direction),
		);
	return (
		<section aria-label="动态空间与进食候选分析">
			<h3>动态空间与进食候选分析</h3>
			<p class="decision-input-note">
				以下结果来自当时保存的请求，包含蛇身和尾巴随步移动、吃果增长。必困分析最多检查{" "}
				{limits().trapDepth} 步，当前苹果候选最多检查 {limits().appleDepth}{" "}
				步；每个方向的每项搜索最多探索 {limits().maxNodesPerSearch}{" "}
				个节点。步数包含本次候选移动，不生成或预测新苹果。
			</p>
			<p class="decision-input-note">
				全部本步合法方向仍交给 JEV
				选择，包括标记为必困的方向。窗口内能走不代表长期安全；未知或达到限额不代表安全或无路。程序只执行模型选择的一步。
			</p>
			<For each={options()}>
				{(direction) => (
					<Show when={props.request.state.dynamicFacts[direction]}>
						{(facts) => {
							const view = () => presentDynamicSpaceMove(facts());
							return (
								<div>
									<h4>{directionName(direction)} · 动态分析</h4>
									<dl class="decision-input-facts">
										<div>
											<dt>后续必困判断</dt>
											<dd>{view().trap}</dd>
											<small>已探索 {view().trapNodes}</small>
										</div>
										<div>
											<dt>当前苹果候选</dt>
											<dd>{view().apple}</dd>
										</div>
										<div>
											<dt>候选吃果后即时出口</dt>
											<dd>{view().appleExit}</dd>
										</div>
										<div>
											<dt>候选吃果后尾部邻接</dt>
											<dd>{view().appleTail}</dd>
										</div>
										<div>
											<dt>进食搜索停止原因</dt>
											<dd>{view().appleTermination}</dd>
											<small>已探索 {view().appleNodes}</small>
										</div>
									</dl>
								</div>
							);
						}}
					</Show>
				)}
			</For>
			<details>
				<summary>实际发送的动态事实定义</summary>
				<p>{props.request.state.dynamicSemantics}</p>
			</details>
		</section>
	);
}
