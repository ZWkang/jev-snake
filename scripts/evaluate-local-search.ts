import "dotenv/config";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import {
	createState,
	expireStar,
	inspectMove,
	move,
} from "../server/game/engine.js";
import { sendJevRequest } from "../server/jev/client.js";
import { jevConfig } from "../server/jev/config.js";
import { ProgressHistory } from "../server/jev/progress.js";
import { offlineSearchConfig } from "../server/jev/search-config.js";
import {
	decisionBodyV10 as decisionBody,
	decisionBodyV8,
	decisionBodyV9,
} from "../server/jev/search-context.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import { directions, publicState } from "../shared/snake/types.js";

// This is a real-provider evaluation, not the continuous game runner. The
// explicit observation horizon censors unfinished games; it is never a win.
const { values } = parseArgs({
	options: {
		live: { type: "boolean", default: false },
		baseline: { type: "string", default: "v9" },
		"layout-version": { type: "string", default: "3" },
		seeds: { type: "string", default: "bounded-search-a,bounded-search-b" },
		steps: { type: "string", default: "200" },
		out: { type: "string", default: `.data/qa/bounded-search/${Date.now()}` },
	},
});
if (!values.live)
	throw new Error(
		"Pass --live to authorize real JEV calls; no mock results are produced",
	);
const baseline = values.baseline;
if (baseline !== "v8" && baseline !== "v9")
	throw new Error("--baseline must be v8 or v9");
const layoutVersion = Number(values["layout-version"]);
if (layoutVersion !== 2 && layoutVersion !== 3)
	throw new Error("--layout-version must be 2 or 3");
const limit = Number(values.steps);
if (!Number.isSafeInteger(limit) || limit <= 0)
	throw new Error("--steps must be a positive safe integer");
const seeds = values.seeds.split(",");
if (
	!seeds.length ||
	seeds.some((seed) => !seed) ||
	new Set(seeds).size !== seeds.length
)
	throw new Error("--seeds must contain distinct nonempty seeds");
const config = jevConfig();
if (!config.apiKey) throw new Error(`Missing ${config.keyEnv}`);
const searchOptions = offlineSearchConfig();
const out = resolve(values.out);
await mkdir(out, { recursive: true });
await writeFile(
	`${out}/metadata.json`,
	JSON.stringify(
		{
			provider: config.provider,
			model: config.model,
			seeds,
			observationHorizon: limit,
			board: { width: 8, height: 6, obstacleCount: 1, layoutVersion },
			searchOptions,
			variants: [
				baseline === "v8" ? "global-view-v8" : "bounded-search-v9",
				"post-apple-v10",
			],
			realProvider: true,
			realEngine: true,
			retries: 0,
			clock: "elapsed wall time per arm; stars follow engine expiry rules",
			meaning:
				"Same initial seeds; unfinished games are censored, not wins or losses. Choices are never overridden.",
		},
		null,
		2,
	),
);

