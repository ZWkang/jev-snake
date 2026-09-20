/** Static playing principles, never computed conclusions about this position. */
export const snakeStrategyGuide = [
	"1. Food routes and growth: use shortest-path reasoning such as BFS or A* as a way to think about reaching food, but do not equate the shortest route with the best move. Consider body movement along the route and the grown body at arrival. If one approach would trap the head, consider other approaches or delay eating.",
	"2. Moving body and tail: occupied body cells can become free as the snake moves. The tail vacates on a non-apple move and stays on an apple move. A corridor blocked now may open later; judge whether you can keep moving until it opens instead of treating the body as permanently frozen.",
	"3. Space and escape: consider connected free regions, narrow exits and whether the head can still approach the tail after growth. A large empty area, a path to the tail or one immediate exit is only a clue, not a guarantee of safety; your own body can close the exit.",
	"4. Deliberate detours: when a direct food approach would trap you, consider following the tail or taking a longer route to let space open. Keep looking for food progress. Repeated returns to the same full position without eating indicate stagnation; survival by circling is not board completion.",
	"5. Conditional cycle strategy: on a board with a usable Hamiltonian cycle, maintaining the snake's order along that cycle can preserve movement. A shortcut must preserve body order and room for growth. Do not assume a covering cycle exists on a board with obstacles, and do not force this strategy when its conditions are absent.",
	"6. Endgame and uncertainty: as the board fills, consider the remaining empty cells and how growth changes the head-tail order. Future apples may appear in different valid cells; a continuation that wins for one favorable spawn is not guaranteed to win for every spawn. Do not invent a future food position.",
	"7. Reassess using real history: judge all four directions from the current observation and choose exactly one next move. Use committed movements and repeated visits as evidence of what actually happened. An earlier direction is not a commitment to an entire route. Not finding a route immediately does not prove impossibility, and an unexamined continuation is not proof of safety.",
].join("\n");

export const nonReverseStrategyGuide = snakeStrategyGuide.replace(
	"judge all four directions",
	"judge the three offered directions",
);

/** Tested reasoning priorities; the model still evaluates the observed board. */
export const spaceDecisionPriorities =
	"Apply these priorities in order. 1. Avoid an immediate collision. 2. Avoid a forced corridor or enclosed pocket that runs out of cells before the moving tail can open it. Trace the corridor from the candidate cell, not just the adjacent cell. 3. Prefer a connected region with continuing exits and a way to approach the moving tail; mentally account for the body shift and growth when eating. 4. Pursue A through those viable regions. Moving temporarily away from A is correct when necessary to preserve an escape route. A nearby apple does not justify losing every exit. Select exactly one offered direction.";
