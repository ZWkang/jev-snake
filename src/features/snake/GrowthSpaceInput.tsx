import { For, Show } from "solid-js";
import type { DecisionRequestV16 } from "../../../shared/snake/compact-growth";
import type { DecisionRequestV15 } from "../../../shared/snake/growth-space";
import { directions } from "../../../shared/snake/types";
import { directionName } from "./api";
import {
	presentGrowthSpaceMove,
	savedDynamicSemantics,
} from "./contextPresentation";
import { modelName } from "./modelPresentation";

export function GrowthSpaceInput(props: {
	request: DecisionRequestV15 | DecisionRequestV16;
}) {
	const limits = () => props.request.state.analysisLimits;
	const options = () =>
		directions.filter((direction) =>
			Object.hasOwn(props.request.questions.direction.criteria, direction),
		);
	return (
		<section aria-label="动态空间与吃果后续检查">
			<h3>动态空间与吃果后续检查</h3>
			<p class="decision-input-note">
				{props.request.state.contextVersion === "compact-growth-v16"
					? "以下按当时保存的动态事实提供中文解释，这些解释原文不是请求正文。"
					: "以下是当时保存的模型输入。"}
				方向必困分析最多检查 {limits().trapDepth} 步，寻找当前苹果最多检查{" "}
				{limits().appleDepth}{" "}
				步，两者都包含本次候选移动。每个吃果到达方式继续检查最多{" "}
				{limits().postAppleDepth} 步，这部分从吃果后开始计数，不含吃果这一步。
			</p>
			<p class="decision-input-note">
				每个方向的必困搜索、进食搜索和吃果后续检查分别最多探索{" "}
				{limits().maxNodesPerSearch}{" "}
				个节点。其中所有吃果到达方式共享后续检查预算，不会为每个到达方式重置预算。
			</p>
			<p class="decision-input-note">
				吃果后按“不再增长”的乐观条件检查身体与尾巴移动，不生成或预测新苹果。窗口内能走不保证真实后续安全，未知与节点限额也不是安全结论。跳过已证明困死的吃果到达方式，不会从
				{modelName(props.request.model)}{" "}
				选项中移除整个方向；每一步仍执行模型真实选择。
			</p>
			<For each={options()}>
				{(direction) => (
					<Show when={props.request.state.dynamicFacts[direction]}>
						{(facts) => {
							const view = () =>
								presentGrowthSpaceMove(facts(), modelName(props.request.model));
							const rows = () => [
								["方向必困判断", view().trap],
								["方向分析已探索", view().trapNodes],
								["当前苹果候选", view().apple],
								["候选吃果后即时出口", view().appleExit],
								["候选吃果后静态尾部邻接", view().appleTail],
								["候选吃果后续检查", view().postApple],
								["该到达方式检查节点", view().postAppleNodes],
								["全部到达方式检查节点", view().postAppleTotal],
								["已跳过的困死到达方式", view().rejectedArrivals],
								["进食搜索停止原因", view().appleTermination],
								["进食搜索已探索", view().appleNodes],
							];
							return (
								<div>
									<h4>{directionName(direction)} · 吃果后续分析</h4>
									<dl class="decision-input-facts">
										<For each={rows()}>
											{([label, value]) => (
												<div>
													<dt>{label}</dt>
													<dd>{value}</dd>
												</div>
											)}
										</For>
									</dl>
								</div>
							);
						}}
					</Show>
				)}
			</For>
			<Show when={savedDynamicSemantics(props.request)}>
				{(semantics) => (
					<details>
						<summary>实际发送的动态事实定义</summary>
						<p>{semantics()}</p>
					</details>
				)}
			</Show>
		</section>
	);
}
