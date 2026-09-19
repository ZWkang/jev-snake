import { z } from "zod";
import { directions } from "./types.js";

const integer = z.number().int().nonnegative();
const positive = z.number().int().positive();
const point = z.object({ x: integer, y: integer }).strict();
const route = z.array(z.enum(directions)).nonempty();
const geometry = z
	.object({
		snake: z.array(point).nonempty(),
		direction: z.enum(directions),
		apple: point.nullable(),
	})
	.strict();
const passage = z
	.object({
		point,
		originalBodyIndex: integer,
		earliestReleaseStep: positive,
		enteredAtStep: positive,
	})
	.strict()
	.refine(
		(p) => p.enteredAtStep >= p.earliestReleaseStep,
		"A body cell cannot be entered before release",
	);
const appleWitness = z
	.object({
		directions: route,
		end: geometry,
		releasePassages: z.array(passage),
	})
	.strict();
const cycleWitness = z
	.object({
		prefixDirections: route,
		cycleDirections: route,
		cycleStart: geometry,
		end: geometry,
		releasePassages: z.array(passage),
	})
	.strict()
	.refine(
		(w) => JSON.stringify(w.cycleStart) === JSON.stringify(w.end),
		"A cycle must restore the full geometry",
	);
const evidence = z.discriminatedUnion("status", [
	z
		.object({
			status: z.enum(["apple_eaten_now", "apple_route_found"]),
			source: z.enum(["direct", "static_candidate", "dynamic_search"]),
			witness: appleWitness,
			terminal: z.enum(["board_complete", "none"]),
		})
		.strict(),
	z
		.object({ status: z.literal("non_growth_cycle"), witness: cycleWitness })
		.strict(),
]);
export const witnessArchiveSchema = z
	.object({
		version: z.literal("positive-v1"),
		observedTick: integer,
		records: z.record(
			z.string().min(1),
			z
				.object({
					basis: z.enum(["observed", "conditional_second"]),
					origin: geometry
						.extend({
							width: positive,
							height: positive,
							obstacles: z.array(point),
							rulesVersion: positive,
							tick: integer,
						})
						.strict(),
					evidence,
				})
				.strict(),
		),
	})
	.strict();
export const opportunitySchema = z
	.object({
		status: z.enum([
			"initial_collision",
			"apple_eaten_now",
			"apple_route_found",
			"non_growth_cycle",
			"exhausted",
		]),
		witnessId: z.string().min(1).nullable(),
		moves: positive.nullable(),
		appleTarget: point.nullable(),
		endEvent: z.enum([
			"apple_eaten",
			"board_complete",
			"cycle_completed",
			"none",
		]),
		cycle: z
			.object({ prefixMoves: positive, period: positive })
			.strict()
			.nullable(),
		releasePassages: z.array(passage),
		scope: z.enum(["observed_apple_only", "no_growth_cycle", "none"]),
	})
	.strict()
	.superRefine((v, c) => {
		const add = (condition: boolean, message: string) => {
			if (!condition) c.addIssue({ code: "custom", message });
		};
		const hasRoute =
			v.status === "apple_eaten_now" ||
			v.status === "apple_route_found" ||
			v.status === "non_growth_cycle";
		add(
			hasRoute
				? v.witnessId !== null && v.moves !== null
				: v.witnessId === null && v.moves === null,
			"Witness presence must match the evidence status",
		);
		if (!hasRoute)
			add(
				v.scope === "none" &&
					v.endEvent === "none" &&
					v.cycle === null &&
					v.appleTarget === null &&
					!v.releasePassages.length,
				"No route means no invented route facts",
			);
		else if (v.status === "non_growth_cycle")
			add(
				v.scope === "no_growth_cycle" &&
					v.endEvent === "cycle_completed" &&
					v.cycle !== null &&
					v.moves === v.cycle.prefixMoves + v.cycle.period &&
					v.appleTarget === null,
				"Cycle scope and move counts must match",
			);
		else
			add(
				v.scope === "observed_apple_only" &&
					v.appleTarget !== null &&
					v.cycle === null &&
					(v.endEvent === "apple_eaten" || v.endEvent === "board_complete"),
				"Apple route requires its known target and growth boundary",
			);
		if (v.status === "apple_eaten_now")
			add(v.moves === 1, "Immediate growth takes one move");
		for (const p of v.releasePassages)
			add(
				v.moves !== null && p.enteredAtStep <= v.moves,
				"Release passage must occur on the witness",
			);
	});
export const witnessContinuitySchema = z.array(
	z
		.object({
			witnessId: z.string().min(1),
			originTick: integer,
			matchedMoves: positive,
			remainingMoves: positive,
			nextDirection: z.enum(directions),
		})
		.strict(),
);
