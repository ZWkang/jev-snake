import type {
	LegalSpaceAnalysis,
	LegalSpaceInput,
	LegalSpaceMoveFacts,
} from "./legal-space.js";
import { inspectMove } from "./move-rules.js";
import type { Direction, Point } from "./types.js";
import { directions, vectors } from "./types.js";

export const legalSpaceSemantics =
	"Every offered move is legal for this one step under the game rules; immediate reversals, wall, obstacle and body collisions are excluded. Each option simulates that one move, including apple growth and the vacating tail. reachableFreeCells counts distinct unoccupied cells reachable from the resulting head through four-neighbor empty cells, excluding the head and all resulting body cells. Apples and stars count as free cells. freeCellsAfter is all non-obstacle cells minus the resulting snake length. canReachTail means this static region or the resulting head touches the resulting tail; it is not proof of a safe moving-body route. nextLegalMoveCount checks the very next move under the same collision and tail rules, without sampling a new apple. NO_NEXT_MOVE means exactly zero legal next moves. DEAD_END_RISK means reachableFreeCells < lengthAfter and canReachTail is false; it is a static heuristic, not proof of future death, and does not remove the option. BOARD_COMPLETE is an immediate win, so tail reachability and next moves are not applicable. appleDistance is Manhattan distance to the currently observed apple, not a path length; it is zero when eaten and null when no apple is present. No multi-step routes or future food locations are computed.";

function neighbors(point: Point, width: number, height: number): Point[] {
	return directions
		.map((direction) => ({
			x: point.x + vectors[direction].x,
			y: point.y + vectors[direction].y,
		}))
		.filter((p) => p.x >= 0 && p.y >= 0 && p.x < width && p.y < height);
}

function staticRegion(
	width: number,
	height: number,
	body: readonly Point[],
	obstacles: readonly Point[],
) {
	const index = (point: Point) => point.y * width + point.x;
	const blocked = new Uint8Array(width * height);
	for (const point of obstacles) blocked[index(point)] = 1;
	for (const point of body) blocked[index(point)] = 1;
	const region = new Uint8Array(width * height);
	const queue: Point[] = [];
	const visit = (point: Point) => {
		const key = index(point);
		if (blocked[key] || region[key]) return;
		region[key] = 1;
		queue.push(point);
	};
	for (const point of neighbors(body[0], width, height)) visit(point);
	for (let next = 0; next < queue.length; next++) {
		for (const point of neighbors(queue[next], width, height)) visit(point);
	}
	const headIndex = index(body[0]);
	const canReachTail = neighbors(body[body.length - 1], width, height).some(
		(point) => index(point) === headIndex || !!region[index(point)],
	);
	return { reachableFreeCells: queue.length, canReachTail };
}

export function analyzeLegalSpace(input: LegalSpaceInput): LegalSpaceAnalysis {
	const geometry = {
		config: { width: input.width, height: input.height },
		snake: input.bodyHeadToTail,
		direction: input.direction,
		obstacles: input.obstacles,
		apple: input.apple,
	};
	const moveFacts: LegalSpaceAnalysis["moveFacts"] = {};
	const excludedMoves: LegalSpaceAnalysis["excludedMoves"] = {};
	for (const direction of directions) {
		const inspected = inspectMove(geometry, direction);
		if (inspected.immediateCollision) {
			excludedMoves[direction] = inspected.immediateCollision;
			continue;
		}
		const { target, eatsApple } = inspected;
		const body = [
			target,
			...(eatsApple ? input.bodyHeadToTail : input.bodyHeadToTail.slice(0, -1)),
		];
		const freeCellsAfter =
			input.width * input.height - input.obstacles.length - body.length;
		const terminal = freeCellsAfter === 0 ? "board_complete" : null;
		const space = terminal
			? { reachableFreeCells: 0, canReachTail: null }
			: staticRegion(input.width, input.height, body, input.obstacles);
		const after = {
			...geometry,
			snake: body,
			direction,
			apple: eatsApple ? null : input.apple,
		};
		const turnOffset =
			(directions.indexOf(direction) -
				directions.indexOf(input.direction) +
				4) %
			4;
		moveFacts[direction] = {
			target,
			turn:
				turnOffset === 0
					? "straight"
					: turnOffset === 1
						? "right turn"
						: "left turn",
			eatsApple,
			eatsStar:
				!!input.star && target.x === input.star.x && target.y === input.star.y,
			appleDistance: input.apple
				? Math.abs(target.x - input.apple.x) +
					Math.abs(target.y - input.apple.y)
				: null,
			lengthAfter: body.length,
			freeCellsAfter,
			...space,
			nextLegalMoveCount: terminal
				? null
				: directions.filter(
						(next) => inspectMove(after, next).immediateCollision === null,
					).length,
			deadEndRisk:
				!terminal &&
				space.reachableFreeCells < body.length &&
				!space.canReachTail,
			terminal,
		};
	}
	return { moveFacts, excludedMoves };
}

export function describeLegalSpaceMove(
	direction: Direction,
	facts: LegalSpaceMoveFacts,
): string {
	const food = facts.eatsApple
		? "Eats the apple now."
		: facts.appleDistance === null
			? "No apple is currently present."
			: `Manhattan distance to the observed apple: ${facts.appleDistance} (not path length).`;
	const space = facts.terminal
		? "BOARD_COMPLETE: fills every traversable cell and wins now; no next move is needed."
		: `Static reachable free cells: ${facts.reachableFreeCells} of ${facts.freeCellsAfter} total free cells after moving. Static tail connection: ${facts.canReachTail ? "yes" : "no"}. Legal next moves: ${facts.nextLegalMoveCount}. ${facts.nextLegalMoveCount === 0 ? "NO_NEXT_MOVE: exactly zero legal moves remain after this move. " : ""}${facts.deadEndRisk ? "DEAD_END_RISK: static reachable space is smaller than the resulting snake and has no tail connection; heuristic risk, not a proof." : "Static area/tail heuristic does not flag this move; long-term safety is not guaranteed."}`;
	return `${direction} (${facts.turn}) to (${facts.target.x},${facts.target.y}). ${food}${facts.eatsStar ? " Collects the star without growth." : ""} Snake length after moving: ${facts.lengthAfter}. ${space}`;
}
