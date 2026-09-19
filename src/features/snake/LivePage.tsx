import { Link, useNavigate } from "@tanstack/solid-router";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { MatchSummary } from "../../../shared/snake/types";
import { Select } from "../../components/ui/select";
import { allActiveMatches, api, type MatchList } from "./api";
import { LiveMatch } from "./LiveMatch";
import { Problem, Shell } from "./Scene";

export function LivePage(props: { matchId: string }) {
	const navigate = useNavigate();
	const [matches, setMatches] = createSignal<MatchSummary[]>([]),
		[error, setError] = createSignal("");
	let controller: AbortController | undefined;
	async function load() {
		controller?.abort();
		controller = new AbortController();
		const signal = controller.signal;
		try {
			const [list, active] = await Promise.all([
				api<MatchList>("/matches", signal),
				allActiveMatches(signal),
			]);
			if (!signal.aborted) {
				setMatches([
					...new Map(
						[...active, ...list.matches].map((m) => [m.id, m]),
					).values(),
				]);
				setError("");
			}
		} catch (e) {
			if (!signal.aborted) setError(e instanceof Error ? e.message : String(e));
		}
	}
	onMount(() => {
		void load();
		const timer = setInterval(() => void load(), 5000);
		onCleanup(() => {
			controller?.abort();
			clearInterval(timer);
		});
	});
	return (
		<Shell page="live">
			<div class="page-heading">
				<div>
					<p class="page-context">单局观战 · 跟随这场对局</p>
					<h1>看它，走出下一步。</h1>
				</div>
				<Link to="/watch" class="back-link">
					进入连续观战
				</Link>
			</div>
			<Show when={error()}>
				<Problem message={error()} retry={() => void load()} />
			</Show>
			<div class="match-picker">
				<label for="live-match">观察对局</label>
				<Select
					id="live-match"
					label="观察对局"
					value={props.matchId}
					searchable
					options={[
						{
							value: props.matchId,
							label: `${matches().find((m) => m.id === props.matchId)?.agentName ?? "当前对局"} · ${props.matchId.slice(0, 8)}`,
						},
						...matches()
							.filter((m) => m.id !== props.matchId)
							.map((m) => ({
								value: m.id,
								label: `${m.agentName} · ${m.id.slice(0, 8)} · ${m.score} 分`,
							})),
					]}
					onChange={(value) =>
						void navigate({
							to: "/watch/$matchId",
							params: { matchId: value },
						})
					}
				/>
			</div>
			<LiveMatch matchId={props.matchId} />
		</Shell>
	);
}
