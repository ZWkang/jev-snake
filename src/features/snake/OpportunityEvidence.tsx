import { For, Show } from "solid-js";
import {
	directions,
	type DecisionRequest,
	type PlanRequest,
} from "../../../shared/snake/types";
import type {
	DecisionRequestV4,
	PlanRequestV4,
	OpportunitySummary,
	WitnessArchive,
} from "../../../shared/snake/witness-context";
import { directionName } from "./api";

export function opportunityDescription(fact: OpportunitySummary): string {
	switch (fact.status) {
		case "initial_collision":
			return "当前动作碰撞，无后续路线";
		case "exhausted":
			return "完整搜索未找到当前苹果路线或无增长循环";
		case "non_growth_cycle":
			return `已验证无增长循环：前缀 ${fact.cycle?.prefixMoves} 步，周期 ${fact.cycle?.period} 步；这不表示苹果不可达`;
		default:
			return fact.endEvent === "board_complete"
				? `${fact.moves} 步路线可填满棋盘`
				: `存在 ${fact.moves} 步进食路线；新苹果出现后需重新观察`;
	}
}
export function OpportunityEvidence(props: {
	request: DecisionRequest | PlanRequest;
	archive?: WitnessArchive;
}) {
	const v4 = (): DecisionRequestV4 | PlanRequestV4 | undefined => {
		const request = props.request;
		return request.state.contextVersion === "action-facts-v4" ||
			request.state.contextVersion === "two-step-plan-v4"
			? (request as DecisionRequestV4 | PlanRequestV4)
			: undefined;
	};
	const rows = () => {
		const request = v4();
		if (!request) return [];
		if ("direction" in request.questions) {
			const criteria = request.questions.direction.criteria;
			return directions.map((d) => ({
				label: directionName(d),
				fact: criteria[d].opportunity,
			}));
		}
		const first = request.state as Extract<
			PlanRequest["state"],
			{ contextVersion: "two-step-plan-v4" }
		>;
		return [
			...directions.map((d) => ({
				label: directionName(d),
				fact: first.firstActions[d].opportunity,
			})),
			...Object.values(request.questions.plan.criteria).flatMap((pair) =>
				pair.secondStatus === "known"
					? [
							{
								label: `${directionName(pair.first)}后${directionName(pair.second)}（条件第二步）`,
								fact: pair.secondFacts.opportunity,
							},
						]
					: [],
			),
		];
	};
	return (
		<Show when={v4()}>
			{(request) => (
				<section aria-label="正向路线证据">
					<h3>四方向的正向证据</h3>
					<p class="decision-input-note">
						这些路线用于说明可行机会，由 JEV
						每一步自主选择。程序不会沿路线自动驾驶，也不会替换模型选择。
					</p>
					<For each={rows()}>
						{(row) => (
							<details>
								<summary>
									{row.label} · {opportunityDescription(row.fact)}
								</summary>
								<For each={row.fact.releasePassages}>
									{(passage) => (
										<p>
											身体格 ({passage.point.x}, {passage.point.y}
											)：无增长时最早第 {passage.earliestReleaseStep}{" "}
											步释放，见证路线实际第 {passage.enteredAtStep} 步进入。
										</p>
									)}
								</For>
								<Show when={row.fact.witnessId}>
									{(id) => (
										<>
											<p class="muted">
												见证 {id().slice(0, 12)} ·{" "}
												{row.fact.scope === "no_growth_cycle"
													? "仅证明无增长循环"
													: "只验证到当前苹果；不预测下一颗苹果"}
											</p>
											<Show
												when={props.archive?.records[id()]}
												fallback={
													<p class="muted">这条记录未保存完整路线见证。</p>
												}
											>
												{(record) => (
													<textarea
														class="decision-input-json"
														aria-label={`${row.label}完整见证（未发送给模型）`}
														readOnly
														rows={8}
														value={JSON.stringify(record(), null, 2)}
													/>
												)}
											</Show>
										</>
									)}
								</Show>
							</details>
						)}
					</For>
					<h3>先前见证与实际移动</h3>
					<Show
						when={request().state.witnessContinuity.length}
						fallback={
							<p class="muted">
								没有尚未结束且与当前实际前缀一致的上一轮见证。
							</p>
						}
					>
						<For each={request().state.witnessContinuity}>
							{(continuity) => (
								<p>
									第 {continuity.originTick} 步的见证{" "}
									{continuity.witnessId.slice(0, 12)}：实际前缀吻合{" "}
									{continuity.matchedMoves} 步，尚余 {continuity.remainingMoves}{" "}
									步；该见证下一方向为{directionName(continuity.nextDirection)}
									。这不是模型承诺或推荐动作。
								</p>
							)}
						</For>
					</Show>
				</section>
			)}
		</Show>
	);
}
