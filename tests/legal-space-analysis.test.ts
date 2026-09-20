import { expect, test } from "vitest";
import {
	createState,
	inspectMove as engineInspectMove,
	move,
} from "../server/game/engine.js";
import {
	analyzeLegalSpace,
	describeLegalSpaceMove,
	legalSpaceSemantics,
} from "../shared/snake/legal-space-analysis.js";
import type { LegalSpaceInput } from "../shared/snake/legal-space.js";
import { inspectMove } from "../shared/snake/move-rules.js";
import { directions, type MatchState } from "../shared/snake/types.js";
import down51 from "./fixtures/legal-space-down51.json";

function board(overrides: Partial<LegalSpaceInput> = {}): LegalSpaceInput {
	return {
		width: 7,
		height: 5,
		bodyHeadToTail: [
			{ x: 2, y: 2 },
			{ x: 1, y: 2 },
			{ x: 0, y: 2 },
		],
		direction: "right",
		obstacles: [],
		apple: { x: 6, y: 4 },
		star: null,
		...overrides,
	};
}

function stateFor(input: LegalSpaceInput): MatchState {
	const state = createState(
		"legal-space",
		"test",
		null,
		{
			width: 8,
			height: 8,
			obstacleCount: 0,
			seed: "legal-space-test",
			stepMode: "response",
			tickIntervalMs: null,
		},
		"now",
	);
	state.config = {
		...state.config,
		width: input.width,
		height: input.height,
		obstacleCount: input.obstacles.length,
	};
	state.snake = structuredClone([...input.bodyHeadToTail]);
	state.direction = input.direction;
	state.obstacles = structuredClone([...input.obstacles]);
	state.apple = structuredClone(input.apple);
	state.star = input.star
		? { point: { ...input.star }, expiresAt: 8000 }
		: null;
	state.status = "running";
	return state;
}

test("the real down-51-percent failure is retained with exact zero-exit and heuristic warnings", () => {
	const result = analyzeLegalSpace(down51.input as LegalSpaceInput);
	expect(Object.keys(result.moveFacts)).toEqual(["up", "down"]);
	expect(result.excludedMoves).toEqual({ right: "reverse", left: "wall" });
	expect(result.moveFacts.down).toEqual({
		target: { x: 0, y: 2 },
		turn: "left turn",
		eatsApple: false,
		eatsStar: false,
		appleDistance: 5,
		lengthAfter: 30,
		freeCellsAfter: 33,
		reachableFreeCells: 0,
		canReachTail: false,
		nextLegalMoveCount: 0,
		deadEndRisk: true,
		terminal: null,
	});
	expect(result.moveFacts.up).toMatchObject({
		reachableFreeCells: 19,
		canReachTail: true,
		nextLegalMoveCount: 1,
		deadEndRisk: false,
	});
	const meaning = describeLegalSpaceMove("down", result.moveFacts.down!);
	expect(meaning).toContain("NO_NEXT_MOVE: exactly zero legal moves");
	expect(meaning).toContain("DEAD_END_RISK:");
	expect(meaning).toContain("heuristic risk, not a proof");
	expect(meaning).toContain("not path length");
});

test("the engine exposes the canonical shared rule and excludes only immediate collisions", () => {
	expect(engineInspectMove).toBe(inspectMove);
	const input = board({
		width: 3,
		height: 3,
		bodyHeadToTail: [
			{ x: 0, y: 1 },
			{ x: 0, y: 2 },
			{ x: 1, y: 2 },
		],
		direction: "up",
		obstacles: [{ x: 1, y: 1 }],
		apple: { x: 2, y: 0 },
	});
	const result = analyzeLegalSpace(input);
	expect(Object.keys(result.moveFacts)).toEqual(["up"]);
	expect(result.excludedMoves).toEqual({
		right: "obstacle",
		down: "reverse",
		left: "wall",
	});
	const surrounded = board({
		bodyHeadToTail: [
			{ x: 1, y: 1 },
			{ x: 1, y: 2 },
			{ x: 0, y: 2 },
			{ x: 0, y: 1 },
			{ x: 0, y: 0 },
			{ x: 1, y: 0 },
			{ x: 2, y: 0 },
		],
		direction: "up",
		obstacles: [{ x: 2, y: 1 }],
	});
	expect(analyzeLegalSpace(surrounded)).toEqual({
		moveFacts: {},
		excludedMoves: {
			up: "body",
			right: "obstacle",
			down: "reverse",
			left: "body",
		},
	});
});

test("entering a vacating tail is legal, but an apple keeps the tail occupied", () => {
	const input = board({
		bodyHeadToTail: [
			{ x: 1, y: 1 },
			{ x: 2, y: 1 },
			{ x: 2, y: 2 },
			{ x: 1, y: 2 },
		],
		direction: "left",
	});
	expect(analyzeLegalSpace(input).moveFacts.down).toMatchObject({
		target: { x: 1, y: 2 },
		lengthAfter: 4,
		eatsApple: false,
	});
	// This artificial overlap isolates the same growth/tail rule used by the engine.
	input.apple = { x: 1, y: 2 };
	expect(analyzeLegalSpace(input).excludedMoves.down).toBe("body");
});

