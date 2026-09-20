import { describe, expect, test } from "vitest";
import type { Point } from "../shared/snake/types";
import {
	snakeGeometry,
	type SnakeGeometry,
} from "../src/features/snake/snakeGeometry";
import { motionDuration, SnakeMotion } from "../src/features/snake/snakeMotion";

const initial = [
	{ x: 2, y: 1 },
	{ x: 1, y: 1 },
	{ x: 0, y: 1 },
];
const first = [
	{ x: 3, y: 1 },
	{ x: 2, y: 1 },
	{ x: 1, y: 1 },
];
const second = [
	{ x: 3, y: 2 },
	{ x: 3, y: 1 },
	{ x: 2, y: 1 },
];
const third = [
	{ x: 2, y: 2 },
	{ x: 3, y: 2 },
	{ x: 3, y: 1 },
];
function closePoint(actual: Point, expected: Point) {
	expect(actual.x).toBeCloseTo(expected.x, 9);
	expect(actual.y).toBeCloseTo(expected.y, 9);
}
function orthogonal(frame: SnakeGeometry) {
	for (let index = 1; index < frame.points.length; index++) {
		const from = frame.points[index - 1];
		const to = frame.points[index];
		expect(from.x === to.x || from.y === to.y).toBe(true);
	}
}

describe("snake motion follows its committed movement trace", () => {
	test("starts at the observed body and eases one step without overshoot", () => {
		const motion = new SnakeMotion(initial);
		expect(motion.sample(0)).toEqual(snakeGeometry(initial));
		expect(motion.isAnimating).toBe(false);
		motion.move(initial, first, 100, 200);
		expect(motion.isAnimating).toBe(true);
		closePoint(motion.sample(100).head, { x: 80, y: 48 });
		closePoint(motion.sample(150).head, { x: 98.5, y: 48 });
		closePoint(motion.sample(150).tail, { x: 34.5, y: 48 });
		// Frame times cannot send an already-sampled tween backwards.
		closePoint(motion.sample(140).head, { x: 98.5, y: 48 });
		expect(motion.sample(300)).toEqual(snakeGeometry(first));
		expect(motion.sample(1000)).toEqual(snakeGeometry(first));
		expect(motion.isAnimating).toBe(false);
	});

	test("retargets consecutive turns from the rendered position without diagonal shortcuts", () => {
		const motion = new SnakeMotion(initial);
		motion.move(initial, first, 0, 200);
		const beforeSecond = motion.sample(50);
		motion.move(first, second, 50, 200);
		closePoint(motion.sample(50).head, beforeSecond.head);
		closePoint(motion.sample(50).tail, beforeSecond.tail);
		const beforeThird = motion.sample(75);
		motion.move(second, third, 75, 200);
		closePoint(motion.sample(75).head, beforeThird.head);
		closePoint(motion.sample(75).tail, beforeThird.tail);
		for (const now of [76, 90, 110, 150, 200, 270]) {
			const frame = motion.sample(now);
			orthogonal(frame);
			expect(frame.length).toBeCloseTo(64, 9);
		}
		expect(motion.sample(275)).toEqual(snakeGeometry(third));
		expect(motion.isAnimating).toBe(false);
	});

	test("growth leaves the tail fixed and extends the body from its actual length", () => {
		const grown = [first[0], ...initial];
		const motion = new SnakeMotion(initial);
		motion.move(initial, grown, 0, 200);
		for (const now of [0, 30, 80, 150, 200]) {
			const frame = motion.sample(now);
			closePoint(frame.tail, snakeGeometry(initial).tail);
			expect(frame.length).toBeGreaterThanOrEqual(64);
			expect(frame.length).toBeLessThanOrEqual(96);
			orthogonal(frame);
		}
		expect(motion.sample(200)).toEqual(snakeGeometry(grown));
	});

	test("growth during an unfinished move only finishes the already-owed tail movement", () => {
		const motion = new SnakeMotion(initial);
		motion.move(initial, first, 0, 200);
		const before = motion.sample(40);
		const grown = [second[0], ...first];
		motion.move(first, grown, 40, 200);
		closePoint(motion.sample(40).tail, before.tail);
		const frame = motion.sample(240);
		expect(frame).toEqual(snakeGeometry(grown));
		closePoint(frame.tail, snakeGeometry(first).tail);
	});

	test("snap cancels old movement for seeks, interruption and reduced motion", () => {
		const motion = new SnakeMotion(initial);
		motion.move(initial, first, 0, 200);
		motion.sample(50);
		motion.snap(third);
		expect(motion.isAnimating).toBe(false);
		expect(motion.sample(60)).toEqual(snakeGeometry(third));
		expect(motion.sample(1000)).toEqual(snakeGeometry(third));
	});

	test("discontinuous or mismatched snapshots land directly at the committed pose", () => {
		const motion = new SnakeMotion(initial);
		motion.move(initial, second, 0, 200);
		expect(motion.isAnimating).toBe(false);
		expect(motion.sample(100)).toEqual(snakeGeometry(second));
		motion.move(first, second, 120, 200);
		expect(motion.isAnimating).toBe(false);
		expect(motion.sample(140)).toEqual(snakeGeometry(second));
		motion.move(second, third, 200, 0);
		expect(motion.isAnimating).toBe(false);
		expect(motion.sample(201)).toEqual(snakeGeometry(third));
	});

	test("does not mutate supplied states or expose internal points through sampled geometry", () => {
		const from = Object.freeze(initial.map((p) => Object.freeze({ ...p })));
		const to = Object.freeze(first.map((p) => Object.freeze({ ...p })));
		const motion = new SnakeMotion(from);
		motion.move(from, to, 0, 200);
		const frame = motion.sample(100);
		frame.head.x = 900;
		frame.tail.y = 900;
		expect(from).toEqual(initial);
		expect(to).toEqual(first);
		expect(motion.sample(200)).toEqual(snakeGeometry(first));
	});

	test("thousands of rapid fractional-time turns keep exact orthogonal endpoints and catch up", () => {
		let body: Point[] = [
			{ x: 2, y: 0 },
			{ x: 1, y: 0 },
			{ x: 0, y: 0 },
		];
		const loop = [
			{ x: 3, y: 0 },
			{ x: 3, y: 1 },
			{ x: 3, y: 2 },
			{ x: 3, y: 3 },
			{ x: 2, y: 3 },
			{ x: 1, y: 3 },
			{ x: 0, y: 3 },
			{ x: 0, y: 2 },
			{ x: 0, y: 1 },
			{ x: 0, y: 0 },
			{ x: 1, y: 0 },
			{ x: 2, y: 0 },
		];
		const motion = new SnakeMotion(body);
		let now = 0;
		for (let step = 0; step < 1500; step++) {
			now += 13.7 + (step % 5) * 0.31;
			const before = motion.sample(now);
			const next = [{ ...loop[step % loop.length] }, ...body.slice(0, -1)];
			motion.move(body, next, now, 183.5 + (step % 3) * 7.2);
			const after = motion.sample(now);
			closePoint(after.head, before.head);
			closePoint(after.tail, before.tail);
			orthogonal(after);
			expect(after.length).toBeCloseTo(64, 8);
			orthogonal(motion.sample(now + 3.14159));
			body = next;
		}
		expect(motion.sample(now + 1000)).toEqual(snakeGeometry(body));
		expect(motion.isAnimating).toBe(false);
	});
});

