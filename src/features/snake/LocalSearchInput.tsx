import { For, Show } from "solid-js";
import type { DecisionRequestV9 } from "../../../shared/snake/bounded-search";
import type {
	DecisionRequestV10,
	PostAppleSearchMove,
} from "../../../shared/snake/post-apple-search";
import { directions } from "../../../shared/snake/types";
import { directionName } from "./api";
import {
	localSearchAppleExitDescription,
	localSearchCutoffDescription,
	localSearchDescription,
	postAppleCutoffDescription,
	postAppleDescription,
} from "./contextPresentation";

export function LocalSearchInput(props: {
	request: DecisionRequestV9 | DecisionRequestV10;
}) {
	const search = () => props.request.state.localSearch;
	const withPostApple = () =>
		props.request.state.contextVersion === "post-apple-v10";
	return (
		<section aria-label="有限局部搜索">
			<h3>有限局部搜索</h3>
			<p class="decision-input-note">
				{withPostApple()
					? "吃果前路线与吃果后的乐观检查共用下面记录的总深度和节点预算。吃后假设不再增长，不生成或预测新苹果；尚未证明死亡不保证真实未来安全。只有穷尽且排除可能提前填满棋盘后，才回溯被证明困死的端点。见证路线用于展示已检查的路径，由模型自行选择当前方向。"
					: "搜索按记录中的深度与节点预算检查真实蛇身移动，路线以当前苹果为边界，同时检查增长后的即时出口，不生成或预测新苹果。找到苹果路线不说明吃后安全，仅有限步可存活也不说明长期安全；预算内未完成判断不代表安全或必死。见证路线用于展示已检查的路径，由模型自行选择当前方向。"}
			</p>
			<dl class="decision-input-facts">
				<div>
					<dt>搜索方式</dt>
					<dd>
						{withPostApple()
							? "迭代加深搜索，含吃后乐观检查"
							: "迭代加深深度优先搜索"}
					</dd>
				</div>
				<div>
					<dt>{withPostApple() ? "整条路径总深度上限" : "深度上限"}</dt>
					<dd>{search().maxDepth} 步</dd>
					<Show when={withPostApple()}>
						<small>吃果前路线与吃后检查共用</small>
					</Show>
				</div>
				<div>
					<dt>总展开节点 / 节点预算</dt>
					<dd>
						{search().expandedNodes} / {search().maxNodes}
					</dd>
				</div>
			</dl>
			<For each={directions}>
				{(direction) => {
					const move = () => search().moves[direction];
					const postMove = (): PostAppleSearchMove | undefined => {
						const state = props.request.state;
						return state.contextVersion === "post-apple-v10"
							? state.localSearch.moves[direction]
							: undefined;
					};
					return (
						<div>
							<h4>
								{directionName(direction)} · {localSearchDescription(move())}
							</h4>
							<dl class="decision-input-facts">
								<div>
									<dt>记录状态</dt>
									<dd>{move().status}</dd>
								</div>
								<div>
									<dt>展开节点 / 分配预算</dt>
									<dd>
										{move().expandedNodes} / {move().nodeBudget}
									</dd>
								</div>
								<div>
									<dt>实际达到深度</dt>
									<dd>{move().maxDepthReached} 步</dd>
								</div>
								<div>
									<dt>截断原因（{move().cutoff}）</dt>
									<dd>
										{localSearchCutoffDescription(
											move().cutoff,
											props.request.state.contextVersion,
										)}
									</dd>
								</div>
							</dl>
							<Show when={postMove()}>
								{(post) => (
									<section
										aria-label={`${directionName(direction)}吃果后的乐观检查`}
									>
										<h4>吃果后的乐观检查</h4>
										<dl class="decision-input-facts">
											<div>
												<dt>所有吃后检查展开节点</dt>
												<dd>{post().postAppleExpandedNodes}</dd>
												<small>已计入上方展开节点，共用总预算</small>
											</div>
											<div>
												<dt>困死端点回溯次数</dt>
												<dd>{post().rejectedAppleEndpoints} 次</dd>
												<small>
													按端点访问次数计数，包含重复；不是唯一不同路线数
												</small>
											</div>
										</dl>
										<Show when={post().postApple}>
											{(check) => (
												<>
													<p>假设：吃下当前苹果后不再增长。</p>
													<p>{postAppleDescription(check())}</p>
													<dl class="decision-input-facts">
														<div>
															<dt>保留路线的吃后结果</dt>
															<dd>{check().result}</dd>
														</div>
														<div>
															<dt>吃后深度上限</dt>
															<dd>{check().maxDepth} 步</dd>
															<small>总上限减去进食路线长度</small>
														</div>
														<div>
															<dt>吃后实际达到深度</dt>
															<dd>{check().maxDepthReached} 步</dd>
														</div>
														<div>
															<dt>本次吃后检查展开节点</dt>
															<dd>{check().expandedNodes}</dd>
														</div>
														<div>
															<dt>吃后截断原因（{check().cutoff}）</dt>
															<dd>
																{postAppleCutoffDescription(check().cutoff)}
															</dd>
														</div>
													</dl>
												</>
											)}
										</Show>
									</section>
								)}
							</Show>
							<Show when={move().appleExitDirections}>
								{(exits) => (
									<div>
										<h4>这条路线吃后即时出口</h4>
										<p>{localSearchAppleExitDescription(exits())}</p>
										<Show when={exits().length > 0}>
											<p>{exits().map(directionName).join("、")}</p>
										</Show>
									</div>
								)}
							</Show>
							<Show when={move().witness} fallback={<p>无见证路线。</p>}>
								{(witness) => (
									<details>
										<summary>已检查的 {witness().length} 步见证路线</summary>
										<p>{witness().map(directionName).join(" → ")}</p>
									</details>
								)}
							</Show>
						</div>
					);
				}}
			</For>
		</section>
	);
}
