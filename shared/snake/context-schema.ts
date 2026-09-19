import { z } from "zod";
import { directions, planChoices } from "./types.js";

const integer = z.number().int().nonnegative();
const positive = z.number().int().positive();
const point = z.object({ x: integer, y: integer }).strict();
const collisionReason = z.enum(["reverse", "wall", "obstacle", "body"]);
const collision = collisionReason.nullable();
const relative = z.enum(["less", "equal", "greater"]);
const tail = z.enum(["connected", "disconnected"]);
const space = z
	.object({
		staticReachableCells: positive,
		bodyLength: positive,
		relativeToBody: relative,
		legalNextMoves: integer.max(4),
		tailConnection: tail,
	})
	.strict();
const postEat = z.discriminatedUnion("terminal", [
	space.extend({ terminal: z.literal("none") }).strict(),
	z
		.object({
			terminal: z.literal("board_complete"),
			bodyLength: positive,
			staticReachableCells: z.null(),
			relativeToBody: z.null(),
			legalNextMoves: z.null(),
			tailConnection: z.null(),
		})
		.strict(),
]);
const unavailable = z.object({
	status: z.enum([
		"absent",
		"no_static_path",
		"not_applicable",
		"unknown_after_growth",
	]),
	distance: z.null(),
	verified: z.null(),
});
const invalid = z.object({
	status: z.literal("candidate_invalid"),
	distance: positive,
	verified: z.literal(false),
	failure: z.object({ step: positive, collision: collisionReason }).strict(),
});
const appleRoute = z.discriminatedUnion("status", [
	unavailable.extend({ postEat: z.null() }).strict(),
	invalid.extend({ postEat: z.null() }).strict(),
	z
		.object({
			status: z.literal("path_found"),
			distance: positive,
			verified: z.literal(true),
			postEat,
		})
		.strict(),
	z
		.object({
			status: z.literal("eaten_now"),
			distance: z.literal(1),
			verified: z.literal(true),
			postEat,
		})
		.strict(),
]);
const starTiming = {
	remainingMs: z.number().nonnegative().nullable(),
	nominalArrivalMs: z.number().nullable(),
	timingStatus: z.enum([
		"unknown",
		"not_applicable",
		"deadline_passed",
		"before_expiry_if_on_schedule",
		"not_before_expiry",
	]),
};
const starRoute = z.discriminatedUnion("status", [
	unavailable.extend(starTiming).strict(),
	invalid.extend(starTiming).strict(),
	z
		.object({
			status: z.literal("path_found"),
			distance: positive,
			verified: z.literal(true),
			...starTiming,
		})
		.strict(),
	z
		.object({
			status: z.literal("reached_now"),
			distance: z.literal(1),
			verified: z.literal(true),
			...starTiming,
		})
		.strict(),
]);
export const actionSummarySchema = z
	.object({
		immediateCollision: collision,
		danger: z
			.enum(["immediate_collision", "proven_fatal"])
			.nullable()
			.optional(),
		eatsApple: z.boolean(),
		forcedPath: z
			.object({
				outcome: z.enum([
					"forced_collision",
					"branch",
					"cycle",
					"unknown_after_apple",
					"board_complete",
				]),
				steps: positive,
			})
			.strict()
			.nullable(),
		terminal: z.enum(["none", "board_complete"]),
		space: space.nullable(),
		appleRoute,
		starRoute,
	})
	.strict()
	.superRefine((facts, context) => {
		const require = (condition: boolean, path: string[], message: string) => {
			if (!condition) context.addIssue({ code: "custom", path, message });
		};
		if (facts.danger !== undefined) {
			require(facts.immediateCollision !== null
				? facts.danger === "immediate_collision"
				: facts.danger !== "immediate_collision", [
				"danger",
			], "Immediate danger must agree with the immediate collision evidence");
			if (facts.forcedPath?.outcome === "forced_collision")
				require(facts.danger === "proven_fatal", [
					"danger",
				], "A proven forced collision must be labeled fatal");
			if (facts.terminal === "board_complete")
				require(facts.danger === null, [
					"danger",
				], "A completed board has no continuing danger");
		}
		if (facts.immediateCollision !== null) {
			require(facts.forcedPath === null, [
				"forcedPath",
			], "Blocked actions have no continuation");
			require(facts.space === null, [
				"space",
			], "Blocked actions have no resulting space");
			require(facts.terminal === "none", [
				"terminal",
			], "A collision cannot complete the board");
			require(facts.appleRoute.status === "not_applicable", [
				"appleRoute",
				"status",
			], "Blocked actions have no apple route");
			require(facts.starRoute.status === "not_applicable", [
				"starRoute",
				"status",
			], "Blocked actions have no star route");
		} else {
			require(facts.forcedPath !== null, [
				"forcedPath",
			], "Movable actions require continuation evidence");
			require(facts.terminal === "board_complete"
				? facts.space === null
				: facts.space !== null, [
				"space",
			], "Only nonterminal moves have resulting space");
		}
		if (facts.terminal === "board_complete") {
			require(facts.eatsApple, [
				"eatsApple",
			], "Completing the board requires growth");
			require(facts.appleRoute.status === "eaten_now" &&
				facts.appleRoute.postEat.terminal === "board_complete", [
				"appleRoute",
			], "Completed boards require the actual winning apple move");
			require(facts.starRoute.status === "not_applicable", [
				"starRoute",
				"status",
			], "Completed boards have no subsequent star route");
		}
		if (facts.appleRoute.status === "eaten_now") {
			require(facts.eatsApple, [
				"eatsApple",
			], "The immediate apple route must describe growth");
		}
	});