describe("visual movement duration", () => {
	test("uses observed cadence within 220ms and scales only viewing speed", () => {
		expect(motionDuration({})).toBe(220);
		expect(motionDuration({ lastStepDurationMs: 200 })).toBe(160);
		expect(motionDuration({ lastStepDurationMs: 2000 })).toBe(220);
		expect(motionDuration({ lastStepDurationMs: 200 }, 2)).toBe(80);
		expect(motionDuration({ lastStepDurationMs: 200 }, 0.5)).toBe(320);
		expect(motionDuration({ lastStepDurationMs: 20 })).toBe(16);
		expect(motionDuration({ lastStepDurationMs: 0 })).toBe(220);
		expect(() => motionDuration({}, 0)).toThrow("Playback rate");
	});

	test("legacy fixed records use their recorded interval when no step duration exists", () => {
		expect(motionDuration({ config: { tickIntervalMs: 125 } })).toBe(100);
		expect(
			motionDuration({ config: { stepMode: "fixed", tickIntervalMs: 125 } }, 2),
		).toBe(50);
		expect(
			motionDuration({
				lastStepDurationMs: 200,
				config: { tickIntervalMs: 125 },
			}),
		).toBe(160);
		expect(
			motionDuration({
				config: { stepMode: "response", tickIntervalMs: null },
			}),
		).toBe(220);
		expect(motionDuration({ config: { tickIntervalMs: 1000 } })).toBe(220);
	});
});
