/** Explicit offline experiment settings; never imported by the live runner. */
import { DEFAULT_POST_APPLE_SEARCH_OPTIONS } from "../../shared/snake/post-apple-search.js";
function searchInteger(
	value: string | undefined,
	name: string,
	defaultValue: number,
	minimum: number,
) {
	if (value === undefined) return defaultValue;
	const parsed = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum)
		throw new Error(`${name} must be a safe integer >= ${minimum}`);
	return parsed;
}

export function offlineSearchConfig(
	env: Record<string, string | undefined> = process.env,
) {
	return {
		maxDepth: searchInteger(
			env.JEV_SEARCH_DEPTH,
			"JEV_SEARCH_DEPTH",
			DEFAULT_POST_APPLE_SEARCH_OPTIONS.maxDepth,
			1,
		),
		maxNodes: searchInteger(
			env.JEV_SEARCH_NODES,
			"JEV_SEARCH_NODES",
			DEFAULT_POST_APPLE_SEARCH_OPTIONS.maxNodes,
			0,
		),
	};
}
