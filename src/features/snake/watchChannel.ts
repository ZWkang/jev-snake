import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount,
} from "solid-js";
import {
	watchSnapshotSchema,
	type WatchSnapshot,
} from "../../../shared/snake/watch";
import { api } from "./api";

export function createWatchChannel() {
	const [state, setState] = createSignal<WatchSnapshot>(),
		[phase, setPhase] = createSignal("loading"),
		[error, setError] = createSignal("");
	const [sampleAt, setSampleAt] = createSignal(0),
		[now, setNow] = createSignal(0);
	let refresh = () => {};
	function accept(value: unknown) {
		const next = watchSnapshotSchema.parse(value),
			current = state();
		if (
			current &&
			(next.revision < current.revision ||
				(next.revision === current.revision &&
					next.serverTime < current.serverTime))
		)
			return;
		setSampleAt(performance.now());
		setNow(performance.now());
		setState(next);
	}
	createEffect(() => {
		if (state()?.phase !== "countdown" || phase() !== "live") return;
		const timer = setInterval(() => setNow(performance.now()), 100);
		onCleanup(() => clearInterval(timer));
	});
	const remaining = createMemo(() => {
		const s = state();
		return s?.nextStartAt === null || !s
			? null
			: Math.max(
					0,
					Math.ceil(
						(s.nextStartAt - s.serverTime - (now() - sampleAt())) / 1000,
					),
				);
	});
	onMount(() => {
		let disposed = false,
			generation = 0,
			socket: WebSocket | undefined,
			timer: ReturnType<typeof setTimeout> | undefined,
			request: AbortController | undefined;
		async function snapshot() {
			request?.abort();
			request = new AbortController();
			const signal = request.signal;
			try {
				const s = await api<WatchSnapshot>("/watch-channel", signal);
				if (!disposed && !signal.aborted) accept(s);
			} catch (e) {
				if (!disposed && !signal.aborted) {
					setError(e instanceof Error ? e.message : String(e));
					setPhase("error");
				}
			}
		}
		function connect() {
			if (disposed) return;
			const current = ++generation;
			clearTimeout(timer);
			socket?.close();
			setPhase("syncing");
			socket = new WebSocket(
				`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/watch-channel`,
			);
			let fatal = false;
			socket.onmessage = (event) => {
				if (disposed || generation !== current) return;
				try {
					const packet = JSON.parse(event.data);
					if (packet.type !== "channel")
						throw new Error(packet.error?.message ?? "频道消息无法识别");
					accept(packet.state);
					setPhase("live");
					setError("");
				} catch (e) {
					fatal = true;
					setError(e instanceof Error ? e.message : String(e));
					setPhase("error");
					socket?.close();
				}
			};
			socket.onerror = () => {
				if (!disposed && generation === current) setPhase("reconnecting");
			};
			socket.onclose = () => {
				if (disposed || fatal || generation !== current) return;
				setPhase("reconnecting");
				timer = setTimeout(connect, 1000);
			};
		}
		refresh = () => {
			void snapshot();
			connect();
		};
		refresh();
		const visible = () => {
			if (document.visibilityState === "visible") refresh();
		};
		document.addEventListener("visibilitychange", visible);
		window.addEventListener("online", refresh);
		onCleanup(() => {
			disposed = true;
			generation++;
			request?.abort();
			clearTimeout(timer);
			socket?.close();
			document.removeEventListener("visibilitychange", visible);
			window.removeEventListener("online", refresh);
		});
	});
	return { state, phase, error, remaining, refresh: () => refresh(), accept };
}

export function channelLabel(
	s: WatchSnapshot | undefined,
	remaining: number | null,
) {
	if (!s) return "正在读取频道状态";
	return {
		stopped: "连续观战已停止",
		starting: "正在准备下一局",
		running: "对局进行中",
		draining: "本局结束后停止",
		countdown:
			remaining === 0
				? "正在准备下一局"
				: `下一局将在 ${remaining ?? "—"} 秒后开始`,
		fault: "连续观战已中断",
	}[s.phase];
}
