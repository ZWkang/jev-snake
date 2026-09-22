import { createSignal, For, onMount, Show } from "solid-js";
import type {
	AdminCredential,
	AdminFeedback,
	ContributionReceipt,
} from "../../../shared/snake/community";
import { communityApi, communityErrorMessage, CommunityHttpError } from "./api";
import "./community.css";
const statusName: Record<AdminCredential["status"], string> = {
	enabled: "已启用",
	disabled: "已停用",
	unusable: "凭证不可用",
	revoked: "已撤回",
	unconfirmed: "未确认",
};
export function CommunityAdmin(props: { onUnauthorized: () => void }) {
	const [feedback, setFeedback] = createSignal<AdminFeedback[]>([]),
		[cursor, setCursor] = createSignal<string | null>(null),
		[credentials, setCredentials] = createSignal<AdminCredential[]>([]),
		[pending, setPending] = createSignal(false),
		[error, setError] = createSignal(""),
		[notice, setNotice] = createSignal("");
	const unconfirmed = new Map<string, string>();
	const id = (intent: string) => {
		let value = unconfirmed.get(intent);
		if (!value) {
			value = crypto.randomUUID();
			unconfirmed.set(intent, value);
		}
		return value;
	};
	async function work(action: () => Promise<void>) {
		setPending(true);
		setError("");
		try {
			await action();
		} catch (error) {
			if (error instanceof CommunityHttpError && error.status === 401)
				props.onUnauthorized();
			else setError(communityErrorMessage(error));
		} finally {
			setPending(false);
		}
	}
	async function load() {
		const [feed, keys] = await Promise.all([
			communityApi<{ items: AdminFeedback[]; nextCursor: string | null }>(
				"/watch-admin/feedback",
			),
			communityApi<{ items: AdminCredential[] }>("/watch-admin/credentials"),
		]);
		setFeedback(feed.items);
		setCursor(feed.nextCursor);
		setCredentials(keys.items);
	}
	onMount(() => void work(load));
	async function visibility(item: AdminFeedback) {
		const intent = `visible:${item.id}:${!item.visible}`;
		await work(async () => {
			await communityApi(`/watch-admin/feedback/${item.id}/visibility`, {
				requestId: id(intent),
				visible: !item.visible,
			});
			unconfirmed.delete(intent);
			await load();
		});
	}
	async function command(
		item: AdminCredential,
		action: "disable" | "revalidate-and-enable",
	) {
		const intent = `key:${item.id}:${action}`;
		setNotice("");
		await work(async () => {
			const result = await communityApi<
				ContributionReceipt | { disabled: true }
			>(`/watch-admin/credentials/${item.id}/commands`, {
				requestId: id(intent),
				action,
			});
			if ("status" in result) {
				setNotice(
					result.status === "enabled"
						? "真实验证通过，Key 已启用。"
						: (result.error?.message ??
								"验证仍在进行，可再次点击查询同一请求。"),
				);
				if (result.status !== "validating") unconfirmed.delete(intent);
			} else {
				unconfirmed.delete(intent);
				setNotice("Key 已停用，后续不会再发起观战调用。");
			}
			await load();
		});
	}
	return (
		<section class="community-admin" aria-label="社区管理">
			<div class="community-admin-heading">
				<h3>社区管理</h3>
				<button
					class="text-button"
					onClick={() => void work(load)}
					disabled={pending()}
				>
					刷新记录
				</button>
			</div>
			<Show when={error()}>
				<p role="alert" class="community-error">
					{error()}
				</p>
			</Show>
			<Show when={notice()}>
				<p role="status" class="community-status">
					{notice()}
				</p>
			</Show>
			<Show when={pending()}>
				<p role="status" class="community-muted">
					正在确认管理请求…
				</p>
			</Show>
			<details>
				<summary>
					反馈管理 · {feedback().length}
					{cursor() ? "+" : ""}
				</summary>
				<div class="community-admin-list">
					<Show when={!feedback().length && !pending() && !error()}>
						<p class="community-muted">暂无反馈</p>
					</Show>
					<For each={feedback()}>
						{(item) => (
							<article class="community-admin-entry">
								<div class="community-admin-meta">
									<span>匿名用户</span>
									<span>{item.visible ? "公开" : "已隐藏"}</span>
									<time datetime={item.createdAt}>
										{new Date(item.createdAt).toLocaleString("zh-CN")}
									</time>
								</div>
								<p class="admin-feedback-body">{item.body}</p>
								<button
									class="snake-button small"
									disabled={pending()}
									onClick={() => void visibility(item)}
								>
									{item.visible ? "隐藏反馈" : "恢复公开"}
								</button>
							</article>
						)}
					</For>
					<Show when={cursor()}>
						<button
							class="text-button"
							disabled={pending()}
							onClick={() =>
								void work(async () => {
									const next = await communityApi<{
										items: AdminFeedback[];
										nextCursor: string | null;
									}>(
										`/watch-admin/feedback?cursor=${encodeURIComponent(cursor()!)}`,
									);
									setFeedback((old) => [...old, ...next.items]);
									setCursor(next.nextCursor);
								})
							}
						>
							加载更多反馈
						</button>
					</Show>
				</div>
			</details>
			<details>
				<summary>贡献 Key · {credentials().length}</summary>
				<div class="community-admin-list">
					<Show when={!credentials().length && !pending() && !error()}>
						<p class="community-muted">暂无贡献 Key</p>
					</Show>
					<For each={credentials()}>
						{(item) => (
							<article class="community-admin-entry">
								<strong>
									{item.provider === "typesafe" ? "Typesafe" : "OpenRouter"} ·{" "}
									{item.maskedKey}
								</strong>
								<div class="community-admin-meta">
									<span>{statusName[item.status]}</span>
									<span>
										{item.currentPool ? "可参与当前频道" : "未被当前频道选用"}
									</span>
									<span>{item.model}</span>
								</div>
								<div class="community-admin-meta">
									<span>验证调用 {item.validationCalls} 次</span>
									<span>观战调用 {item.watchCalls} 次</span>
									<span>已记录输入 tokens：{item.inputTokens ?? "未提供"}</span>
								</div>
								<p class="community-note">
									最近验证：
									{item.verifiedAt
										? new Date(item.verifiedAt).toLocaleString("zh-CN")
										: "未通过"}
									<br />
									最近观战调用：
									{item.lastUsedAt
										? new Date(item.lastUsedAt).toLocaleString("zh-CN")
										: "尚未调用"}
								</p>
								<Show when={item.lastError}>
									<p class="community-error">{item.lastError?.message}</p>
								</Show>
								<Show when={item.lastSwitchReason}>
									<p class="community-note">
										最近选用原因：
										{item.lastSwitchReason === "normal_round"
											? "正常局间轮换"
											: item.lastSwitchReason === "legacy_round"
												? "原局接入凭证池"
												: "原凭证已不可用，切换至此 Key"}
									</p>
								</Show>
								<div class="owner-actions">
									<button
										class="snake-button small"
										disabled={
											pending() ||
											item.status === "revoked" ||
											item.status === "disabled"
										}
										onClick={() => void command(item, "disable")}
									>
										停用
									</button>
									<button
										class="text-button"
										disabled={
											pending() || item.status === "revoked" || !item.verifiedAt
										}
										onClick={() => void command(item, "revalidate-and-enable")}
									>
										重新验证并启用（一次真实调用）
									</button>
								</div>
							</article>
						)}
					</For>
				</div>
			</details>
		</section>
	);
}
