import { Dialog } from "@kobalte/core/dialog";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
	contributionConsentVersion,
	type CommunityConfig,
	type CommunityProvider,
	type ContributionReceipt,
} from "../../../shared/snake/community";
import { communityApi, communityErrorMessage } from "./api";
import "./community.css";

function SuccessMark(props: { animate: boolean }) {
	let path: SVGPathElement | undefined;
	onMount(() => {
		if (path) {
			const length = Math.ceil(path.getTotalLength()) + 1;
			path.style.strokeDasharray = String(length);
			path.style.strokeDashoffset = props.animate ? String(length) : "0";
		}
	});
	return (
		<div
			class="contribution-celebration"
			classList={{ "is-celebrating": props.animate }}
			aria-hidden="true"
		>
			<span class="celebration-star star-one">✦</span>
			<span class="celebration-star star-two">✦</span>
			<span class="celebration-star star-three">✦</span>
			<span
				class="t-success-check"
				data-state={props.animate ? "in" : "static"}
			>
				<svg viewBox="0 0 48 48" fill="none">
					<path
						ref={(element) => {
							path = element;
						}}
						d="M13 25L21 33L36 16"
						stroke="currentColor"
						stroke-width="4"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
			</span>
		</div>
	);
}
export function CommunityActions() {
	const [config, setConfig] = createSignal<CommunityConfig>(),
		[configError, setConfigError] = createSignal("");
	const [groupOpen, setGroupOpen] = createSignal(false),
		[keyOpen, setKeyOpen] = createSignal(false),
		[qrFailed, setQrFailed] = createSignal(false);
	const [provider, setProvider] = createSignal<CommunityProvider>("typesafe"),
		[key, setKey] = createSignal(""),
		[consent, setConsent] = createSignal(false),
		[mode, setMode] = createSignal<"contribute" | "revoke">("contribute");
	const [pending, setPending] = createSignal(false),
		[checking, setChecking] = createSignal(false),
		[error, setError] = createSignal(""),
		[receipt, setReceipt] = createSignal<ContributionReceipt>(),
		[requestId, setRequestId] = createSignal<string>(),
		[revoked, setRevoked] = createSignal(false),
		[animate, setAnimate] = createSignal(false);
	const presented = new Set<string>();
	let mounted = true;
	async function loadConfig() {
		setConfigError("");
		try {
			const result = await communityApi<CommunityConfig>("/community");
			if (mounted) setConfig(result);
		} catch (error) {
			if (mounted) setConfigError(communityErrorMessage(error));
		}
	}
	onMount(() => void loadConfig());
	onCleanup(() => {
		mounted = false;
		setKey("");
		setConsent(false);
	});
	function openKey(open: boolean) {
		setKeyOpen(open);
		if (!open) {
			setKey("");
			setConsent(false);
			setAnimate(false);
		} else if (!config()) void loadConfig();
	}
	function receive(result: ContributionReceipt) {
		if (!mounted) return;
		const celebrate =
			result.status === "enabled" &&
			result.created &&
			!presented.has(result.requestId) &&
			keyOpen();
		if (result.status === "enabled") presented.add(result.requestId);
		setReceipt(result);
		setAnimate(celebrate);
		if (result.status === "enabled") {
			setKey("");
			setConsent(false);
		}
	}
	async function submit() {
		if (pending()) return;
		const apiKey = key().trim();
		if (!apiKey) {
			setError("请输入对应服务商的 Key。");
			return;
		}
		if (mode() === "contribute" && !consent()) {
			setError("请先确认验证和持续使用授权。");
			return;
		}
		const id = crypto.randomUUID();
		setPending(true);
		setError("");
		setRevoked(false);
		setAnimate(false);
		if (mode() === "contribute") setRequestId(id);
		try {
			if (mode() === "revoke") {
				await communityApi("/key-contributions/revoke", {
					requestId: id,
					provider: provider(),
					apiKey,
				});
				if (mounted) {
					setRevoked(true);
					setKey("");
					setReceipt(undefined);
					setRequestId(undefined);
				}
			} else
				receive(
					await communityApi<ContributionReceipt>("/key-contributions", {
						requestId: id,
						provider: provider(),
						apiKey,
						consent: true,
						consentVersion: contributionConsentVersion,
					}),
				);
		} catch (error) {
			if (mounted) setError(communityErrorMessage(error));
		} finally {
			if (mounted) setPending(false);
		}
	}
	async function check() {
		if (!requestId() || checking()) return;
		setChecking(true);
		setError("");
		try {
			receive(
				await communityApi<ContributionReceipt>("/key-contributions/status", {
					requestId: requestId(),
				}),
			);
		} catch (error) {
			if (mounted) setError(communityErrorMessage(error));
		} finally {
			if (mounted) setChecking(false);
		}
	}
	function changeMode() {
		setMode(mode() === "contribute" ? "revoke" : "contribute");
		setKey("");
		setConsent(false);
		setReceipt(undefined);
		setRevoked(false);
		setError("");
		setAnimate(false);
	}
	return (
		<div class="community-header-actions">
			<Dialog
				open={groupOpen()}
				onOpenChange={(open) => {
					setGroupOpen(open);
					if (open) {
						setQrFailed(false);
						if (!config()) void loadConfig();
					}
				}}
				translations={{ dismiss: "关闭交流群弹窗" }}
			>
				<Dialog.Trigger class="community-nav-button">
					企微交流群<span aria-hidden="true">↗</span>
				</Dialog.Trigger>
				<Dialog.Portal>
					<Dialog.Overlay class="community-overlay" />
					<div class="community-dialog-position">
						<Dialog.Content class="community-dialog snake-app">
							<Dialog.CloseButton
								class="community-close"
								aria-label="关闭交流群弹窗"
							>
								×
							</Dialog.CloseButton>
							<span class="community-index">一起聊聊下一步</span>
							<Dialog.Title class="community-dialog-title">
								小蛇的朋友们。
							</Dialog.Title>
							<Dialog.Description class="community-muted">
								交流模型、分享观察，也欢迎新的想法。
							</Dialog.Description>
							<Show when={configError()}>
								<p class="community-error" role="alert">
									{configError()}{" "}
									<button class="text-button" onClick={() => void loadConfig()}>
										重试
									</button>
								</p>
							</Show>
							<Show
								when={config()}
								fallback={
									!configError() && <p role="status">正在加载入群信息…</p>
								}
							>
								{(cfg) => (
									<>
										<Show when={cfg().qrUrl}>
											<div class="community-qr">
												<Show
													when={!qrFailed()}
													fallback={
														<p role="alert" class="community-error">
															二维码加载失败
														</p>
													}
												>
													<img
														src={cfg().qrUrl!}
														alt="企微交流群入群二维码"
														onError={() => setQrFailed(true)}
													/>
												</Show>
											</div>
											<p class="community-note">
												使用微信或企业微信扫码，按页面提示加入。
											</p>
										</Show>
										<Show when={cfg().joinUrl}>
											<a
												class="snake-button yellow"
												href={cfg().joinUrl!}
												target="_blank"
												rel="noopener noreferrer"
											>
												打开入群链接 ↗
											</a>
										</Show>
										<Show when={!cfg().joinUrl && !cfg().qrUrl}>
											<div class="community-empty-note">交流群入口暂未配置</div>
										</Show>
									</>
								)}
							</Show>
						</Dialog.Content>
					</div>
				</Dialog.Portal>
			</Dialog>
			<Dialog
				open={keyOpen()}
				onOpenChange={openKey}
				translations={{ dismiss: "关闭贡献弹窗" }}
			>
				<Dialog.Trigger class="community-nav-button contribution-trigger">
					<span aria-hidden="true">♡</span>贡献 Key
				</Dialog.Trigger>
				<Dialog.Portal>
					<Dialog.Overlay class="community-overlay" />
					<div class="community-dialog-position">
						<Dialog.Content class="community-dialog contribution-dialog snake-app">
							<Dialog.CloseButton
								class="community-close"
								aria-label="关闭贡献弹窗"
							>
								×
							</Dialog.CloseButton>
							<span class="community-index">一份支持 · 更多探索</span>
							<Dialog.Title class="community-dialog-title">
								{mode() === "revoke"
									? "随时收回你的支持。"
									: "给小蛇添一点动力。"}
							</Dialog.Title>
							<Dialog.Description class="community-muted">
								{mode() === "revoke"
									? "输入当时贡献的 Key，即可停止后续使用。"
									: "自愿贡献模型 Key，一起让真实模型对局继续。"}
							</Dialog.Description>
							<Show when={configError()}>
								<p class="community-error" role="alert">
									{configError()}{" "}
									<button class="text-button" onClick={() => void loadConfig()}>
										重试
									</button>
								</p>
							</Show>
							<Show
								when={
									receipt()?.status === "enabled" && mode() === "contribute"
								}
								fallback={
									<>
										<Show when={revoked()}>
											<p role="status" class="community-success-note">
												贡献已撤回。已发出的请求可能仍会完成并计费，后续不再使用。
											</p>
										</Show>
										<Show when={receipt() && receipt()?.status !== "enabled"}>
											<p class="community-status" role="status">
												{receipt()?.status === "validating"
													? "正在进行真实模型验证…"
													: (receipt()?.error?.message ?? "验证尚未完成")}
											</p>
										</Show>
										<Show
											when={config()}
											fallback={
												!configError() && <p role="status">正在读取贡献配置…</p>
											}
										>
											{(cfg) => (
												<>
													<Show
														when={
															!cfg().contributionsEnabled &&
															mode() === "contribute"
														}
													>
														<p class="community-empty-note">
															Key 贡献暂未开放，感谢你的关注。
														</p>
													</Show>
													<form
														class="contribution-form"
														onSubmit={(event) => {
															event.preventDefault();
															void submit();
														}}
													>
														<fieldset disabled={pending()}>
															<legend>选择 Key 的服务商</legend>
															<div class="provider-options">
																<For each={["typesafe", "openrouter"] as const}>
																	{(value) => (
																		<label
																			classList={{
																				selected: provider() === value,
																			}}
																		>
																			<input
																				type="radio"
																				name="contribution-provider"
																				value={value}
																				checked={provider() === value}
																				onChange={() => setProvider(value)}
																			/>
																			<span>
																				{value === "typesafe"
																					? "Typesafe"
																					: "OpenRouter"}
																			</span>
																		</label>
																	)}
																</For>
															</div>
														</fieldset>
														<label for="contribution-key">
															{provider() === "typesafe"
																? "Typesafe"
																: "OpenRouter"}{" "}
															API Key
														</label>
														<input
															id="contribution-key"
															type="password"
															value={key()}
															onInput={(e) => setKey(e.currentTarget.value)}
															autocomplete="off"
															spellcheck={false}
															placeholder="粘贴你的 API Key"
															disabled={pending()}
														/>
														<Show when={mode() === "contribute"}>
															<p class="community-note">
																验证模型：{cfg().models[provider()]}
															</p>
															<label class="contribution-consent">
																<input
																	type="checkbox"
																	checked={consent()}
																	onChange={(e) =>
																		setConsent(e.currentTarget.checked)
																	}
																	disabled={pending()}
																/>
																<span>
																	我同意发起一次真实模型验证；通过后自动加入凭证池，供本站持续观战使用，可能持续消耗账户余额。
																</span>
															</label>
															<p class="community-note">
																建议使用单独创建、设置好额度的
																Key。本站不承诺固定费用；你可以随时在这里撤回。关闭弹窗不会撤回已提交的贡献。
															</p>
															<Show
																when={
																	cfg().currentProvider !== provider() ||
																	!cfg().poolEnabled
																}
															>
																<p class="community-note">
																	验证后会保存；
																	{!cfg().poolEnabled
																		? "待站点启用凭证池后使用。"
																		: "当前频道使用另一服务商，切换至该服务商后才会调度。"}
																</p>
															</Show>
														</Show>
														<Show when={error()}>
															<p class="community-error" role="alert">
																{error()}
															</p>
														</Show>
														<Show when={requestId() && mode() === "contribute"}>
															<div class="contribution-receipt">
																<button
																	type="button"
																	class="text-button"
																	onClick={() => void check()}
																	disabled={checking()}
																>
																	{checking()
																		? "正在查询…"
																		: "查询本次验证结果"}
																</button>
																<Show
																	when={
																		!pending() &&
																		receipt()?.status !== "enabled"
																	}
																>
																	<p class="community-note">
																		结果未确认时，上次调用可能已计费；再次提交会发起新的验证。
																	</p>
																</Show>
															</div>
														</Show>
														<button
															type="submit"
															class="snake-button yellow"
															disabled={
																pending() ||
																(mode() === "contribute" &&
																	(!cfg().contributionsEnabled || !consent()))
															}
														>
															{pending()
																? "正在确认…"
																: mode() === "revoke"
																	? "撤回这把 Key"
																	: "验证并贡献 Key"}
															<span aria-hidden="true">↗</span>
														</button>
													</form>
												</>
											)}
										</Show>
									</>
								}
							>
								<div
									class="contribution-thanks"
									role="status"
									aria-live="polite"
								>
									<SuccessMark animate={animate()} />
									<h3>
										谢谢你的支持，
										<br />
										让小蛇继续向前！
									</h3>
									<p>Key 已验证并加入凭证池。</p>
									<p class="community-note">
										将按服务商与轮换规则使用。已验证不代表已开始调用。
									</p>
								</div>
								<Dialog.CloseButton class="snake-button yellow">
									完成 <span aria-hidden="true">✓</span>
								</Dialog.CloseButton>
							</Show>
							<button
								type="button"
								class="text-button contribution-mode-switch"
								disabled={pending()}
								onClick={changeMode}
							>
								{mode() === "contribute" ? "撤回曾贡献的 Key" : "返回贡献 Key"}
							</button>
						</Dialog.Content>
					</div>
				</Dialog.Portal>
			</Dialog>
		</div>
	);
}
