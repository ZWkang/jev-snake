import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { MatchEvent, PublicState } from "../../../shared/snake/types";
import { Select } from "../../components/ui/select";
import { ActionOutcomes } from "./ActionOutcomes";
import { choiceName, directionName, reasonName, stepStatusName } from "./api";
import { presentDecisionContext } from "./contextPresentation";
import { OpportunityEvidence } from "./OpportunityEvidence";
import { decisionForPosition, isDecisionEvent } from "./replay";

export function DecisionInput(props: {
	state: PublicState;
	events: MatchEvent[];
	onSelect: (seq: number) => void;
}) {
	const [copied, setCopied] = createSignal(false);
	const [copyError, setCopyError] = createSignal("");
	const decisions = createMemo(() => props.events.filter(isDecisionEvent));
	const decision = () => decisionForPosition(props.events, props.state);
	const event = createMemo(() =>
		decisions().find((row) => row.data.requestId === decision()?.requestId),
	);
	const request = () => decision()?.request;
	const presentation = createMemo(() =>
		presentDecisionContext(request(), decision()),
	);
	const supportedRequest = () => presentation().request;
	const responseMode = () =>
		supportedRequest()?.state.timing.tickIntervalMs === null;
	const targetTick = () => {
		const timing = supportedRequest()?.state.timing;
		return timing?.stateIsProjected
			? timing.projectedBeforeTick
			: timing?.targetTick;
	};
	const json = () => presentation().json;
	createEffect(() => {
		// Track the selected decision so copy feedback resets when it changes.
		void decision()?.requestId;
		setCopied(false);
		setCopyError("");
	});
	async function copy() {
		const text = json();
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setCopyError("");
		} catch (error) {
			setCopyError(error instanceof Error ? error.message : String(error));
		}
	}
	return (
		<section class="decision-input-panel" aria-label="决策输入">
			<div class="decision-input-heading">
				<div>
					<p class="page-context">模型当时看到了什么</p>
					<h2>决策输入</h2>
				</div>
				<Show when={request()}>
					<button
						class="snake-button small"
						type="button"
						onClick={() => void copy()}
					>
						{copied() ? "已复制 JSON" : "复制 JSON"}
					</button>
				</Show>
			</div>
			<Show when={decisions().length > 0}>
				<div class="decision-input-picker">
					<label for="decision-input-select">查看哪次决策</label>
					<Select
						id="decision-input-select"
						label="查看哪次决策输入"
						value={String(event()?.seq ?? "")}
						placeholder="选择一条决策，时间轴同步跳转"
						searchable
						options={decisions().map((row) => ({
							value: String(row.seq),
							label: `第 ${row.tick} 步收到 · 目标第 ${String(row.data.targetTick)} 步${row.type.endsWith("_rejected") ? " · 已拒绝" : " · 已接纳"}`,
						}))}
						onChange={(value) => props.onSelect(Number(value))}
					/>
				</div>
			</Show>
			<Show
				when={decision()}
				fallback={
					<p class="muted">
						当前回放位置还没有决策。选择一条决策后，可查看当时发送的内容。
					</p>
				}
			>
				<Show
					when={request()}
					fallback={
						<p class="muted">
							这条旧记录未保存请求正文，无法还原当时实际发送的内容。
						</p>
					}
				>
					<dl class="decision-input-facts">
						<div>
							<dt>Context 版本</dt>
							<dd>{presentation().version}</dd>
						</div>
						<div>
							<dt>本地构建耗时</dt>
							<dd>{presentation().contextBuildMs}</dd>
							<small>与模型请求耗时分别记录</small>
						</div>
						<div>
							<dt>发送正文大小</dt>
							<dd>{presentation().requestBytes}</dd>
							<small>保存的 UTF-8 字节数，未补算</small>
						</div>
					</dl>
					<Show when={supportedRequest()}>
						{(input) => (
							<>
								<dl class="decision-input-facts">
									<div>
										<dt>推进模式</dt>
										<dd>{responseMode() ? "随模型响应" : "固定步频"}</dd>
										<small>
											{responseMode()
												? "有效响应到达后走一步，无固定截止"
												: `${input().state.timing.tickIntervalMs} ms / 步`}
										</small>
									</div>
									<div>
										<dt>观察记录</dt>
										<dd>seq {String(event()?.data.observedSeq ?? "—")}</dd>
									</div>
									<div>
										<dt>执行目标</dt>
										<dd>
											第 {targetTick()}
											{decision()?.kind === "plan"
												? ` / ${(targetTick() ?? 0) + 1}`
												: ""}{" "}
											步
										</dd>
									</div>
									<div>
										<dt>
											{input().state.timing.stateIsProjected
												? "预判蛇头（旧记录）"
												: "观察蛇头"}
										</dt>
										<dd>
											({input().state.player.head.x},{" "}
											{input().state.player.head.y}) ·{" "}
											{directionName(input().state.player.direction)}
										</dd>
									</div>
									<div>
										<dt>请求模型</dt>
										<dd>{input().model}</dd>
										<Show when={decision()?.provider}>
											<small>
												{decision()?.provider === "typesafe"
													? "Typesafe 直连"
													: "OpenRouter"}
											</small>
										</Show>
									</div>
								</dl>
								<Show when={decision()?.kind === "plan"}>
									<section class="plan-results" aria-label="计划执行结果">
										<b>{choiceName(decision()?.choice ?? "")}</b>
										<For each={decision()?.steps}>
											{(step, i) => (
												<p>
													第 {step.targetTick} 步 ·{" "}
													{i() === 0 ? "主动作" : "备用"} ·{" "}
													{stepStatusName(step.status)}
													{step.reason ? ` · ${reasonName(step.reason)}` : ""}
												</p>
											)}
										</For>
									</section>
								</Show>
								<p class="decision-input-note">
									{input().state.timing.stateIsProjected
										? "这是旧运行器发送的预判局面，可能与当时实际位置不同。"
										: decision()?.kind === "plan"
											? "这是实际观察局面。计划包含下一步主动作和再下一步备用；备用以第一步实际执行为前提，未来奖励未知。迟到的新计划不会顺延。"
											: responseMode()
												? "这是发送时的实际局面。等待时蛇不移动；有效响应到达后立即走一步，再请求下一次决策。"
												: "这是发送时的实际局面，决策只用于紧接着的一次移动；迟到结果不会顺延。"}
									坐标从 0 开始。
								</p>
							</>
						)}
					</Show>
					<p class="decision-input-note">{presentation().semantics}</p>
					<p class="decision-input-note">{presentation().probabilityNote}</p>
					<Show when={supportedRequest()}>
						{(input) => (
							<ActionOutcomes
								request={input()}
								archive={decision()?.evidence}
							/>
						)}
					</Show>
					<Show when={supportedRequest()}>
						{(input) => (
							<OpportunityEvidence
								request={input()}
								archive={decision()?.evidence}
							/>
						)}
					</Show>
					<textarea
						class="decision-input-json"
						aria-label="发送给模型的原始 JSON"
						readOnly
						rows={16}
						value={json()}
					/>
				</Show>
			</Show>
			<Show when={copyError()}>
				<p class="decision-input-error" role="alert">
					复制失败：{copyError()}
				</p>
			</Show>
		</section>
	);
}
