import { createSignal, For, onMount, Show } from "solid-js";
import type {
	Feedback,
	FeedbackPage as FeedbackResult,
} from "../../../shared/snake/community";
import { communityApi, communityErrorMessage } from "./api";
import "./community.css";

export function FeedbackPage() {
	const [body, setBody] = createSignal(""),
		[items, setItems] = createSignal<Feedback[]>([]),
		[cursor, setCursor] = createSignal<string | null>(null);
	const [loading, setLoading] = createSignal(true),
		[posting, setPosting] = createSignal(false),
		[loadError, setLoadError] = createSignal(""),
		[submitError, setSubmitError] = createSignal(""),
		[sent, setSent] = createSignal(false);
	let unconfirmed: { requestId: string; body: string } | null = null;
	async function load(more = false) {
		setLoading(true);
		setLoadError("");
		try {
			const page = await communityApi<FeedbackResult>(
				`/feedback${more && cursor() ? `?cursor=${encodeURIComponent(cursor()!)}` : ""}`,
			);
			setItems((old) =>
				more
					? [
							...old,
							...page.items.filter(
								(item) => !old.some((existing) => existing.id === item.id),
							),
						]
					: page.items,
			);
			setCursor(page.nextCursor);
		} catch (error) {
			setLoadError(communityErrorMessage(error));
		} finally {
			setLoading(false);
		}
	}
	async function submit() {
		if (posting()) return;
		const text = body().trim();
		if (!text) {
			setSubmitError("先写一点想法吧。");
			return;
		}
		if (!unconfirmed || unconfirmed.body !== text)
			unconfirmed = { requestId: crypto.randomUUID(), body: text };
		setPosting(true);
		setSubmitError("");
		setSent(false);
		try {
			await communityApi("/feedback", unconfirmed);
			unconfirmed = null;
			setBody("");
			setSent(true);
			await load();
		} catch (error) {
			setSubmitError(communityErrorMessage(error));
		} finally {
			setPosting(false);
		}
	}
	onMount(() => void load());
	return (
		<main class="snake-main community-page">
			<div class="community-page-heading">
				<div>
					<p class="community-eyebrow">一起把小蛇养得更好</p>
					<h1>
						你的一点想法，
						<br />
						<span>下一步的灵感。</span>
					</h1>
				</div>
				<div class="feedback-stamp" aria-hidden="true">
					HELLO
					<br />
					IDEAS ↗
				</div>
			</div>
			<div class="feedback-layout">
				<section class="community-card feedback-compose">
					<span class="community-index">01 / 留下想法</span>
					<h2>这里，欢迎各种声音。</h2>
					<p class="community-muted">
						看到了问题，有个建议，或者只是想打个招呼。
					</p>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void submit();
						}}
					>
						<label for="feedback-body">你的反馈</label>
						<textarea
							id="feedback-body"
							value={body()}
							onInput={(e) => {
								setBody(e.currentTarget.value);
								setSent(false);
							}}
							rows={7}
							placeholder="比如：希望能看到模型在这一局的表现总结……"
							disabled={posting()}
						/>
						<p class="community-note">
							免登录 · 提交后立即匿名公开。请不要填写个人资料或密钥。
						</p>
						<Show when={submitError()}>
							<p role="alert" class="community-error">
								{submitError()}
							</p>
						</Show>
						<Show when={sent()}>
							<p role="status" class="community-success-note">
								收到啦，你的反馈已经公开。谢谢你！
							</p>
						</Show>
						<button
							type="submit"
							class="snake-button yellow"
							disabled={posting()}
						>
							{posting() ? "正在提交…" : "匿名提交反馈"}
							<span aria-hidden="true">↗</span>
						</button>
					</form>
				</section>
				<section class="feedback-feed" aria-label="大家的反馈">
					<div class="feedback-feed-heading">
						<div>
							<span class="community-index">02 / 大家的声音</span>
							<h2>匿名，但每条都重要。</h2>
						</div>
						<button
							class="text-button"
							onClick={() => void load()}
							disabled={loading()}
						>
							刷新
						</button>
					</div>
					<Show when={loadError()}>
						<div role="alert" class="community-error">
							{loadError()}{" "}
							<button class="text-button" onClick={() => void load()}>
								重新加载
							</button>
						</div>
					</Show>
					<Show when={!loading() && !loadError() && items().length === 0}>
						<div class="feedback-empty">
							<span aria-hidden="true">↗</span>
							<h3>第一条想法，留给你。</h3>
							<p>这里还没有反馈。写下你的观察吧。</p>
						</div>
					</Show>
					<For each={items()}>
						{(item) => (
							<article class="feedback-entry">
								<div class="feedback-entry-meta">
									<span>
										<span class="anonymous-dot" aria-hidden="true" />
										匿名用户
									</span>
									<time datetime={item.createdAt}>
										{new Date(item.createdAt).toLocaleString("zh-CN", {
											month: "short",
											day: "numeric",
											hour: "2-digit",
											minute: "2-digit",
										})}
									</time>
								</div>
								<p>{item.body}</p>
							</article>
						)}
					</For>
					<Show when={loading()}>
						<p class="community-muted" role="status">
							正在读取真实反馈…
						</p>
					</Show>
					<Show when={cursor()}>
						<button
							class="snake-button small"
							disabled={loading()}
							onClick={() => void load(true)}
						>
							再看一些反馈 ↓
						</button>
					</Show>
				</section>
			</div>
		</main>
	);
}
