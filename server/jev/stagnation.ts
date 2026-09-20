import type {
	StagnationEvidence,
	StagnationSettings,
} from "../../shared/snake/stagnation.js";
import type {
	DecisionProgress,
	PublicState,
} from "../../shared/snake/types.js";

export const defaultStagnationSettings: Readonly<StagnationSettings> =
	Object.freeze({
		enabled: true,
		maxPositionVisits: 3,
		maxMovesWithoutApple: null,
	});

function positiveInteger(value: string, name: string, minimum: number): number {
	const parsed = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum)
		throw new Error(`${name} must be an integer >= ${minimum}`);
	return parsed;
}

export function parseStagnationSettings(
	env: Record<string, string | undefined>,
): StagnationSettings {
	const enabled = env.JEV_STAGNATION_GUARD;
	if (enabled !== undefined && enabled !== "true" && enabled !== "false")
		throw new Error("JEV_STAGNATION_GUARD must be true or false");
	return {
		enabled: enabled !== "false",
		maxPositionVisits:
			env.JEV_STAGNATION_MAX_VISITS === undefined
				? defaultStagnationSettings.maxPositionVisits
				: positiveInteger(
						env.JEV_STAGNATION_MAX_VISITS,
						"JEV_STAGNATION_MAX_VISITS",
						2,
					),
		maxMovesWithoutApple:
			env.JEV_STAGNATION_MAX_NO_APPLE_MOVES === undefined
				? null
				: positiveInteger(
						env.JEV_STAGNATION_MAX_NO_APPLE_MOVES,
						"JEV_STAGNATION_MAX_NO_APPLE_MOVES",
						1,
					),
	};
}

export function evaluateStagnation(
	state: Pick<PublicState, "tick" | "config" | "obstacles">,
	progress: DecisionProgress,
	settings: StagnationSettings = defaultStagnationSettings,
): StagnationEvidence | null {
	if (progress.throughTick !== state.tick)
		throw new Error("Stagnation progress history does not match observed tick");
	if (!settings.enabled) return null;
	const maxMovesWithoutApple =
		settings.maxMovesWithoutApple ??
		Math.max(
			64,
			2 * (state.config.width * state.config.height - state.obstacles.length),
		);
	const reason =
		progress.positionVisits >= settings.maxPositionVisits
			? "stagnation_loop"
			: progress.movesSinceApple >= maxMovesWithoutApple
				? "stagnation_no_apple"
				: null;
	return reason
		? {
				reason,
				observedTick: state.tick,
				movesSinceApple: progress.movesSinceApple,
				positionVisits: progress.positionVisits,
				maxPositionVisits: settings.maxPositionVisits,
				maxMovesWithoutApple,
			}
		: null;
}
