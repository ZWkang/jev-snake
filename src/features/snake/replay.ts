import type { MatchEvent } from "../../../shared/snake/types";
export function nextStep(events: MatchEvent[], index: number) {
	const tick = events[index]?.tick ?? 0;
	const next = events.findIndex((event, i) => i > index && event.tick > tick);
	return next < 0 ? events.length - 1 : next;
}
export function previousStep(events: MatchEvent[], index: number) {
	const tick = events[index]?.tick ?? 0;
	for (let i = index - 1; i >= 0; i--) if (events[i].tick < tick) return i;
	return 0;
}
export function atTime(events: MatchEvent[], milliseconds: number) {
	let lo = 0;
	let hi = events.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (events[mid].gameTimeMs <= milliseconds) lo = mid + 1;
		else hi = mid;
	}
	return Math.max(0, lo - 1);
}

export function isDecisionEvent(event: MatchEvent) {
	return (
		[
			"action_accepted",
			"action_rejected",
			"plan_accepted",
			"plan_rejected",
		].includes(event.type) && !!event.data.decision
	);
}
export function decisionForPosition(
	events: MatchEvent[],
	state: MatchEvent["state"],
) {
	const current = events.find((e) => e.seq === state.seq);
	const explicitRequest =
		current &&
		(isDecisionEvent(current) || current.type.startsWith("plan_step_"))
			? current.data.requestId
			: undefined;
	const requestId =
		explicitRequest ??
		state.lastAppliedAction?.requestId ??
		state.lastDecision?.requestId;
	const original = events.find(
		(e) =>
			e.seq <= state.seq &&
			isDecisionEvent(e) &&
			e.data.requestId === requestId,
	);
	const decision = original?.state.lastDecision;
	if (!decision) return state.lastDecision;
	const lifecycle = events
		.filter(
			(e) =>
				e.seq <= state.seq &&
				e.data.requestId === requestId &&
				Array.isArray(e.data.steps),
		)
		.at(-1);
	return lifecycle
		? {
				...decision,
				steps: lifecycle.data.steps as NonNullable<typeof decision>["steps"],
			}
		: decision;
}
export function decisionStatistics(events: MatchEvent[]) {
	const calls = new Set(
		events.filter(isDecisionEvent).map((e) => e.data.requestId),
	);
	const moves = events.filter((e) =>
		["move", "apple", "star", "gameover", "won"].includes(e.type),
	);
	return {
		requests: calls.size,
		primary: moves.filter((e) =>
			e.state.recordVersion === 2
				? e.state.lastAppliedAction?.source === "primary"
				: e.data.actionStatus === "applied",
		).length,
		fallback: moves.filter(
			(e) => e.state.lastAppliedAction?.source === "fallback",
		).length,
		coast: moves.filter((e) =>
			e.state.recordVersion === 2
				? e.state.lastAppliedAction?.source === "coast"
				: e.data.actionStatus !== "applied",
		).length,
	};
}

export function isKeyEvent(event: MatchEvent) {
	return (
		event.type !== "move" ||
		(event.data.actionSource as { source?: string } | undefined)?.source ===
			"fallback"
	);
}

// A fork retains its inherited prefix but opens at the new control boundary.
export function replayStartIndex(events: MatchEvent[]): number {
	const origin = events.at(-1)?.state.forkedFrom;
	if (!origin) return 0;
	const index = events.findIndex(
		(event) => event.type === "forked" && event.seq === origin.seq + 1,
	);
	if (index < 0) throw new Error("续跑记录缺少来源边界事件");
	return index;
}
