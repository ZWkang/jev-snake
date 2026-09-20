/** Source-derived reasoning procedure. These strings do not execute a planner. */
export const repositoryStrategySections = [
	{
		id: "objective",
		text: "Goal and decision order: fill every non-obstacle cell by eating successive apples, while preserving continued movement. On each observation: check immediate legality; use a valid covering cycle if its conditions hold; otherwise seek food with a viable post-growth continuation; if that fails, rearrange the body by a longer tail route; if neither route is available, make a space-preserving escape move and reassess. These are reasoning branches, not supplied routes or computed safety certificates.",
	},
	{
		id: "body_simulation",
		text: "Simulate the whole snake: start from player.bodyHeadToTail and the actual heading. For every imagined step, add the new head and remove only the old tail unless an apple is eaten; eating keeps the tail and increases length. The previous head becomes occupied neck, not a return passage. Track the ordered body after every step, including newly occupied cells. Equal head coordinates with different bodies are different situations. Only enter a body cell after it really vacates; never treat all B cells as opening together.",
	},
	{
		id: "hamiltonian_applicability",
		text: "Covering-cycle branch: use an established complete Hamiltonian cycle only when the snake's positions preserve its cyclic tail-to-body-to-head order and room for growth; body edges may be shortcuts while that order remains valid. Especially in a dense endgame, one construction is a head-to-tail path through every unoccupied traversable cell, closed by the current body back to the head. Verify coverage, obstacles, order and heading. A four-neighbor grid cycle requires equal checkerboard color counts and no degree-one traversable vertex; connectivity alone is insufficient. If no compatible complete cycle can be established, continue to the food-route branch.",
	},
	{
		id: "cycle_construction",
		text: "Cycle construction options: a serpentine tour or expanded half-size Prim maze applies only to suitable empty rectangular layouts. With obstacles, consider expanding a head-to-tail path, or edge-subset construction: remove surplus edges without dropping degree below two, use alternating-edge reflections to eliminate surplus degrees, then connect disjoint cycles while preserving degree two. Verify one connected covering cycle at the end. Warnsdorf's fewest-unvisited-neighbors heuristic orders a backtracking construction search; it is not a rule to steer the actual snake into the smallest exit count. An unfinished construction is not evidence of a valid cycle.",
	},
	{
		id: "cycle_shortcuts",
		text: "Following a cycle and taking shortcuts: measure forward wrap-around tour distances from the head, not numeric index order. Preserve cyclic tail-to-body-to-head order: do not overtake intervening body or the tail, and reserve room for growth. If food lies ahead in the free head-to-tail arc, do not jump past it; a smaller index does not by itself mean food is behind. Take a food shortcut only while all conditions remain true. In crowded states favor the next cycle edge; the reference half-full cutoff is a conservative shortcut policy, not proof of safety below it. If compatibility is lost, return to route and space checks.",
	},
	{
		id: "food_search",
		text: "Food-route branch: use BFS for unit-cost four-neighbor paths, or A* to prioritize routes toward the observed apple. Manhattan distance is a lower bound on travel, not a safety judgment. A path through a frozen body is only a candidate: simulate its complete sequence with moving body and growth. If one shortest approach fails the post-eating check, consider a different approach or a longer route. Failure to find a static path does not prove the moving-body problem impossible. Do not invent the next apple location; replan after it is observed.",
	},
	{
		id: "post_apple_check",
		text: "Post-eating check: unless eating completes the board, inspect the grown body at arrival. Confirm an onward legal move, examine a route from the new head toward the moving tail, and check whether the head is sealed into a corridor or pocket. Trace whether an exit opens before usable onward cells run out. A tail connection or one immediate exit is useful evidence, not a guarantee of indefinite survival. Prefer a food approach with a viable continuation over eating sooner and becoming trapped; do not stop the reasoning at the apple itself.",
	},
	{
		id: "flood_fill",
		text: "Flood-fill space check: from the imagined new head, repeatedly visit unvisited orthogonal neighbors inside the board that are not obstacles or occupied non-vacating body. The old H must now be treated as neck. Evaluate that connected region, not empty cells elsewhere or only the adjacent branch count. Compare usable space with the snake's length and examine narrow entrances, body-sealed cuts and tail-release timing. A small frozen region is a risk signal, not automatic proof of death, because the tail moves; a large region is not proof of safety. Preserve enough space to continue, then pursue food rather than maximize space forever.",
	},
	{
		id: "longer_tail_route",
		text: "Tail-route branch: when no food approach has a viable continuation, seek a legal route toward the tail to rearrange the body. A direct one-step chase when head and tail are adjacent can create an unchanged foodless circuit. Consider a longer tail path by replacing a path edge with a perpendicular step, the original forward step, and the opposite perpendicular step through unused side cells. Simulate every inserted step, preserve the head-tail connection and account for cells releasing in time. Do not accidentally consume an apple during this detour without repeating the growth and escape checks. A constructed longer path is not necessarily the longest possible path.",
	},
	{
		id: "escape_branch",
		text: "Last-resort escape branch: if neither a viable food route nor a viable tail route can be established, compare the non-colliding options for preserving usable room and opening a future approach. Moving farther from the food can help rearrange the body and is a last-resort tie-break, not a primary objective or a safety guarantee. Do not enter an already apparent dead end just to increase distance from food. Reassess on the next observation and switch back to food pursuit when an approach opens.",
	},
	{
		id: "history_and_rewards",
		text: "History, endgame and long-term reward: use progress.movesSinceApple, repeated positions and prior departures to recognize an approach that keeps returning without food. Change the approach or body arrangement instead of treating endless survival as completion. Judge cumulative progress: apples grow the snake, stars add points without growth, and filling the board is the goal. Necessary detours may be valuable; motion alone is not reward. No trained Q-values or hidden future food are supplied, so do not invent them. As space shrinks, recheck growth room and cycle order. Reconsider prior choices from the actual current body rather than assume an earlier direction committed you to an entire route.",
	},
	{
		id: "choose_one_move",
		text: "Final comparison: distinguish an immediate collision, an apparent forced trap, a route with a checked continuation, and a route whose consequences remain unresolved. Do not turn uncertainty into a safety claim. Choose the first move of the best supported applicable branch, balancing sustained apple progress with future movement. Return exactly one of the offered absolute directions; the next actual observation starts this procedure again.",
	},
] as const;

export const repositoryDecisionGuide = repositoryStrategySections
	.map((section, index) => `${index + 1}. ${section.text}`)
	.join("\n\n");
