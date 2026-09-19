import { randomBytes, randomUUID } from "node:crypto";
import "dotenv/config";
import { parseArgs } from "node:util";
import { jevConfig } from "../server/jev/config.js";
import { gameClient } from "../server/jev/game-client.js";
import { gameConfig } from "../server/jev/game-config.js";
import { runJevMatch } from "../server/jev/runner.js";
import { configSchema } from "../shared/snake/schema.js";
import type { PublicState } from "../shared/snake/types.js";

const { values } = parseArgs({
	options: {
		"tick-ms": { type: "string" },
		"step-mode": { type: "string" },
		"decision-mode": { type: "string" },
		width: { type: "string" },
		height: { type: "string" },
		obstacles: { type: "string" },
		seed: { type: "string" },
		name: { type: "string" },
		url: { type: "string" },
		"fork-match": { type: "string" },
		"fork-seq": { type: "string" },
	},
});
const forkMatch = values["fork-match"];
const forkSeqValue = values["fork-seq"];
if ((forkMatch === undefined) !== (forkSeqValue === undefined))
	throw new Error("--fork-match and --fork-seq must be supplied together");
const forkSeq = forkSeqValue === undefined ? undefined : Number(forkSeqValue);
if (
	forkMatch !== undefined &&
	(!forkMatch.trim() ||
		!/^\d+$/.test(forkSeqValue as string) ||
		!Number.isSafeInteger(forkSeq))
)
	throw new Error(
		"Fork requires a match ID and a nonnegative integer --fork-seq",
	);
if (forkMatch !== undefined) {
	for (const option of [
		"tick-ms",
		"step-mode",
		"decision-mode",
		"width",
		"height",
		"obstacles",
		"seed",
	] as const) {
		if (values[option] !== undefined)
			throw new Error(
				`--fork-match cannot be combined with --${option}; source config is inherited`,
			);
	}
}
const jev = jevConfig();
const adminToken = process.env.GAME_ADMIN_TOKEN;
if (!jev.apiKey)
	throw new Error(
		`Set ${jev.keyEnv} in .env before running a real JEV match through ${jev.provider}`,
	);
if (!adminToken) throw new Error("Set GAME_ADMIN_TOKEN in .env");
const root =
	values.url ?? process.env.GAME_SERVER_URL ?? "http://127.0.0.1:3001";
const controlToken = randomBytes(32).toString("hex");
const request = gameClient(root);
const source =
	forkMatch === undefined
		? undefined
		: await request<PublicState>(
				`/api/matches/${encodeURIComponent(forkMatch)}`,
				adminToken,
			);
if (forkMatch !== undefined) {
	if (
		!source ||
		source.id !== forkMatch ||
		!source.config ||
		typeof source.config !== "object" ||
		["width", "height", "obstacleCount", "tickIntervalMs", "seed"].some(
			(key) => !(key in source.config),
		)
	)
		throw new Error(
			"Game server returned an incomplete fork source configuration",
		);
	configSchema.parse(source.config);
}
const config = source ? source.config : gameConfig(process.env, values);
const decisionMode = config.decisionMode ?? "single_step";
const protocolVersion = decisionMode === "two_step_fallback" ? 2 : 1;
if (protocolVersion === 2) {
	const response = await fetch(`${root}/api/health`);
	if (!response.ok) throw new Error(`Game health HTTP ${response.status}`);
	const health = (await response.json()) as {
		supportedProtocolVersions?: number[];
	};
	if (!health.supportedProtocolVersions?.includes(2))
		throw new Error(
			"Game server does not support two_step_fallback protocol v2",
		);
}
const identity = {
	requestId: randomUUID(),
	controlToken,
	agentName: values.name ?? `JEV 1.13 · ${jev.provider}`,
	model: jev.model,
};
const latest = await request<PublicState>(
	source
		? `/api/matches/${encodeURIComponent(source.id)}/fork`
		: "/api/matches",
	adminToken,
	source
		? { ...identity, sourceSeq: forkSeq }
		: {
				...identity,
				config,
			},
);
if (source) {
	if (
		!latest ||
		typeof latest.id !== "string" ||
		latest.id === source.id ||
		latest.forkedFrom?.matchId !== source.id ||
		latest.forkedFrom.seq !== forkSeq ||
		latest.tick !== latest.forkedFrom.tick ||
		latest.gameTimeMs !== latest.forkedFrom.gameTimeMs ||
		JSON.stringify(latest.config) !== JSON.stringify(source.config)
	)
		throw new Error(
			"Game server returned an invalid fork; source position and config must be preserved",
		);
	console.log(
		JSON.stringify({
			type: "match_forked",
			matchId: latest.id,
			sourceMatchId: source.id,
			sourceSeq: latest.forkedFrom.seq,
			sourceTick: latest.forkedFrom.tick,
		}),
	);
}
const controller = new AbortController();
const stop = () =>
	controller.abort(new DOMException("controller_stop", "AbortError"));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
try {
	await runJevMatch({
		root,
		state: latest,
		controlToken,
		jev,
		signal: controller.signal,
	});
} finally {
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.removeListener(signal, stop);
}
