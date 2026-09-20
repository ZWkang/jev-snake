import { expect, test } from "vitest";
import { createState } from "../server/game/engine.js";
import { decisionBody } from "../server/jev/client.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import {
	publicState,
	type GameConfig,
	type MatchState,
} from "../shared/snake/types.js";
import observations from "./fixtures/ascii-refresh-c46e29da.json";

function headInMap(map: string) {
	const rows = map
		.split("\n")
		.slice(1)
		.map((line) => line.trim().split(/\s+/).slice(1));
	const y = rows.findIndex((row) => row.includes("H"));
	return { x: rows[y].indexOf("H"), y };
}

test("reported ticks 60, 61 and 62 each produce a new map for that exact observation", () => {
	const state = createState(
		"refresh-regression",
		"test",
		null,
		observations[0].config as GameConfig,
		"now",
	);
	const requests = observations.map((observed) => {
		Object.assign(state, observed, { status: "running" });
		const request = decisionBody(publicState(state));
		expect(decisionRequestSchema.parse(request)).toEqual(request);
		expect(request.state.timing.observedTick).toBe(observed.tick);
		expect(request.state.timing.targetTick).toBe(observed.tick + 1);
		expect(headInMap(request.state.board.ascii!.map)).toEqual(
			observed.snake[0],
		);
		return request;
	});
	expect(requests.map((r) => headInMap(r.state.board.ascii!.map))).toEqual([
		{ x: 6, y: 7 },
		{ x: 6, y: 6 },
		{ x: 6, y: 5 },
	]);
	expect(new Set(requests.map((r) => r.state.board.ascii!.map)).size).toBe(3);
	// Later state changes cannot overwrite an earlier HTTP request's snapshot.
	expect(requests[0].state.player.bodyHeadToTail[0]).toEqual({ x: 6, y: 7 });
	(state as MatchState).snake[0].x = 0;
	expect(headInMap(requests[2].state.board.ascii!.map)).toEqual({ x: 6, y: 5 });
});
