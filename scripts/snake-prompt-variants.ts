import type { DecisionRequestV12 } from "../shared/snake/types.js";

// Offline experiments only. Keep the observed state and offered actions intact.
export function snakePromptVariants(request: DecisionRequestV12) {
	const ascii = request.state.board.ascii;
	if (!ascii) throw new Error("The prompt experiment requires a character map");
	const introduction =
		"This is a Snake game. Choose the next absolute direction.\n\nCurrent board:\n" +
		ascii.map +
		"\n\nLegend: " +
		ascii.legend +
		"\n\nColumns are x and rows are y. Row labels, column labels and spaces are not cells. Directions do not rotate with the snake's heading. A move advances exactly one cell.\n\n" +
		"Crossing the boundary or entering # or B ends the game immediately. T vacates when the move does not eat an apple; it stays when the snake grows by eating A. An offered direction is not necessarily free of collisions.\n\n";
	const priority =
		"Any move that survives this step must rank above a move that ends the game immediately. Among moves that survive, choose the one that best supports collecting apples and eventually filling every traversable cell. Use the current board and game rules. Select exactly one offered direction.";
	const instructions = {
		baseline: request.questions.direction.instructions,
		short_priority: introduction + priority,
		adjacent_symbols:
			introduction +
			"Locate H. Read the cells directly adjacent to H: left and right are the neighboring symbols in the same row; up and down are the symbols in the same column of the neighboring rows. Only these adjacent cells are destinations for this move. Food beyond an adjacent blocking cell cannot be reached by this move.\n\n" +
			priority,
		coordinate_lookup:
			introduction +
			"The first entry of player.bodyHeadToTail is the current head. For each offered direction, its destination is one coordinate away from that head: up changes y by -1, down by +1, left changes x by -1, and right by +1. Compare that destination with the board boundaries, board.obstacles and the occupied body cells, applying the tail rule. The character map depicts these same coordinates.\n\n" +
			priority,
	};
	return Object.entries(instructions).map(([name, text]) => {
		const candidate = structuredClone(request);
		candidate.questions.direction.instructions = text;
		return { name, request: candidate };
	});
}