const pairBase = { first: z.enum(directions), second: z.enum(directions) };
const pair = z.discriminatedUnion("secondStatus", [
	z
		.object({
			...pairBase,
			secondStatus: z.literal("known"),
			secondFacts: actionSummarySchema,
		})
		.strict(),
	z
		.object({
			...pairBase,
			secondStatus: z.enum([
				"not_executed_first_blocked",
				"not_executed_board_complete",
			]),
			secondFacts: z.null(),
		})
		.strict(),
	z
		.object({
			...pairBase,
			secondStatus: z.literal("unknown_after_growth"),
			secondFacts: z
				.object({
					immediateCollision: collision,
					reason: z.literal("new_apple_position_unknown"),
				})
				.strict(),
		})
		.strict(),
]);
const timingBase = {
	stateIsProjected: z.literal(false),
	observedTick: integer,
	targetTick: integer,
	gameTimeMs: z.number().nonnegative(),
};
const fixedTiming = z
	.object({
		...timingBase,
		stepMode: z.literal("fixed"),
		deadlineInMs: z.number().optional(),
		tickIntervalMs: positive,
	})
	.strict();
const responseTiming = z
	.object({
		...timingBase,
		stepMode: z.literal("response"),
		deadlineInMs: z.null().optional(),
		tickIntervalMs: z.null(),
	})
	.strict();
export const decisionProgressSchema = z
	.object({
		historyVersion: z.literal("progress-v1"),
		historyStartTick: integer,
		throughTick: integer,
		lastAppleTick: integer,
		movesSinceApple: integer,
		positionVisits: positive,
		previousVisitTick: integer.nullable(),
		repeatAfterMoves: positive.nullable(),
		actions: z.record(
			z.enum(directions),
			z
				.object({
					timesTaken: integer,
					returnsWithoutApple: integer,
					lastTakenTick: integer.nullable(),
				})
				.strict(),
		),
	})
	.strict()
	.superRefine((progress, context) => {
		const require = (condition: boolean, path: string[], message: string) => {
			if (!condition) context.addIssue({ code: "custom", path, message });
		};
		require(progress.historyStartTick <= progress.lastAppleTick &&
			progress.lastAppleTick <= progress.throughTick, [
			"lastAppleTick",
		], "The last apple tick must lie within the recorded history");
		require(progress.movesSinceApple ===
			progress.throughTick - progress.lastAppleTick, [
			"movesSinceApple",
		], "Moves since apple must match the observed tick difference");
		if (progress.positionVisits === 1) {
			require(progress.previousVisitTick === null &&
				progress.repeatAfterMoves === null, [
				"previousVisitTick",
			], "A first visit has no previous visit or repeated interval");
		} else {
			require(progress.previousVisitTick !== null &&
				progress.previousVisitTick >= progress.lastAppleTick &&
				progress.previousVisitTick < progress.throughTick, [
				"previousVisitTick",
			], "A repeated position needs an earlier visit since the last apple");
			require(progress.previousVisitTick !== null &&
				progress.repeatAfterMoves ===
					progress.throughTick - progress.previousVisitTick, [
				"repeatAfterMoves",
			], "The repeat interval must match the previous visit tick difference");
		}
		for (const direction of directions) {
			const action = progress.actions[direction];
			require(action.returnsWithoutApple <= action.timesTaken, [
				"actions",
				direction,
				"returnsWithoutApple",
			], "Unrewarded returns cannot exceed the recorded action count");
			require(action.timesTaken === 0
				? action.lastTakenTick === null
				: action.lastTakenTick !== null &&
						action.lastTakenTick > progress.lastAppleTick &&
						action.lastTakenTick <= progress.throughTick, [
				"actions",
				direction,
				"lastTakenTick",
			], "A recorded action needs its actual execution tick within this apple period");
		}
	});
