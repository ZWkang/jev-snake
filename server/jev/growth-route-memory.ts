import { isDeepStrictEqual } from "node:util";
import {
	analyzeGrowthSpace,
	type GrowthRouteWitnesses,
	liveGrowthLimits,
} from "../../shared/snake/growth-space-analysis.js";
import type { GrowthAnalysisLimits } from "../../shared/snake/growth-space.js";
import type { LegalSpaceInput } from "../../shared/snake/legal-space.js";
import { inspectMove } from "../../shared/snake/move-rules.js";

type Observation = { matchId: string; tick: number; input: LegalSpaceInput };

/** One runner owns one cache. Every retained route is searched and checked again. */
export class GrowthRouteMemory {
	private previous: Observation | null = null;
	private routes: GrowthRouteWitnesses = {};

	analyze(
		input: LegalSpaceInput,
		identity: Omit<Observation, "input">,
		limits: GrowthAnalysisLimits = liveGrowthLimits,
	) {
		const retainedRoutes = this.retained(input, identity);
		const routes: GrowthRouteWitnesses = {};
		const result = analyzeGrowthSpace(input, limits, {
			retainedRoutes,
			onRouteFound: (direction, route) => {
				routes[direction] = route;
			},
		});
		this.previous = { ...identity, input: structuredClone(input) };
		this.routes = routes;
		return result;
	}

	private retained(
		input: LegalSpaceInput,
		identity: Omit<Observation, "input">,
	): GrowthRouteWitnesses {
		const previous = this.previous;
		if (!previous || previous.matchId !== identity.matchId) return {};
		const before = previous.input;
		if (
			before.width !== input.width ||
			before.height !== input.height ||
			!isDeepStrictEqual(before.obstacles, input.obstacles) ||
			!isDeepStrictEqual(before.apple, input.apple)
		)
			return {};
		if (identity.tick === previous.tick)
			return before.direction === input.direction &&
				isDeepStrictEqual(before.bodyHeadToTail, input.bodyHeadToTail)
				? this.routes
				: {};
		if (identity.tick !== previous.tick + 1) return {};
		const route = this.routes[input.direction];
		if (!route || route.length < 2) return {};
		const step = inspectMove(
			{
				config: before,
				snake: before.bodyHeadToTail,
				direction: before.direction,
				obstacles: before.obstacles,
				apple: before.apple,
			},
			input.direction,
		);
		if (
			step.immediateCollision ||
			step.eatsApple ||
			!isDeepStrictEqual(
				[step.target, ...before.bodyHeadToTail.slice(0, -1)],
				input.bodyHeadToTail,
			)
		)
			return {};
		const remaining = route.slice(1);
		return { [remaining[0]]: remaining };
	}
}
