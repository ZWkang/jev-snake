import {
	vectors,
	type DecisionRequestV12,
	type Direction,
} from "../shared/snake/types.js";
import { snakePromptVariants } from "./snake-prompt-variants.js";

// Only instructions vary; observed facts, history and offered directions stay fixed.
export function applePromptVariants(request: DecisionRequestV12) {
	const baseline = snakePromptVariants(request).find(
		(variant) => variant.name === "adjacent_symbols",
	)!.request.questions.direction.instructions;
	const goal =
		"This is a Snake game. Your task is to eat the current apple A, then keep eating newly spawned apples until the snake fills every traversable cell. Staying alive while circling without eating does not accomplish this task. Choose the next absolute direction.";
	const priority =
		"Any move that survives this step must rank above a move that ends the game immediately. Among moves that survive, choose the one that best supports collecting apples and eventually filling every traversable cell. Use the current board and game rules. Select exactly one offered direction.";
	const pursuit =
		"Avoid immediate collisions, then actively pursue the CURRENT apple. Choose the next step of a route that reaches A; do not keep taking empty detours merely to stay alive. If an adjacent apple can be eaten without a collision or trapping the grown snake, eat it. A necessary detour must help reach the apple or open a blocked approach. Repeated movement without eating is stagnation, not progress. Select exactly one offered direction.";
	const objective = baseline
		.replace("This is a Snake game. Choose the next absolute direction.", goal)
		.replace(priority, pursuit);
	const head = request.state.player.bodyHeadToTail[0];
	const apple = request.state.food.apple;
	const progress = request.state.progress;
	const observations = [
		`Current observed head: (${head.x},${head.y}).`,
		...(apple ? [`Current apple A: (${apple.x},${apple.y}).`] : []),
		...(progress
			? [
					`Observed tick: ${progress.throughTick}; last apple eaten at tick ${progress.lastAppleTick}; moves since that apple: ${progress.movesSinceApple}.`,
				]
			: []),
	].join(" ");
	const history = objective.replace(
		"\n\nCurrent board:",
		`\n\n${observations} Read progress as actual movement history. If previous movement has not produced another apple, reconsider the approach instead of repeating it.\n\nCurrent board:`,
	);
	const route = history.replace(
		pursuit,
		"Use your own reasoning to find a sequence of legal moves from H to the current A, accounting for moving body cells and apple growth. Choose its first step now and reassess after the actual move. If a short, unblocked route reaches A without trapping the snake, take that route instead of following a long empty circuit. Move away from A only when needed to go around an obstacle or body, release space, or avoid a trap. Never move into an immediate collision. Repeated movement without an apple means the approach needs to change. Select exactly one offered direction.",
	);
	const balanced = baseline.replace(
		priority,
		"Any move that survives this step must rank above a move that ends the game immediately. Among the non-colliding options, choose a first step toward reaching the current apple A. Keep making progress until you eat it, then pursue the newly observed apple. Survival by repeating an empty circuit does not achieve the goal. Use progress.movesSinceApple and progress.actions as evidence of unsuccessful movement and change an approach that keeps returning without an apple. Select exactly one offered direction.",
	);
	const detour = baseline.replace(
		priority,
		"Any move that survives this step must rank above a move that ends the game immediately. A is your destination: reach and eat the current apple, then pursue the next one. Moving closer to A is useless if the next cell is blocked. When an obstacle or body blocks a direct approach, choose an unblocked first step around it, including a perpendicular step, instead of entering the blocking cell or endlessly circling elsewhere. Among non-colliding moves, prefer a route that actually reaches A. Use progress to reconsider movement that has produced no apple. Select exactly one offered direction.",
	);
	const patterns = detour.replace(
		"\n\nCurrent board:",
		'\n\nReading examples, not the current board: the row pattern "# H" blocks a left move; "H #" blocks a right move. A # directly above H in the same column blocks up; a # directly below H blocks down. The same immediate collision rules apply to B. A blocking cell cannot be crossed to reach food.\n\nCurrent board:',
	);
	const balancedPatterns = balanced.replace(
		"\n\nCurrent board:",
		'\n\nReading examples, not the current board: "# H" blocks left and "H #" blocks right. # above or below H in the same column blocks up or down respectively. B blocks in the same way.\n\nCurrent board:',
	);
	const balancedGoal = balanced.replace(
		"This is a Snake game. Choose the next absolute direction.",
		"This is a Snake game. Eat apples to grow and fill the board. Choose a non-colliding next move toward the current apple.",
	);
	const steps = baseline.replace(
		priority,
		"Choose by these ordered requirements: First, your destination must be inside the board and must not contain # or B; apply the tail-vacating rule for T. Second, locate the current apple A and choose a move that starts an achievable route to it. If the direct approach is blocked, begin a safe detour around the blocking cell. Third, avoid repeating movement recorded in progress that has returned without an apple. Eating successive apples is the goal; surviving an empty circuit is insufficient. Select exactly one offered direction.",
	);
	const progressReport = progress
		? `Food progress at observed tick ${progress.throughTick}: the last apple was eaten at tick ${progress.lastAppleTick}; ${progress.movesSinceApple} moves have since occurred without another apple.`
		: "Use the observed apple and recorded food progress.";
	const reassess =
		"Continued movement without another apple is not task progress. Reconsider an approach that produces empty circuits, and look for a non-colliding route that actually reaches the current A.";
	const progressContext = baseline.replace(
		"\n\nCurrent board:",
		`\n\n${progressReport} ${reassess}\n\nCurrent board:`,
	);
	const progressFooter = baseline + `\n\n${progressReport} ${reassess}`;
	const progressFacts = baseline.replace(
		"\n\nCurrent board:",
		`\n\n${observations} ${reassess}\n\nCurrent board:`,
	);
	const cellReadings = Object.keys(request.questions.direction.criteria)
		.map((key) => {
			const direction = key as Direction;
			const x = head.x + vectors[direction].x;
			const y = head.y + vectors[direction].y;
			const at = (p: { x: number; y: number }) => p.x === x && p.y === y;
			const bodyIndex = request.state.player.bodyHeadToTail.findIndex(at);
			const symbol =
				x < 0 ||
				y < 0 ||
				x >= request.state.board.width ||
				y >= request.state.board.height
					? "outside board"
					: bodyIndex === 0
						? "H"
						: bodyIndex === request.state.player.bodyHeadToTail.length - 1
							? "T"
							: bodyIndex >= 0
								? "B"
								: request.state.board.obstacles.some(at)
									? "#"
									: apple && at(apple)
										? "A"
										: request.state.food.star &&
											  at(request.state.food.star.point)
											? "*"
											: ".";
			return `${direction}: observed cell (${x},${y}) = ${symbol}`;
		})
		.join("\n");
	const neighboringCells = balanced.replace(
		"\n\nLocate H.",
		`\n\nObserved neighboring cells, copied from this same board before moving:\n${cellReadings}\n\nLocate H.`,
	);
	const variants = Object.entries({
		adjacent_symbols: baseline,
		apple_objective: objective,
		apple_history: history,
		apple_route: route,
		apple_balanced: balanced,
		apple_detour: detour,
		apple_patterns: patterns,
		apple_balanced_patterns: balancedPatterns,
		apple_balanced_goal: balancedGoal,
		apple_steps: steps,
		apple_progress_context: progressContext,
		apple_progress_footer: progressFooter,
		apple_progress_facts: progressFacts,
		apple_neighbor_cells: neighboringCells,
	}).map(([name, instructions]) => {
		const candidate = structuredClone(request);
		candidate.questions.direction.instructions = instructions;
		return { name, request: candidate };
	});
	const destinations = {
		up: "directly above H in the same column",
		right: "directly right of H in the same row",
		down: "directly below H in the same column",
		left: "directly left of H in the same row",
	};
	for (const [name, conditional] of [
		["apple_option_conditions", true],
		["apple_option_statements", false],
	] as const) {
		const candidate = structuredClone(request);
		candidate.questions.direction.instructions = balanced;
		for (const direction of Object.keys(
			candidate.questions.direction.criteria,
		) as (keyof typeof destinations)[])
			candidate.questions.direction.criteria[direction] = {
				meaning: conditional
					? `Move ${direction} into the cell ${destinations[direction]}. Choose this only if that cell is inside the board, is not an obstacle # or body B, and, if it is T, the tail vacates on this move. This step should begin or continue a route to the current apple A, including a necessary detour.`
					: `The cell ${destinations[direction]} is inside the board and can be entered without collision now: it is neither # nor B, or it is the tail T vacating on this non-apple move. Moving ${direction} helps reach the current apple A.`,
			};
		variants.push({ name, request: candidate });
	}
	return variants;
}