function validateObservedProgress(
	state: {
		progress?: { throughTick: number };
		timing: { observedTick: number };
	},
	context: z.RefinementCtx,
) {
	if (
		state.progress !== undefined &&
		state.progress.throughTick !== state.timing.observedTick
	) {
		context.addIssue({
			code: "custom",
			path: ["progress", "throughTick"],
			message: "Progress must describe the exact observed tick",
		});
	}
}
const state = z
	.object({
		contextVersion: z.literal("action-facts-v3"),
		rules: z
			.object({
				objective: z.string(),
				applePoints: integer,
				starPoints: integer,
				factsSemantics: z.string(),
			})
			.strict(),
		board: z
			.object({ width: positive, height: positive, obstacleCount: integer })
			.strict(),
		player: z
			.object({
				head: point,
				direction: z.enum(directions),
				length: positive,
				score: integer,
			})
			.strict(),
		food: z
			.object({
				apple: point.nullable(),
				star: z
					.object({ point, expiresAt: z.number().nonnegative() })
					.strict()
					.nullable(),
			})
			.strict(),
		timing: z.discriminatedUnion("stepMode", [fixedTiming, responseTiming]),
		progress: decisionProgressSchema.optional(),
	})
	.strict();
export const decisionRequestV3Schema = z
	.object({
		model: z.string().min(1),
		state: state.superRefine(validateObservedProgress),
		questions: z
			.object({
				direction: z
					.object({
						type: z.literal("choice"),
						instructions: z.string(),
						criteria: z.record(
							z.enum(directions),
							actionSummarySchema.safeExtend({ meaning: z.string() }).strict(),
						),
					})
					.strict(),
			})
			.strict(),
	})
	.strict();
export const planRequestV3Schema = z
	.object({
		model: z.string().min(1),
		state: state
			.extend({
				contextVersion: z.literal("two-step-plan-v3"),
				planningHorizon: z.literal(2),
				targetTicks: z.tuple([integer, integer]),
				firstActions: z.record(z.enum(directions), actionSummarySchema),
				timing: fixedTiming,
			})
			.strict()
			.superRefine(validateObservedProgress),
		questions: z
			.object({
				plan: z
					.object({
						type: z.literal("choice"),
						instructions: z.string(),
						criteria: z.record(z.enum(planChoices), pair),
					})
					.strict(),
			})
			.strict(),
	})
	.strict()
	.superRefine((request, context) => {
		for (const choice of planChoices) {
			const value = request.questions.plan.criteria[choice];
			const path = ["questions", "plan", "criteria", choice];
			if (`${value.first}_${value.second}` !== choice) {
				context.addIssue({
					code: "custom",
					path,
					message: "Pair directions must match their choice key",
				});
			}
			const first = request.state.firstActions[value.first];
			const expected =
				first.immediateCollision !== null
					? "not_executed_first_blocked"
					: first.terminal === "board_complete"
						? "not_executed_board_complete"
						: first.eatsApple
							? "unknown_after_growth"
							: "known";
			if (value.secondStatus !== expected) {
				context.addIssue({
					code: "custom",
					path: [...path, "secondStatus"],
					message: `First action requires ${expected}`,
				});
			}
		}
	});
