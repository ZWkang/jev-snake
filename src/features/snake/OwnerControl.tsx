import { createSignal, onMount, Show } from "solid-js";
import { isStagnationStopReason } from "../../../shared/snake/stagnation";
import type {
	OwnerSession,
	WatchCommand,
	WatchCommandResult,
	WatchSnapshot,
} from "../../../shared/snake/watch";
import { CommunityAdmin } from "../community/CommunityAdmin";

export function OwnerControl(props: {
	state: WatchSnapshot | undefined;
	onUpdate: (s: WatchSnapshot) => void;
}) {
	const [session, setSession] = createSignal<OwnerSession>({
		authenticated: false,
		expiresAt: null,
	});
	const [password, setPassword] = createSignal(""),
		[pending, setPending] = createSignal(false),
		[error, setError] = createSignal("");
	let unconfirmed: WatchCommand | null = null;
	async function request<T>(
		path: string,
		method = "GET",
		body?: unknown,
	): Promise<T> {
		const response = await fetch(`/api/watch-admin/${path}`, {
			method,
			credentials: "same-origin",
			headers: body ? { "Content-Type": "application/json" } : {},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		const result = await response.json();
		if (!response.ok) {
			if (response.status === 401)
				setSession({ authenticated: false, expiresAt: null });
			throw new Error(
				result.error?.message ?? `管理请求失败（${response.status}）`,
			);
		}
		return result;
	}
	async function action(work: () => Promise<unknown>) {
		setPending(true);
		setError("");
		try {
			await work();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setPending(false);
		}
	}
	onMount(
		() =>
			void action(async () =>
				setSession(await request<OwnerSession>("session")),
			),
	);
	async function login() {
		const value = password();
		setPassword("");
		await action(async () =>
			setSession(
				await request<OwnerSession>("session", "POST", { password: value }),
			),
		);
	}
	async function command(enabled: boolean, stopCurrent = false) {
		if (
			!unconfirmed ||
			unconfirmed.enabled !== enabled ||
			unconfirmed.stopCurrent !== (stopCurrent ? true : undefined)
		)
			unconfirmed = {
				requestId: crypto.randomUUID(),
				enabled,
				...(stopCurrent ? { stopCurrent: true } : {}),
			};
		const input = unconfirmed;
		await action(async () => {
			const result = await request<WatchCommandResult>(
				"commands",
				"POST",
				input,
			);
			unconfirmed = null;
			props.onUpdate(result.state);
		});
	}
	return (
		<section class="watch-owner" aria-label="管理员控制">
			<div class="section-heading">
				<h2>管理员控制</h2>
				<span class="outlined-tag lavender">
					{session().authenticated ? "已解锁" : "口令解锁"}
				</span>
			</div>
			<Show
				when={session().authenticated}
				fallback={
					<form
						class="owner-login"
						onSubmit={(e) => {
							e.preventDefault();
							void login();
						}}
					>
						<label for="watch-password">管理员口令</label>
						<input
							id="watch-password"
							type="password"
							autocomplete="current-password"
							value={password()}
							onInput={(e) => setPassword(e.currentTarget.value)}
							disabled={pending()}
						/>
						<button
							class="snake-button small"
							type="submit"
							disabled={pending() || !password()}
						>
							解锁控制
						</button>
					</form>
				}
			>
				<Show when={isStagnationStopReason(props.state?.error?.code ?? null)}>
					<p class="decision-input-note">
						费用保护已暂停本局和连续开局。点击“恢复连续观战”会开启新局并重新产生模型调用费用。
					</p>
				</Show>
				<p>
					停止连续开局后，本局会继续进行，结束后不再开启下一局。立即停止本局会马上中断当前对局，并停止连续开局。
				</p>
				<div class="owner-actions">
					<button
						class="snake-button yellow small"
						type="button"
						disabled={
							pending() ||
							!props.state ||
							(props.state.enabled && props.state.phase !== "fault")
						}
						onClick={() => void command(true)}
					>
						{props.state?.phase === "fault" ? "恢复连续观战" : "开启连续观战"}
					</button>
					<button
						class="snake-button small"
						type="button"
						disabled={pending() || !props.state?.enabled}
						onClick={() => void command(false)}
					>
						停止连续开局
					</button>
					<button
						class="snake-button small"
						type="button"
						disabled={pending() || !props.state?.currentMatchId}
						onClick={() => void command(false, true)}
					>
						立即停止本局
					</button>
					<button
						class="text-button"
						type="button"
						disabled={pending()}
						onClick={() =>
							void action(async () =>
								setSession(await request<OwnerSession>("session", "DELETE")),
							)
						}
					>
						注销管理
					</button>
				</div>
				<CommunityAdmin
					onUnauthorized={() =>
						setSession({ authenticated: false, expiresAt: null })
					}
				/>
			</Show>
			<Show when={pending()}>
				<p role="status">正在确认管理请求…</p>
			</Show>
			<Show when={error()}>
				<p class="decision-input-error" role="alert">
					{error()}
				</p>
			</Show>
		</section>
	);
}
