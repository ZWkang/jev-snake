import { expect, test } from "vitest";
import {
	canInterpolateSnakeMove,
	interpolateSnakeGeometry,
	pointOnSnake,
	sliceSnakePath,
	snakeColorBands,
	snakeGeometry,
	snakeGeometryFromPoints,
} from "../src/features/snake/snakeGeometry.js";

const before = [
	{ x: 3, y: 1 },
	{ x: 2, y: 1 },
	{ x: 2, y: 2 },
];
const after = [
	{ x: 3, y: 0 },
	{ x: 3, y: 1 },
	{ x: 2, y: 1 },
];

test("moving around a bend retains both corners rather than cutting diagonally across a cell", () => {
	const middle = interpolateSnakeGeometry(before, after, 0.5);
	expect(middle.points).toEqual([
		{ x: 112, y: 32 },
		{ x: 112, y: 48 },
		{ x: 80, y: 48 },
		{ x: 80, y: 64 },
	]);
	expect(middle.length).toBe(64);
	expect(pointOnSnake(middle.points, 32)).toEqual({ x: 96, y: 48 });
	for (let i = 1; i < middle.points.length; i++) {
		const a = middle.points[i - 1],
			b = middle.points[i];
		expect(a.x === b.x || a.y === b.y).toBe(true);
	}
	expect(interpolateSnakeGeometry(before, after, 0).points).toEqual(
		snakeGeometry(before).points,
	);
	expect(interpolateSnakeGeometry(before, after, 1).points).toEqual(
		snakeGeometry(after).points,
	);
});

test("growth extends the head while leaving the tail fixed throughout the step", () => {
	const grown = [after[0], ...before];
	for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
		const shape = interpolateSnakeGeometry(before, grown, progress);
		expect(shape.tail).toEqual({ x: 80, y: 80 });
		expect(shape.length).toBe(64 + 32 * progress);
	}
	expect(interpolateSnakeGeometry(before, grown, 0).points).toEqual(
		snakeGeometry(before).points,
	);
	expect(interpolateSnakeGeometry(before, grown, 1).points).toEqual(
		snakeGeometry(grown).points,
	);
});

test("U-shaped nearby body cells remain separate legs of the ordered centerline", () => {
	const shape = snakeGeometry([
		{ x: 1, y: 1 },
		{ x: 2, y: 1 },
		{ x: 3, y: 1 },
		{ x: 3, y: 2 },
		{ x: 2, y: 2 },
		{ x: 1, y: 2 },
	]);
	expect(shape.length).toBe(160);
	expect(shape.head).toEqual({ x: 48, y: 48 });
	expect(shape.tail).toEqual({ x: 48, y: 80 });
	expect(pointOnSnake(shape.points, 80)).toEqual({ x: 112, y: 64 });
	expect(pointOnSnake(shape.points, 128)).toEqual({ x: 80, y: 80 });
});

test("slices and color bands follow the same arc and cover it without gaps", () => {
	const shape = interpolateSnakeGeometry(before, after, 0.25);
	const cut = sliceSnakePath(shape.points, 4, 60);
	expect(cut.head).toEqual(pointOnSnake(shape.points, 4));
	expect(cut.tail).toEqual(pointOnSnake(shape.points, 60));
	expect(cut.length).toBe(56);
	expect(cut.points).toContainEqual({ x: 112, y: 48 });
	expect(cut.points).toContainEqual({ x: 80, y: 48 });
	const bands = snakeColorBands(shape);
	expect(bands.map((band) => band.index)).toEqual([0, 1]);
	expect(bands.reduce((sum, band) => sum + band.length, 0)).toBe(shape.length);
	expect(bands[0].head).toEqual(shape.head);
	expect(bands.at(-1)!.tail).toEqual(shape.tail);
	for (let i = 1; i < bands.length; i++)
		expect(bands[i - 1].tail).toEqual(bands[i].head);
});

test("unchanged or discontinuous observations cannot be mistaken for a one-step movement", () => {
	expect(canInterpolateSnakeMove(before, before)).toBe(false);
	expect(canInterpolateSnakeMove(before, after)).toBe(true);
	expect(canInterpolateSnakeMove(before, [after[0], ...before])).toBe(true);
	expect(
		canInterpolateSnakeMove(before, [{ x: 4, y: 0 }, ...before.slice(0, -1)]),
	).toBe(false);
	expect(
		canInterpolateSnakeMove(before, [
			{ x: 3, y: 0 },
			{ x: 3, y: 1 },
			{ x: 2, y: 2 },
		]),
	).toBe(false);
	expect(() => interpolateSnakeGeometry(before, before, 0.5)).toThrow(
		"one continuous move",
	);
});

test("pixel geometry preserves input ordering and vertices without mutating observations", () => {
	const input = [
		{ x: 16, y: 48 },
		{ x: 16, y: 16 },
		{ x: 48, y: 16 },
	];
	const copy = structuredClone(input);
	for (const point of input) Object.freeze(point);
	Object.freeze(input);
	const shape = snakeGeometryFromPoints(input);
	expect(shape.points).toEqual(copy);
	expect(shape.head).toEqual(copy[0]);
	expect(shape.tail).toEqual(copy[2]);
	expect(sliceSnakePath(input, -20, 100).points).toEqual(copy);
	expect(sliceSnakePath(input, 32, 32).points).toEqual([{ x: 16, y: 16 }]);
	shape.points[0].x = 999;
	expect(input).toEqual(copy);
});
