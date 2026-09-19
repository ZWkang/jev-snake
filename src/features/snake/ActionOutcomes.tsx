import { For, Show } from "solid-js";
import type { SurvivalOutcome } from "../../../shared/snake/action-outcomes";
import type { DecisionRequestV5 } from "../../../shared/snake/outcome-context";
import {
	directions,
	type DecisionRequest,
	type PlanRequest,
	type Direction,
} from "../../../shared/snake/types";
import type { WitnessArchive } from "../../../shared/snake/witness-context";
import { directionName } from "./api";

export function survivalLabel(s: SurvivalOutcome): string {
	switch (s.status) {
		case "illegal_reverse":
			return "非法反向：会被拒绝，不移动";
		case "immediate_collision":
			return "这一步立即碰撞并结束游戏";
		case "board_complete":
			return "这一步填满棋盘";
		case "proven_fatal":
			return `所有续路均在 ${s.collisionWithinMoves} 步内碰撞（含本步和碰撞尝试）`;
		case "not_proven_fatal":
			return "尚未证明所有续路必死；不等于安全";
	}
}
export function ActionOutcomes(props: {
	request: DecisionRequest | PlanRequest;
	archive?: WitnessArchive;
}) {
	const request = (): DecisionRequestV5 | undefined =>
		props.request.state.contextVersion === "action-outcomes-v5"
			? (props.request as DecisionRequestV5)
			: undefined;
	const records = (direction: Direction) =>
		Object.values(props.archive?.records ?? {}).filter((r) => {
			const first =
				r.evidence.status === "non_growth_cycle"
					? r.evidence.witness.prefixDirections[0]
					: r.evidence.witness.directions[0];
			return (
				r.basis === "observed" &&
				r.origin.tick === request()?.state.timing.observedTick &&
				first === direction
			);
		});
	return (
		<Show when={request()}>
			{(input) => (
				<section aria-label="方向完整后果">
					<h3>每个方向的完整后果</h3>
					<p class="decision-input-note">
						“所有续路必死”和“某条进食路线吃后必死”分别展示。下面的英文摘要就是模型实际收到的事实；JEV
						自主选择，程序不代选。
					</p>
					<For each={directions}>
						{(direction) => {
							const facts = () =>
								input().questions.direction.criteria[direction];
							return (
								<details>
									<summary>
										{directionName(direction)} ·{" "}
										{survivalLabel(facts().survival)}
									</summary>
									<p>{facts().summary}</p>
									<Show when={facts().appleRoute.postApple}>
										{(post) => (
											<>
												<p>
													已验证路线：{facts().appleRoute.moves}{" "}
													步吃到当前苹果。
												</p>
												<p>
													{post().status === "proven_fatal"
														? `这条路线的增长终点：再过不超过 ${post().collisionWithinMoves} 次移动尝试必撞；从当前观察起合计上界 ${post().collisionWithinMovesFromObservation} 步。该结论只针对这条路线的终点。`
														: post().status === "board_complete"
															? "这条路线到达苹果时填满棋盘。"
															: "该路线增长后尚未证明必死；新食物和长期结果未知。"}
												</p>
											</>
										)}
									</Show>
									<Show when={facts().appleAlternativeSearch}>
										{(search) => (
											<p>
												初始 {search().initialRouteMoves}{" "}
												步路线吃后必死；继续检查不同身体排列，
												{search().status === "endpoint_found"
													? "找到另一条吃后尚未证明必死的路线"
													: "穷尽可达排列，所有吃苹果终点均已证明必死"}
												。展开 {search().expandedStates} 个状态，核验{" "}
												{search().fatalAppleEndpoints} 个必死苹果终点。
											</p>
										)}
									</Show>
									<Show when={facts().noGrowthCycle}>
										{(cycle) => (
											<p>
												发现无增长循环：前缀 {cycle().prefixMoves} 步、周期{" "}
												{cycle().period} 步；不代表获得苹果或完成棋盘。
											</p>
										)}
									</Show>
									<For each={facts().bodyReleasePassages}>
										{(p) => (
											<p>
												身体格 ({p.point.x}, {p.point.y}) 最早第{" "}
												{p.earliestReleaseStep} 步释放；该路线在第{" "}
												{p.enteredAtStep} 步进入。
											</p>
										)}
									</For>
									<Show
										when={
											records(direction).length ? records(direction) : undefined
										}
									>
										{(r) => (
											<>
												<p class="muted">
													后台完整路线见证（包含搜索中检查的初始路线与替代路线），未发送给模型，也不会自动执行：
												</p>
												<textarea
													class="decision-input-json"
													readOnly
													rows={8}
													aria-label={`${directionName(direction)}后台路线见证`}
													value={JSON.stringify(r(), null, 2)}
												/>
											</>
										)}
									</Show>
								</details>
							);
						}}
					</For>
				</section>
			)}
		</Show>
	);
}
