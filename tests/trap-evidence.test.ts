import { expect, test } from "vitest";
import { inspectMove, move } from "../server/game/engine.js";
import { decisionBodyV3 as decisionBody } from "../server/jev/analysis-context.js";
import { sendJevRequest } from "../server/jev/client.js";
import { advanceGeometry, staticSpace } from "../server/jev/context-v3.js";
import { forcedPath } from "../server/jev/context.js";
import { planBodyV3 as planBody } from "../server/jev/legacy-context.js";
import { trappedRegion } from "../server/jev/trap-evidence.js";
import {
	decisionRequestSchema,
	planRequestSchema,
} from "../shared/snake/schema.js";
import {
	type Direction,
	directions,
	planChoices,
	publicState,
} from "../shared/snake/types.js";
import {
	baseState,
	branchedTrapReplay,
	nearComplete,
} from "./context-fixture.js";

test("replay trap is proven before its branch; all three continuations really have zero exits", () => {
	const s = branchedTrapReplay();
	const before = structuredClone(s);
	const observed = publicState(s);
	expect(forcedPath(observed, "left")).toEqual({ outcome: "branch", steps: 2 });
	expect(trappedRegion(advanceGeometry(observed, "left"))).toEqual({
		regionCells: 24,
		bodyLength: 66,
		boundaryReleaseLowerBound: 38,
	});
	expect(trappedRegion(advanceGeometry(observed, "right"))).toBeNull();
	const paths: Direction[][] = [
		["left", "left", "down"],
		["left", "left", "left", "left", "down"],
		Array<Direction>(22).fill("left"),
	];
	for (const path of paths) {
		const actual = structuredClone(s);
		for (const d of path) expect(move(actual, d).type).not.toBe("gameover");
		expect(
			directions.filter(
				(d) => inspectMove(actual, d).immediateCollision === null,
			),
		).toEqual([]);
	}
	const escaped = structuredClone(s);
	for (const d of [
		"right",
		...Array<Direction>(17).fill("down"),
		...Array<Direction>(6).fill("left"),
	] as const)
		expect(move(escaped, d).type).toBe("move");
	expect(escaped.status).toBe("running");
	expect(s).toEqual(before);
});

test("small disconnected space can escape exactly when a boundary body cell vacates", () => {
	const s = baseState();
	s.config.width = 7;
	s.config.height = 5;
	s.direction = "down";
	s.snake = [
		[1, 1],
		[1, 0],
		[2, 0],
		[3, 0],
		[4, 0],
		[4, 1],
	].map(([x, y]) => ({ x, y }));
	s.obstacles = [
		[0, 1],
		[0, 2],
		[3, 1],
		[3, 2],
		[1, 3],
		[2, 3],
	].map(([x, y]) => ({ x, y }));
	s.apple = { x: 6, y: 4 };
	expect(staticSpace(publicState(s))).toMatchObject({
		staticReachableCells: 4,
		bodyLength: 6,
		tailConnection: "disconnected",
	});
	expect(trappedRegion(publicState(s))).toBeNull();
	// Four distinct pocket cells, then the old segment at (2,0) vacates
	// on move 4. A >= comparison would incorrectly reject this escape.
	for (const d of ["down", "right", "up", "up", "right", "right"] as const)
		expect(move(s, d).type).toBe("move");
	expect(s.snake[0]).toEqual({ x: 4, y: 0 });
});

test("following a moving tail remains unproven, and board completion outranks a zero-exit proof", () => {
	const s = baseState();
	s.direction = "left";
	s.snake = [
		[0, 0],
		[1, 0],
		[1, 1],
		[0, 1],
	].map(([x, y]) => ({ x, y }));
	s.obstacles = [
		[0, 2],
		[1, 2],
		[2, 0],
		[2, 1],
	].map(([x, y]) => ({ x, y }));
	const after = advanceGeometry(publicState(s), "down");
	expect(staticSpace(after).staticReachableCells).toBe(1);
	expect(trappedRegion(after)).toBeNull();
	expect(forcedPath(publicState(s), "down").outcome).toBe("cycle");
	const winning = nearComplete();
	expect(trappedRegion(publicState(winning))).toBeNull();
	expect(
		trappedRegion(advanceGeometry(publicState(winning), "right")),
	).toBeNull();
	expect(forcedPath(publicState(winning), "right")).toEqual({
		outcome: "board_complete",
		steps: 1,
	});
	expect(move(winning, "right").type).toBe("won");
});

test("known apple growth proves next-step death without predicting the respawn", () => {
	const s = branchedTrapReplay();
	for (let i = 0; i < 4; i++) move(s, "left");
	const before = structuredClone(s);
	// At (18,0), the only non-immediate-death route reaches the apple
	// after 18 moves and collides on the nineteenth attempt.
	expect(forcedPath(publicState(s), "left")).toEqual({
		outcome: "forced_collision",
		steps: 19,
	});
	for (let i = 0; i < 17; i++) move(s, "left");
	expect(forcedPath(publicState(s), "left")).toEqual({
		outcome: "forced_collision",
		steps: 2,
	});
	move(s, "left");
	expect(move(s, "down").type).toBe("gameover");
	const unchanged = structuredClone(before);
	forcedPath(publicState(before), "left");
	expect(before).toEqual(unchanged);
});

test("historical v3 modes transmit proof in their existing instructions without pruning options or fabricating unknown second moves", () => {
	const s = branchedTrapReplay();
	const single = decisionBody(publicState(s));
	expect(single.questions.direction.instructions).toContain(
		'"move":"left","regionCells":24,"bodyLength":66,"boundaryReleaseLowerBound":38',
	);
	expect(Object.keys(single.questions.direction.criteria)).toEqual(directions);
	expect(decisionRequestSchema.parse(single)).toEqual(single);
	s.config = {
		...s.config,
		stepMode: "fixed",
		tickIntervalMs: 500,
		decisionMode: "two_step_fallback",
	};
	const plan = planBody(publicState(s));
	expect(plan.questions.plan.instructions).toContain('"move":"first:left"');
	expect(plan.questions.plan.instructions).toContain(
		'"move":"second:left_left"',
	);
	expect(Object.keys(plan.questions.plan.criteria)).toEqual(planChoices);
	expect(planRequestSchema.parse(plan)).toEqual(plan);
	s.apple = { x: 21, y: 0 };
	const growth = planBody(publicState(s));
	expect(growth.questions.plan.instructions).not.toContain(
		'"move":"second:left_',
	);
	expect(growth.questions.plan.criteria.left_left.secondStatus).toBe(
		"unknown_after_growth",
	);
});

test("offline v3 transport preserves the provider choice even when it disregards proven danger", async () => {
	const s = publicState(branchedTrapReplay());
	let sent: unknown;
	const { decision } = await sendJevRequest("test-secret", decisionBody(s), {
		fetch: async (_url, init) => {
			sent = JSON.parse(init?.body as string);
			return Response.json({
				model: "test-model",
				answers: {
					direction: {
						type: "choice",
						choice: "left",
						probabilities: { up: 0.03, right: 0.4, down: 0.02, left: 0.55 },
						confidence: 0.4,
					},
				},
			});
		},
	});
	expect(decision.choice).toBe("left");
	expect(decision.probabilities.left).toBe(0.55);
	expect(decision.request).toEqual(sent);
});
