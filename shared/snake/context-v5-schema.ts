import { z } from "zod";
import {
	actionSummarySchema,
	decisionRequestV3Schema,
	postEatFactsSchema,
} from "./context-schema.js";
import { directions } from "./types.js";

const positive = z.number().int().positive();
const point = z
	.object({
		x: z.number().int().nonnegative(),
		y: z.number().int().nonnegative(),
	})
	.strict();
const survival = z
	.object({
		status: z.enum([
			"illegal_reverse",
			"immediate_collision",
			"board_complete",
			"proven_fatal",
			"not_proven_fatal",
		]),
		collision: z.enum(["reverse", "wall", "obstacle", "body"]).nullable(),
		collisionWithinMoves: positive.nullable(),
		proof: z
			.enum([
				"forced_path",
				"trapped_region",
				"all_continuations",
				"post_apple_all_continuations",
			])
			.nullable(),
	})
	.strict()
	.superRefine((s, c) => {
		const valid =
			s.status === "illegal_reverse"
				? s.collision === "reverse" &&
					s.collisionWithinMoves === null &&
					s.proof === null
				: s.status === "immediate_collision"
					? s.collision !== null &&
						s.collision !== "reverse" &&
						s.collisionWithinMoves === 1 &&
						s.proof === null
					: s.status === "proven_fatal"
						? s.collision === null &&
							s.collisionWithinMoves !== null &&
							s.proof !== null
						: s.collision === null &&
							s.collisionWithinMoves === null &&
							s.proof === null;
		if (!valid)
			c.addIssue({
				code: "custom",
				message: "Survival status and proof bounds disagree",
			});
	});
const postApple = z
	.object({
		status: z.enum(["board_complete", "proven_fatal", "not_proven_fatal"]),
		postEat: postEatFactsSchema,
		collisionWithinMoves: positive.nullable(),
		collisionWithinMovesFromObservation: positive.nullable(),
	})
	.strict()
	.superRefine((s, c) => {
		if (
			(s.status === "board_complete") !==
			(s.postEat.terminal === "board_complete")
		)
			c.addIssue({
				code: "custom",
				message: "Growth endpoint terminal outcome disagrees",
			});
		const hasBound =
			s.collisionWithinMoves !== null &&
			s.collisionWithinMovesFromObservation !== null;
		if (
			s.status === "proven_fatal"
				? !hasBound
				: s.collisionWithinMoves !== null ||
					s.collisionWithinMovesFromObservation !== null
		)
			c.addIssue({
				code: "custom",
				message: "Only proven death has a collision bound",
			});
	});
const appleRoute = z
	.object({
		status: z.enum([
			"verified_route",
			"unresolved",
			"exhausted",
			"not_applicable",
		]),
		moves: positive.nullable(),
		postApple: postApple.nullable(),
	})
	.strict()
	.superRefine((a, c) => {
		if (
			a.status === "verified_route"
				? a.moves === null || a.postApple === null
				: a.moves !== null || a.postApple !== null
		)
			c.addIssue({
				code: "custom",
				message: "Only a verified apple route has an endpoint",
			});
		if (
			a.moves !== null &&
			a.postApple?.status === "proven_fatal" &&
			a.postApple.collisionWithinMovesFromObservation !==
				a.moves + (a.postApple.collisionWithinMoves as number)
		)
			c.addIssue({
				code: "custom",
				message: "Post-apple bound must include the route length",
			});
	});
const action = z
	.object({
		meaning: z.string(),
		summary: z.string().min(1),
		survival,
		appleRoute,
		appleAlternativeSearch: z
			.object({
				status: z.enum(["endpoint_found", "exhausted"]),
				initialRouteMoves: positive,
				expandedStates: z.number().int().nonnegative(),
				fatalAppleEndpoints: z.number().int().nonnegative(),
			})
			.strict()
			.optional(),
		space: actionSummarySchema.shape.space,
		starRoute: actionSummarySchema.shape.starRoute,
		noGrowthCycle: z
			.object({ prefixMoves: positive, period: positive })
			.strict()
			.nullable(),
		bodyReleasePassages: z.array(
			z
				.object({
					point,
					earliestReleaseStep: positive,
					enteredAtStep: positive,
				})
				.strict()
				.refine(
					(p) => p.enteredAtStep >= p.earliestReleaseStep,
					"Release cannot occur after entry",
				),
		),
	})
	.strict()
	.superRefine((a, c) => {
		if (
			a.appleAlternativeSearch &&
			(a.survival.status !== "not_proven_fatal" ||
				a.appleRoute.status !== "verified_route" ||
				(a.appleAlternativeSearch.status === "endpoint_found"
					? a.appleRoute.postApple?.status === "proven_fatal"
					: a.appleRoute.postApple?.status !== "proven_fatal"))
		)
			c.addIssue({
				code: "custom",
				message: "Alternative search and arrival outcome disagree",
			});
		const blocked =
			a.survival.status === "illegal_reverse" ||
			a.survival.status === "immediate_collision";
		if (
			blocked &&
			(a.appleRoute.status !== "not_applicable" ||
				a.space !== null ||
				a.noGrowthCycle !== null ||
				a.bodyReleasePassages.length)
		)
			c.addIssue({
				code: "custom",
				message: "Blocked actions have no continuation",
			});
		if (
			a.survival.status === "board_complete" &&
			(a.appleRoute.moves !== 1 ||
				a.appleRoute.postApple?.status !== "board_complete")
		)
			c.addIssue({
				code: "custom",
				message: "Immediate victory requires the actual winning apple",
			});
		if ((a.noGrowthCycle !== null) !== (a.appleRoute.status === "unresolved"))
			c.addIssue({
				code: "custom",
				message:
					"Unresolved apple search must retain its no-growth cycle witness",
			});
	});
export const decisionRequestV5Schema = z
	.object({
		model: z.string().min(1),
		state: z
			.object({
				...decisionRequestV3Schema.shape.state.shape,
				contextVersion: z.literal("action-outcomes-v5"),
			})
			.strict()
			.superRefine((s, c) => {
				if (s.progress && s.progress.throughTick !== s.timing.observedTick)
					c.addIssue({
						code: "custom",
						path: ["progress"],
						message: "Progress must match the observation",
					});
			}),
		questions: z
			.object({
				direction: z
					.object({
						type: z.literal("choice"),
						instructions: z.string(),
						criteria: z.record(z.enum(directions), action),
					})
					.strict(),
			})
			.strict(),
	})
	.strict();