test("growth, stars, obstacles and total free area are literal one-step facts", () => {
	const input = board({
		apple: { x: 3, y: 2 },
		star: { x: 2, y: 1 },
		obstacles: [
			{ x: 4, y: 3 },
			{ x: 5, y: 3 },
		],
	});
	const result = analyzeLegalSpace(input);
	expect(Object.keys(result.moveFacts)).toEqual(["up", "right", "down"]);
	expect(result.moveFacts.right).toMatchObject({
		eatsApple: true,
		eatsStar: false,
		appleDistance: 0,
		lengthAfter: 4,
		freeCellsAfter: 29,
		reachableFreeCells: 29,
	});
	expect(result.moveFacts.up).toMatchObject({
		eatsStar: true,
		eatsApple: false,
		appleDistance: 2,
		lengthAfter: 3,
		freeCellsAfter: 30,
		reachableFreeCells: 30,
	});
	expect(describeLegalSpaceMove("up", result.moveFacts.up!)).toContain(
		"Collects the star without growth",
	);
	expect(
		analyzeLegalSpace({ ...input, apple: null }).moveFacts.right!.appleDistance,
	).toBeNull();
});

test("filling the traversable board is a win rather than a no-exit warning", () => {
	const input = board({
		width: 2,
		height: 3,
		bodyHeadToTail: [
			{ x: 0, y: 1 },
			{ x: 1, y: 1 },
			{ x: 1, y: 2 },
			{ x: 0, y: 2 },
		],
		direction: "left",
		obstacles: [{ x: 1, y: 0 }],
		apple: { x: 0, y: 0 },
	});
	const facts = analyzeLegalSpace(input).moveFacts.up!;
	expect(facts).toMatchObject({
		terminal: "board_complete",
		eatsApple: true,
		lengthAfter: 5,
		freeCellsAfter: 0,
		reachableFreeCells: 0,
		canReachTail: null,
		nextLegalMoveCount: null,
		deadEndRisk: false,
	});
	const state = stateFor(input);
	expect(move(state, "up").type).toBe("won");
	expect(state.endReason).toBe("board_complete");
	const meaning = describeLegalSpaceMove("up", facts);
	expect(meaning).toContain("BOARD_COMPLETE:");
	expect(meaning).not.toContain("NO_NEXT_MOVE:");
	expect(meaning).not.toContain("DEAD_END_RISK:");
});

test("static tail contact is not a moving-body route or a guarantee of safety", () => {
	const input = board({
		width: 2,
		height: 3,
		bodyHeadToTail: [
			{ x: 0, y: 1 },
			{ x: 1, y: 1 },
			{ x: 1, y: 0 },
			{ x: 0, y: 0 },
		],
		direction: "left",
		apple: { x: 1, y: 2 },
	});
	const facts = analyzeLegalSpace(input).moveFacts.up!;
	// New head touches the new tail, although all currently free cells are elsewhere.
	expect(facts).toMatchObject({
		reachableFreeCells: 0,
		canReachTail: true,
		nextLegalMoveCount: 1,
		deadEndRisk: false,
	});
	expect(legalSpaceSemantics).toContain(
		"not proof of a safe moving-body route",
	);
});

test.each([
	board(),
	board({ apple: { x: 3, y: 2 }, star: { x: 2, y: 1 } }),
	down51.input as LegalSpaceInput,
])(
	"each offered move and next legal count agrees with a real engine step",
	(input) => {
		const analysis = analyzeLegalSpace(input);
		const before = stateFor(input);
		for (const direction of directions) {
			const expected = inspectMove(before, direction);
			if (expected.immediateCollision) {
				expect(analysis.excludedMoves[direction]).toBe(
					expected.immediateCollision,
				);
				continue;
			}
			const after = structuredClone(before);
			move(after, direction);
			const facts = analysis.moveFacts[direction]!;
			expect(facts.target).toEqual(after.snake[0]);
			expect(facts.lengthAfter).toBe(after.snake.length);
			expect(facts.freeCellsAfter).toBe(
				input.width * input.height -
					after.obstacles.length -
					after.snake.length,
			);
			if (after.status !== "won") {
				expect(facts.nextLegalMoveCount).toBe(
					directions.filter(
						(next) => inspectMove(after, next).immediateCollision === null,
					).length,
				);
			}
		}
	},
);

test("analysis never mutates frozen observation data or exposes mutable input points", () => {
	const input = board();
	const before = structuredClone(input);
	for (const point of [
		...input.bodyHeadToTail,
		...input.obstacles,
		input.apple!,
	])
		Object.freeze(point);
	Object.freeze(input.bodyHeadToTail);
	Object.freeze(input.obstacles);
	Object.freeze(input);
	const result = analyzeLegalSpace(input);
	result.moveFacts.up!.target.x = 123;
	expect(input).toEqual(before);
	expect(analyzeLegalSpace(input).moveFacts.up!.target.x).toBe(2);
});

test("larger boards enumerate cells once per option without future-state expansion", () => {
	for (const [width, height] of [
		[64, 48],
		[128, 96],
	]) {
		const input = board({ width, height });
		const result = analyzeLegalSpace(input);
		expect(Object.keys(result.moveFacts)).toEqual(["up", "right", "down"]);
		for (const facts of Object.values(result.moveFacts)) {
			expect(facts.freeCellsAfter).toBe(width * height - 3);
			expect(facts.reachableFreeCells).toBe(width * height - 3);
			expect(facts.nextLegalMoveCount).toBe(3);
		}
	}
});
