import type { Point } from "./types.js";

export type AsciiBoard = {
	format?: "symbol-grid-v1" | "named-cells-v2";
	legend: string;
	map: string;
};
export type AsciiBoardInput = {
	width: number;
	height: number;
	obstacles: readonly Point[];
	bodyHeadToTail: readonly Point[];
	apple: Point | null;
	star: Point | null;
};

/** Render occupied cells only. No move evaluation, path finding or projection. */
export function renderAsciiBoard(input: AsciiBoardInput): AsciiBoard {
	const cells = Array.from({ length: input.height }, () =>
		Array<string>(input.width).fill("."),
	);
	const mark = (point: Point, symbol: string) => {
		cells[point.y][point.x] = symbol;
	};
	for (const point of input.obstacles) mark(point, "#");
	if (input.apple) mark(input.apple, "A");
	if (input.star) mark(input.star, "*");
	for (let index = input.bodyHeadToTail.length - 1; index >= 0; index--)
		mark(
			input.bodyHeadToTail[index],
			index === 0 ? "H" : index === input.bodyHeadToTail.length - 1 ? "T" : "B",
		);
	const rowWidth = Math.max(3, String(input.height - 1).length);
	const cellWidth = String(input.width - 1).length;
	const header =
		"y\\x".padStart(rowWidth) +
		" " +
		Array.from({ length: input.width }, (_, x) =>
			String(x).padStart(cellWidth),
		).join(" ");
	return {
		legend:
			"Columns are x (rightward), rows are y (downward), both zero-based. # = obstacle; . = empty; H = snake head; B = snake body; T = snake tail; A = apple; * = star. Snake order is listed in player.bodyHeadToTail.",
		map: [
			header,
			...cells.map(
				(row, y) =>
					String(y).padStart(rowWidth) +
					" " +
					row.map((cell) => cell.padStart(cellWidth)).join(" "),
			),
		].join("\n"),
	};
}

/** Label every observed cell directly; no action consequences are computed. */
export function renderNamedBoard(
	input: AsciiBoardInput,
): AsciiBoard & { format: "named-cells-v2" } {
	const cells = Array.from({ length: input.height }, () =>
		Array<string>(input.width).fill("empty"),
	);
	const mark = (point: Point, name: string) => {
		cells[point.y][point.x] = name;
	};
	for (const point of input.obstacles) mark(point, "OBSTACLE");
	if (input.apple) mark(input.apple, "APPLE");
	if (input.star) mark(input.star, "STAR");
	for (let index = input.bodyHeadToTail.length - 1; index >= 0; index--)
		mark(
			input.bodyHeadToTail[index],
			index === 0
				? "HEAD"
				: index === input.bodyHeadToTail.length - 1
					? "TAIL"
					: "BODY",
		);
	return {
		format: "named-cells-v2",
		legend:
			"Each entry is (x,y)=cell content. Coordinates are zero-based: x increases right and y increases down. Rows are listed in increasing y, with cells in increasing x. empty = empty cell; HEAD = snake head; BODY = snake body; TAIL = snake tail; APPLE = apple; STAR = star; OBSTACLE = obstacle. Snake order is listed in player.bodyHeadToTail.",
		map: cells
			.map((row, y) => row.map((name, x) => `(${x},${y})=${name}`).join(" | "))
			.join("\n"),
	};
}
