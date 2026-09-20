import type { AsciiBoardInput } from "./ascii-board.js";
import { vectors, type Direction, type Point } from "./types.js";

/** Read current neighboring cells only; no move simulation or safety judgment. */
export function renderNeighborCells(
	input: AsciiBoardInput,
	offered: readonly Direction[],
): string {
	const head = input.bodyHeadToTail[0];
	if (!head) throw new Error("A neighboring-cell observation requires a head");
	return offered
		.map((direction) => {
			const x = head.x + vectors[direction].x;
			const y = head.y + vectors[direction].y;
			const at = (point: Point) => point.x === x && point.y === y;
			const bodyIndex = input.bodyHeadToTail.findIndex(at);
			const symbol =
				x < 0 || y < 0 || x >= input.width || y >= input.height
					? "outside board"
					: bodyIndex === 0
						? "H"
						: bodyIndex === input.bodyHeadToTail.length - 1
							? "T"
							: bodyIndex >= 0
								? "B"
								: input.obstacles.some(at)
									? "#"
									: input.apple && at(input.apple)
										? "A"
										: input.star && at(input.star)
											? "*"
											: ".";
			return `${direction}: observed cell (${x},${y}) = ${symbol}`;
		})
		.join("\n");
}
