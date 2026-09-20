import { expect, test } from "vitest";
import {
	decisionBody,
	decisionBodyV11,
	decisionBodyV12,
} from "../server/jev/client.js";
import {
	renderAsciiBoard,
	renderNamedBoard,
} from "../shared/snake/ascii-board.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import type {
	DecisionRequestV11,
	DecisionRequestV12,
	PublicState,
} from "../shared/snake/types.js";
import fixture from "./fixtures/board-v6-oom-tick275.json";

test("renders the whole observed board with distinct occupied and empty cells", () => {
	const input = {
		width: 8,
		height: 6,
		bodyHeadToTail: [3, 2, 1, 0].map((x) => ({ x, y: 1 })),
		obstacles: [{ x: 1, y: 3 }],
		apple: { x: 6, y: 4 },
		star: { x: 7, y: 5 },
	};
	const before = structuredClone(input);
	expect(renderAsciiBoard(input).map).toBe(
		[
			"y\\x 0 1 2 3 4 5 6 7",
			"  0 . . . . . . . .",
			"  1 T B B H . . . .",
			"  2 . . . . . . . .",
			"  3 . # . . . . . .",
			"  4 . . . . . . A .",
			"  5 . . . . . . . *",
		].join("\n"),
	);
	expect(input).toEqual(before);
	expect(renderAsciiBoard(input)).not.toHaveProperty("format");
});

test("two-digit coordinates stay aligned and a one-cell snake is a head", () => {
	const ascii = renderAsciiBoard({
		width: 12,
		height: 11,
		bodyHeadToTail: [{ x: 11, y: 10 }],
		obstacles: [],
		apple: null,
		star: null,
	});
	const lines = ascii.map.split("\n");
	expect(lines).toHaveLength(12);
	expect(new Set(lines.map((line) => line.length)).size).toBe(1);
	expect(lines[0].lastIndexOf("11")).toBe(lines[11].lastIndexOf("H") - 1);
	expect(lines[11].startsWith(" 10 ")).toBe(true);
	expect(ascii.map).not.toContain("T");
});

test("live requests include a faithful character map while old v11 records stay unchanged", () => {
	const request = decisionBody(fixture as PublicState);
	expect(
		request.questions.direction.instructions.startsWith(
			"This is a Snake game.",
		),
	).toBe(true);
	expect(request.state.board.ascii?.map).toContain("#");
	expect(decisionRequestSchema.parse(request)).toEqual(request);
	const old = decisionBodyV11(fixture as PublicState);
	delete old.state.board.ascii;
	expect(decisionRequestSchema.parse(old)).toEqual(old);
	expect(decisionRequestSchema.parse(old).state).not.toHaveProperty(
		"board.ascii",
	);
});

test("rejects a character diagram or legend that contradicts the coordinates", () => {
	for (const field of ["map", "legend"] as const) {
		const request = decisionBody(fixture as PublicState);
		request.state.board.ascii![field] += " modified";
		expect(decisionRequestSchema.safeParse(request).success).toBe(false);
	}
});

test("named cells put coordinates and complete cell names together without altering observations", () => {
	const input = {
		width: 4,
		height: 2,
		bodyHeadToTail: [
			{ x: 2, y: 0 },
			{ x: 1, y: 0 },
			{ x: 0, y: 0 },
		],
		obstacles: [{ x: 3, y: 0 }],
		apple: { x: 0, y: 1 },
		star: { x: 1, y: 1 },
	};
	const before = structuredClone(input);
	const result = renderNamedBoard(input);
	expect(result.format).toBe("named-cells-v2");
	expect(result.map).toBe(
		[
			"(0,0)=TAIL | (1,0)=BODY | (2,0)=HEAD | (3,0)=OBSTACLE",
			"(0,1)=APPLE | (1,1)=STAR | (2,1)=empty | (3,1)=empty",
		].join("\n"),
	);
	expect(result.legend).toContain("x increases right and y increases down");
	expect(result.legend).toContain(
		"Snake order is listed in player.bodyHeadToTail",
	);
	expect(input).toEqual(before);
});

test("named cells preserve multi-digit coordinates and the one-cell head", () => {
	const result = renderNamedBoard({
		width: 12,
		height: 11,
		bodyHeadToTail: [{ x: 11, y: 10 }],
		obstacles: [],
		apple: null,
		star: null,
	});
	const rows = result.map.split("\n");
	expect(rows).toHaveLength(11);
	for (const [y, row] of rows.entries()) {
		const entries = row.split(" | ");
		expect(entries).toHaveLength(12);
		for (const [x, entry] of entries.entries())
			expect(entry).toBe(
				`(${x},${y})=${x === 11 && y === 10 ? "HEAD" : "empty"}`,
			);
	}
	expect(result.map).not.toContain("=TAIL");
});

function diagramInput(request: DecisionRequestV11 | DecisionRequestV12) {
	return {
		width: request.state.board.width,
		height: request.state.board.height,
		obstacles: request.state.board.obstacles,
		bodyHeadToTail: request.state.player.bodyHeadToTail,
		apple: request.state.food.apple,
		star: request.state.food.star?.point ?? null,
	};
}

test("v11 and v12 validate explicit named cells and preserve unversioned historical symbol grids", () => {
	for (const build of [decisionBodyV11, decisionBodyV12]) {
		const request = build(fixture as PublicState);
		const input = diagramInput(request);
		const symbols = renderAsciiBoard(input);
		request.state.board.ascii = symbols;
		const original = JSON.stringify(request);
		expect(JSON.stringify(decisionRequestSchema.parse(request))).toBe(original);
		expect(request.state.board.ascii).not.toHaveProperty("format");
		request.state.board.ascii = { ...symbols, format: "symbol-grid-v1" };
		expect(decisionRequestSchema.parse(request)).toEqual(request);
		request.state.board.ascii = renderNamedBoard(input);
		expect(decisionRequestSchema.parse(request)).toEqual(request);
	}
});

test.each([
	"wrong coordinate",
	"wrong cell content",
	"missing named format",
	"named data labeled symbols",
	"symbol data labeled named",
	"mixed symbol legend",
	"mixed symbol map",
	"unknown format",
])("rejects %s without guessing or mixing diagram formats", (change) => {
	const request = decisionBodyV11(fixture as PublicState);
	const input = diagramInput(request);
	const named = renderNamedBoard(input);
	const symbols = renderAsciiBoard(input);
	request.state.board.ascii = { ...named };
	const ascii = request.state.board.ascii;
	if (change === "wrong coordinate")
		ascii.map = ascii.map.replace("(0,0)=", "(1,0)=");
	if (change === "wrong cell content")
		ascii.map = ascii.map.replace("=OBSTACLE", "=empty");
	if (change === "missing named format") delete ascii.format;
	if (change === "named data labeled symbols") ascii.format = "symbol-grid-v1";
	if (change === "symbol data labeled named") Object.assign(ascii, symbols);
	if (change === "mixed symbol legend") ascii.legend = symbols.legend;
	if (change === "mixed symbol map") ascii.map = symbols.map;
	if (change === "unknown format")
		Object.assign(ascii, { format: "guessed-format" });
	expect(decisionRequestSchema.safeParse(request).success).toBe(false);
});
