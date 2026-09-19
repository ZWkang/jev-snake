import { expect, test } from "vitest";
import { createState } from "../server/game/engine";
import { type MatchEvent, publicState } from "../shared/snake/types";
import { eventName } from "../src/features/snake/api";
import { replayStartIndex } from "../src/features/snake/replay";

const initial = createState(
	"fork-replay",
	"Test",
	null,
	{ width: 24, height: 18, obstacleCount: 0, tickIntervalMs: 125, seed: "a" },
	"now",
);
function event(seq: number, type: string): MatchEvent {
	return {
		matchId: initial.id,
		seq,
		tick: seq,
		gameTimeMs: seq * 125,
		createdAt: "now",
		type,
		data: {},
		state: publicState({ ...initial, seq, tick: seq, gameTimeMs: seq * 125 }),
	};
}

test("ordinary replay starts at creation", () => {
	expect(replayStartIndex([event(0, "created"), event(1, "started")])).toBe(0);
});

test("fork replay opens at its own boundary while keeping inherited earlier forks", () => {
	const rows = [
		event(0, "created"),
		event(1, "forked"),
		event(2, "move"),
		event(3, "forked"),
		event(4, "started"),
	];
	for (const row of rows)
		row.state.forkedFrom = {
			matchId: "source",
			seq: 2,
			tick: 2,
			gameTimeMs: 250,
		};
	const original = structuredClone(rows);
	expect(replayStartIndex(rows)).toBe(3);
	expect(eventName(rows[3])).toBe("从历史局面续跑");
	expect(rows).toEqual(original);
});

test("fork provenance without its boundary is an explicit replay error", () => {
	const row = event(0, "created");
	row.state.forkedFrom = { matchId: "source", seq: 0, tick: 0, gameTimeMs: 0 };
	expect(() => replayStartIndex([row])).toThrow("缺少来源边界事件");
});
