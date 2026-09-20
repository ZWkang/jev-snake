import { expect, test } from "vitest";
import {
	type AsciiBoardInput,
	renderAsciiBoard,
} from "../shared/snake/ascii-board.js";
import { renderNeighborCells } from "../shared/snake/neighbor-cells.js";

test("copies the observed obstacle, apple, body and tail for each absolute direction", () => {
	const input: AsciiBoardInput = {
		width: 5,
		height: 5,
		bodyHeadToTail: [
			{ x: 2, y: 2 },
			{ x: 2, y: 3 },
			{ x: 3, y: 3 },
			{ x: 3, y: 2 },
		],
		obstacles: [{ x: 2, y: 1 }],
		apple: { x: 1, y: 2 },
		star: null,
	};
	const before = structuredClone(input);
	for (const point of [...input.bodyHeadToTail, ...input.obstacles])
		Object.freeze(point);
	Object.freeze(input.bodyHeadToTail);
	Object.freeze(input.obstacles);
	Object.freeze(input.apple);
	Object.freeze(input);
	expect(renderNeighborCells(input, ["up", "right", "down", "left"])).toBe(
		[
			"up: observed cell (2,1) = #",
			"right: observed cell (3,2) = T",
			"down: observed cell (2,3) = B",
			"left: observed cell (1,2) = A",
		].join("\n"),
	);
	// Preserve even blocked options, and report the tail as observed rather than
	// predicting whether it will move. Neither the observations nor order change.
	expect(renderNeighborCells(input, ["left", "up", "right"])).toBe(
		[
			"left: observed cell (1,2) = A",
			"up: observed cell (2,1) = #",
			"right: observed cell (3,2) = T",
		].join("\n"),
	);
	expect(input).toEqual(before);
});

test("a one-cell snake is H and has no separate tail; stars and empty cells remain observations", () => {
	const input: AsciiBoardInput = {
		width: 13,
		height: 12,
		bodyHeadToTail: [{ x: 11, y: 10 }],
		obstacles: [],
		apple: null,
		star: { x: 10, y: 10 },
	};
	expect(renderAsciiBoard(input).map).toContain("H");
	expect(renderAsciiBoard(input).map).not.toContain("T");
	expect(renderNeighborCells(input, ["left", "up", "right", "down"])).toBe(
		[
			"left: observed cell (10,10) = *",
			"up: observed cell (11,9) = .",
			"right: observed cell (12,10) = .",
			"down: observed cell (11,11) = .",
		].join("\n"),
	);
});

test.each([
	{
		head: { x: 0, y: 0 },
		expected: [
			"up: observed cell (0,-1) = outside board",
			"right: observed cell (1,0) = .",
			"down: observed cell (0,1) = .",
			"left: observed cell (-1,0) = outside board",
		],
	},
	{
		head: { x: 2, y: 1 },
		expected: [
			"up: observed cell (2,0) = .",
			"right: observed cell (3,1) = outside board",
			"down: observed cell (2,2) = outside board",
			"left: observed cell (1,1) = .",
		],
	},
])("reports all four boundaries from head $head", ({ head, expected }) => {
	expect(
		renderNeighborCells(
			{
				width: 3,
				height: 2,
				bodyHeadToTail: [head],
				obstacles: [],
				apple: null,
				star: null,
			},
			["up", "right", "down", "left"],
		),
	).toBe(expected.join("\n"));
});
