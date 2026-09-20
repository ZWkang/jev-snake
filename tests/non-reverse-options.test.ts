import { expect, test, vi } from "vitest";
import { createState, inspectMove } from "../server/game/engine.js";
import { decisionBodyV11 } from "../server/jev/board-context.js";
import {
	askJev,
	decisionBodyV12 as decisionBody,
	sendJevRequest,
} from "../server/jev/client.js";
import { repositoryDecisionGuide } from "../shared/snake/repository-strategies.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import {
	directions,
	opposite,
	publicState,
	vectors,
	type Direction,
} from "../shared/snake/types.js";

function board(direction: Direction = "right") {
	const s = createState(
		"non-reverse",
		"test",
		null,
		{
			width: 8,
			height: 8,
			obstacleCount: 0,
			seed: "non-reverse",
			stepMode: "response",
			tickIntervalMs: null,
		},
		"now",
	);
	s.status = "running";
	s.direction = direction;
	s.snake = Array.from({ length: 4 }, (_, i) => ({
		x: 3 - vectors[direction].x * i,
		y: 3 - vectors[direction].y * i,
	}));
	s.apple = { x: 7, y: 7 };
	s.star = null;
	return s;
}

test.each(directions)(
	"historical v12 excludes only the reverse when facing %s",
	(direction) => {
		const s = publicState(board(direction));
		const r = decisionBody(s);
		expect(Object.keys(r.questions.direction.criteria)).toEqual(
			directions.filter((d) => d !== opposite[direction]),
		);
		expect(r.questions.direction.instructions).toContain(
			"Return exactly one of the offered absolute directions",
		);
		expect(r.state.strategyGuide).toBe(repositoryDecisionGuide);
		expect(r.questions.direction.instructions).not.toContain("four directions");
		expect(decisionRequestSchema.parse(r)).toEqual(r);
		const legacy = decisionBodyV11(s);
		expect(Object.keys(legacy.questions.direction.criteria)).toEqual(
			directions,
		);
		expect(decisionRequestSchema.parse(legacy)).toEqual(legacy);
	},
);

test("historical v12 does not remove wall or obstacle choices or add route judgments", () => {
	const s = board();
	s.snake = s.snake.map((p) => ({ ...p, y: 0 }));
	s.obstacles = [{ x: 3, y: 1 }];
	s.config.obstacleCount = 1;
	expect(inspectMove(s, "up").immediateCollision).toBe("wall");
	expect(inspectMove(s, "down").immediateCollision).toBe("obstacle");
	const r = decisionBody(publicState(s));
	expect(Object.keys(r.questions.direction.criteria)).toEqual([
		"up",
		"right",
		"down",
	]);
	for (const c of Object.values(r.questions.direction.criteria))
		expect(Object.keys(c!)).toEqual(["meaning"]);
	expect(r.state).not.toHaveProperty("immediateMoves");
	expect(r.state).not.toHaveProperty("localSearch");
});

function response(
	choice = "up",
	probabilities: Record<string, number> = { up: 0.6, right: 0.2, down: 0.2 },
) {
	return {
		model: "test-response",
		answers: {
			direction: { type: "choice", choice, probabilities, confidence: 0.7 },
		},
	};
}

test("keeps the three returned probabilities without inventing a fourth zero", async () => {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockResolvedValue(Response.json(response()));
	const d = await askJev("test-only", publicState(board()), { fetch });
	expect(d.choice).toBe("up");
	expect(d.probabilities).toEqual({ up: 0.6, right: 0.2, down: 0.2 });
	expect(d.probabilities).not.toHaveProperty("left");
	expect(
		JSON.parse(fetch.mock.calls[0][1]!.body as string).questions.direction
			.criteria,
	).not.toHaveProperty("left");
});

test("historical v12 transport preserves the recorded model collision choice", async () => {
	const s = board();
	s.obstacles = [{ x: 3, y: 4 }];
	s.config.obstacleCount = 1;
	expect(inspectMove(s, "down").immediateCollision).toBe("obstacle");
	expect(inspectMove(s, "up").immediateCollision).toBeNull();
	const probabilities = { up: 0.1, right: 0.1, down: 0.8 };
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockResolvedValue(Response.json(response("down", probabilities)));
	const { decision: d } = await sendJevRequest(
		"test-only",
		decisionBody(publicState(s)),
		{ fetch },
	);
	expect(d.choice).toBe("down");
	expect(d.probabilities).toEqual(probabilities);
	expect(fetch).toHaveBeenCalledOnce();
});

test.each([
	["unoffered choice", response("left")],
	[
		"extra probability",
		response("up", { up: 0.6, right: 0.2, down: 0.2, left: 0 }),
	],
	["missing probability", response("up", { up: 0.6, right: 0.4 })],
])("rejects %s without retrying or substituting", async (_, payload) => {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockResolvedValue(Response.json(payload));
	await expect(
		askJev("test-only", publicState(board()), { fetch }),
	).rejects.toThrow("Invalid JEV decision response");
	expect(fetch).toHaveBeenCalledOnce();
});