function stats(samples: number[]) {
	if (!samples.length) return null;
	const sorted = [...samples].sort((a, b) => a - b);
	return {
		p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
		p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
		max: sorted.at(-1),
	};
}
async function run(
	seed: string,
	seedIndex: number,
	variant: "v8" | "v9" | "v10",
) {
	const journal = `${out}/seed-${seedIndex}-${variant}.jsonl`;
	const state = createState(
		`evaluation-${seedIndex}-${variant}`,
		`Evaluation ${variant}`,
		config.model,
		{
			width: 8,
			height: 6,
			obstacleCount: 1,
			seed,
			layoutVersion,
			stepMode: "response",
			tickIntervalMs: null,
			decisionMode: "single_step",
		},
		new Date().toISOString(),
	);
	state.status = "running";
	const history = new ProgressHistory();
	const started = performance.now();
	const buildMs: number[] = [],
		requestMs: number[] = [];
	let repeats = 0,
		longestWithoutApple = 0,
		calls = 0,
		nodeCutoffs = 0;
	let failure: string | null = null;
	await appendFile(
		journal,
		`${JSON.stringify({ type: "initial", state: publicState(state) })}\n`,
	);
	try {
		while (state.status === "running" && calls < limit) {
			state.gameTimeMs = performance.now() - started;
			expireStar(state, state.gameTimeMs);
			if (
				directions.every(
					(direction) =>
						inspectMove(state, direction).immediateCollision !== null,
				)
			) {
				state.status = "gameover";
				state.endReason = "no_legal_moves";
				break;
			}
			const observed = publicState(state);
			history.observe(observed);
			const progress = history.snapshot(observed);
			if (progress.positionVisits > 1) repeats++;
			longestWithoutApple = Math.max(
				longestWithoutApple,
				progress.movesSinceApple,
			);
			const begin = performance.now();
			const request =
				variant === "v8"
					? decisionBodyV8(observed, config.model, undefined, progress)
					: variant === "v9"
						? decisionBodyV9(
								observed,
								config.model,
								undefined,
								progress,
								searchOptions,
							)
						: decisionBody(
								observed,
								config.model,
								undefined,
								progress,
								searchOptions,
							);
			const contextBuildMs = performance.now() - begin;
			decisionRequestSchema.parse(request);
			calls++;
			// Save the exact input before HTTP so even provider failures remain inspectable.
			await appendFile(
				journal,
				`${JSON.stringify({ type: "request", tick: state.tick, request, contextBuildMs })}\n`,
			);
			const result = await sendJevRequest(config.apiKey, request, {
				provider: config.provider,
				contextBuildMs,
			});
			buildMs.push(contextBuildMs);
			requestMs.push(result.decision.requestMs);
			if (
				request.state.contextVersion === "bounded-search-v9" ||
				request.state.contextVersion === "post-apple-v10"
			)
				nodeCutoffs += Object.values(request.state.localSearch.moves).filter(
					(item) => item.cutoff === "nodes",
				).length;
			const fact = inspectMove(state, result.decision.choice);
			await appendFile(
				journal,
				`${JSON.stringify({ type: "response", tick: state.tick, response: result.response, choice: result.decision.choice, immediateCollision: fact.immediateCollision })}\n`,
			);
			state.gameTimeMs = performance.now() - started;
			if (expireStar(state, state.gameTimeMs)) {
				await appendFile(
					journal,
					`${JSON.stringify({ type: "stale_observation", tick: state.tick, reason: "star_expired_during_inference" })}\n`,
				);
				continue;
			}
			move(state, result.decision.choice);
			if (calls % 25 === 0)
				console.log(
					JSON.stringify({
						seed,
						variant,
						calls,
						apples: state.applesEaten,
						score: state.score,
					}),
				);
		}
		// Match the live runner's no-legal-moves termination even at the horizon.
		if (
			state.status === "running" &&
			directions.every(
				(direction) =>
					inspectMove(state, direction).immediateCollision !== null,
			)
		) {
			state.status = "gameover";
			state.endReason = "no_legal_moves";
		}
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
		await appendFile(
			journal,
			`${JSON.stringify({ type: "error", error: failure, tick: state.tick })}\n`,
		);
		console.error(JSON.stringify({ seed, variant, error: failure }));
	}
	const result = {
		seed,
		variant,
		status: failure
			? "error"
			: state.status === "running"
				? "censored"
				: state.status,
		endReason: state.endReason,
		calls,
		moves: state.tick,
		apples: state.applesEaten,
		score: state.score,
		repeatedObservations: repeats,
		longestWithoutApple,
		nodeCutoffs,
		contextBuildMs: stats(buildMs),
		requestMs: stats(requestMs),
		error: failure,
	};
	await appendFile(
		journal,
		`${JSON.stringify({ type: "final", result, state: publicState(state) })}\n`,
	);
	console.log(JSON.stringify(result));
	return result;
}

const results = [];
for (const [index, seed] of seeds.entries()) {
	// Two independent providers calls at most; reverse launch order per seed.
	const order =
		index % 2 ? (["v10", baseline] as const) : ([baseline, "v10"] as const);
	results.push(
		...(await Promise.all(order.map((variant) => run(seed, index, variant)))),
	);
	await writeFile(
		`${out}/summary.json`,
		JSON.stringify(
			{ results, peakProcessRssKiB: process.resourceUsage().maxRSS },
			null,
			2,
		),
	);
}
if (results.some((result) => result.error)) process.exitCode = 1;
console.log(`Saved ${out}/summary.json`);
