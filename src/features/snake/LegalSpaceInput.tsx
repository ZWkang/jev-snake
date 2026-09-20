import { For, Show } from "solid-js";
import type { DecisionRequestV16 } from "../../../shared/snake/compact-growth";
import type { DecisionRequestV14 } from "../../../shared/snake/dynamic-space";
import type { DecisionRequestV15 } from "../../../shared/snake/growth-space";
import type { DecisionRequestV13 } from "../../../shared/snake/legal-space";
import { directions } from "../../../shared/snake/types";
import { directionName } from "./api";
import {
	legalSpaceExclusionDescription,
	presentLegalSpaceMove,
	savedFactsSemantics,
} from "./contextPresentation";
import { modelName } from "./modelPresentation";

export function LegalSpaceInput(props: {
	request:
		| DecisionRequestV13
		| DecisionRequestV14
		| DecisionRequestV15
		| DecisionRequestV16;
}) {
	const options = () =>
		directions.filter((direction) =>
			Object.hasOwn(props.request.questions.direction.criteria, direction),
		);
	return (
		<section aria-label="合法方向与移动后空间">
			<h3>合法方向与移动后空间</h3>
			<p class="decision-input-note">
				{props.request.state.contextVersion === "compact-growth-v16"
					? "以下按当时保存的单步静态事实提供中文解释，这些解释原文不是请求正文；动态检查另列。空格数不含蛇身或障碍，尾部邻接不等于动态可达。"
					: props.request.state.contextVersion !== "legal-space-v13"
						? "以下是当时发送给模型的单步静态事实，动态分析另列。此部分模拟本步移动，再遍历移动后的静态空域；空格数不含蛇身或障碍，尾部邻接不等于动态可达。"
						: "以下是当时发送给模型的事实。程序只模拟本步移动，再遍历移动后的静态空域；未搜索后续路线，也不预测新苹果。空格数不含蛇身或障碍，尾部邻接不等于动态可达。"}
			</p>
			<Show when={options().length === 1}>
				<p class="decision-input-note">
					只有一个合法选项，本次仍实际调用 {modelName(props.request.model)}
					；此处展示模型真实返回结果。
				</p>
			</Show>
			<For each={options()}>
				{(direction) => (
					<Show when={props.request.state.moveFacts[direction]}>
						{(facts) => {
							const view = () => presentLegalSpaceMove(facts());
							return (
								<div>
									<h4>{directionName(direction)} · 本步合法</h4>
									<dl class="decision-input-facts">
										<div>
											<dt>目标格</dt>
											<dd>
												{view().target} · {view().turn}
											</dd>
										</div>
										<div>
											<dt>食物与增长</dt>
											<dd>
												{view().growth}；{view().star}
											</dd>
										</div>
										<div>
											<dt>苹果距离</dt>
											<dd>{view().appleDistance}</dd>
										</div>
										<div>
											<dt>可达空格 / 全部空格</dt>
											<dd>{view().space}</dd>
										</div>
										<div>
											<dt>静态尾部邻接</dt>
											<dd>{view().tailConnection}</dd>
										</div>
										<div>
											<dt>下一步合法出口</dt>
											<dd>{view().nextMoves}</dd>
										</div>
										<div>
											<dt>死路风险</dt>
											<dd>{view().deadEndRisk}</dd>
										</div>
										<div>
											<dt>终局</dt>
											<dd>{view().terminal}</dd>
										</div>
									</dl>
									<details>
										<summary>实际发送的选项说明</summary>
										<p>
											{props.request.questions.direction.criteria[direction]}
										</p>
									</details>
								</div>
							);
						}}
					</Show>
				)}
			</For>
			<h4>已从模型选项中排除</h4>
			<dl class="decision-input-facts">
				<For each={directions}>
					{(direction) => (
						<Show when={props.request.state.excludedMoves[direction]}>
							{(reason) => (
								<div>
									<dt>{directionName(direction)} · 不在选项</dt>
									<dd>{legalSpaceExclusionDescription(reason())}</dd>
								</div>
							)}
						</Show>
					)}
				</For>
			</dl>
			<details>
				<summary>
					{savedFactsSemantics(props.request)
						? "实际发送的问题与事实定义"
						: "实际发送的问题"}
				</summary>
				<p style={{ "white-space": "pre-wrap" }}>
					{props.request.questions.direction.instructions}
				</p>
				<Show when={savedFactsSemantics(props.request)}>
					{(semantics) => <p>{semantics()}</p>}
				</Show>
			</details>
		</section>
	);
}
