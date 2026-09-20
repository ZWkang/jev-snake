import { expect, test } from "vitest";
import { createState, inspectMove } from "../server/game/engine.js";
import { decisionBodyV6 } from "../server/jev/board-context.js";
import { immediateMoves } from "../server/jev/immediate-moves.js";
import { ProgressHistory } from "../server/jev/progress.js";
import { decisionBodyV7 as decisionBody } from "../server/jev/search-context.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import {
	directions,
	publicState,
	type PublicState,
} from "../shared/snake/types.js";
import fixtures from "./fixtures/jev-local-move-failures.json";

function board() {
	const state = createState(
		"local",
		"test",
		null,
		{
			width: 7,
			height: 4,
			obstacleCount: 0,
			seed: "local-facts",
			stepMode: "response",
			tickIntervalMs: null,
		},
		"now",
	);
	state.snake = [
		{ x: 1, y: 1 },
		{ x: 2, y: 1 },
		{ x: 2, y: 2 },
		{ x: 1, y: 2 },
	];
	state.direction = "left";
	state.obstacles = [{ x: 0, y: 1 }];
	state.apple = { x: 4, y: 1 };
	state.star = { point: { x: 1, y: 0 }, expiresAt: 8000 };
	return publicState(state);
}

test("one-step facts distinguish obstacles, reversals, stars and a vacating tail", () => {
	const state = board();
	const before = structuredClone(state);
	const moves = immediateMoves(state);
	expect(moves.up).toMatchObject({
		legal: true,
		destination: "star",
		blockedBy: "none",
	});
	expect(moves.right).toMatchObject({
		legal: false,
		destination: "snake_body",
		blockedBy: "reverse",
		appleProgress: "not_applicable",
	});
	expect(moves.down).toMatchObject({
		legal: true,
		destination: "vacating_tail",
		blockedBy: "none",
	});
	expect(moves.left).toMatchObject({
		legal: false,
		destination: "obstacle",
		blockedBy: "obstacle",
	});
	expect(state).toEqual(before);
	state.apple = { ...state.snake.at(-1)! };
	expect(immediateMoves(state).down).toMatchObject({
		legal: false,
		destination: "snake_body",
		blockedBy: "body",
	});
});

test("walls, immediate apples and numeric distance changes are stated literally", () => {
	const state = board();
	state.obstacles = [];
	state.star = null;
	state.apple = { x: 0, y: 1 };
	expect(immediateMoves(state).left).toMatchObject({
		destination: "apple",
		appleProgress: "eats_now",
		legal: true,
	});
	state.apple = { x: 1, y: 3 };
	expect(immediateMoves(state).down.appleProgress).toBe("closer");
	expect(immediateMoves(state).up.appleProgress).toBe("farther");
	state.snake = [
		{ x: 0, y: 0 },
		{ x: 1, y: 0 },
		{ x: 2, y: 0 },
		{ x: 3, y: 0 },
	];
	expect(immediateMoves(state).up).toMatchObject({
		target: { x: 0, y: -1 },
		legal: false,
		blockedBy: "wall",
		destination: "outside_board",
	});
	state.apple = null;
	expect(immediateMoves(state).down.appleProgress).toBe("no_apple");
});

test.each(fixtures)(
	"real failed decision $source.matchId has an explicitly blocked candidate",
	(sample) => {
		const state = sample.state as PublicState;
		const request = decisionBody(state);
		const choice = sample.source.choice as (typeof directions)[number];
		expect(request.state.immediateMoves[choice]).toMatchObject({
			legal: false,
			blockedBy: choice === "left" ? "reverse" : "obstacle",
			appleProgress: "not_applicable",
		});
		for (const d of directions) {
			const actual = inspectMove(state, d);
			expect(request.state.immediateMoves[d].target).toEqual(actual.target);
			expect(request.state.immediateMoves[d].legal).toBe(
				actual.immediateCollision === null,
			);
		}
		expect(Object.keys(request.questions.direction.criteria)).toEqual(
			directions,
		);
		expect(decisionRequestSchema.parse(request)).toEqual(request);
		expect(
			decisionRequestSchema.parse(decisionBodyV6(state)).state.contextVersion,
		).toBe("board-state-v6");
	},
);

test("departure labels describe recorded history without selecting an action", () => {
	const state = board();
	const history = new ProgressHistory();
	history.observe(state);
	const progress = history.snapshot(state);
	expect(immediateMoves(state).up.departureHistory).toBe("not_recorded");
	expect(immediateMoves(state, progress).up.departureHistory).toBe(
		"not_taken_here",
	);
	progress.actions.up = {
		timesTaken: 1,
		returnsWithoutApple: 0,
		lastTakenTick: 1,
	};
	expect(immediateMoves(state, progress).up.departureHistory).toBe(
		"taken_without_recorded_return",
	);
	progress.actions.up.returnsWithoutApple = 1;
	expect(immediateMoves(state, progress).up.departureHistory).toBe(
		"returned_without_apple",
	);
	expect(immediateMoves(state, progress).up.legal).toBe(true);
});
