import "dotenv/config";
import { resolve } from "node:path";
import { communitySettings } from "./community/config.js";
import { jevConfig } from "./jev/config.js";
import { watchGameConfig } from "./jev/game-config.js";
import { startServer } from "./start.js";

const adminToken = process.env.GAME_ADMIN_TOKEN;
const path = process.env.SQLITE_PATH;
if (!adminToken || !path)
	throw new Error(
		"Set GAME_ADMIN_TOKEN and SQLITE_PATH in .env before starting the game server",
	);
const port = Number(process.env.GAME_PORT ?? 3001);
if (!Number.isInteger(port) || port < 0 || port > 65535)
	throw new Error("GAME_PORT must be a valid TCP port");
const jev = jevConfig();
const game = startServer({
	community: communitySettings(process.env),
	path: resolve(path),
	adminToken,
	port,
	hostname: process.env.GAME_HOST ?? "127.0.0.1",
	jevConfigured: Boolean(jev.apiKey),
	jevProvider: jev.provider,
	jevModel: jev.model,
	watch: {
		jev,
		makeConfig: () => watchGameConfig(process.env),
		intermissionMs: Number(process.env.WATCH_INTERMISSION_MS ?? 5000),
	},
	watchPublicOrigin: process.env.WATCH_PUBLIC_ORIGIN,
	watchSessionTtlMs: Number(
		process.env.WATCH_SESSION_TTL_MS ?? 8 * 60 * 60 * 1000,
	),
});
try {
	await game.ready;
} catch (error) {
	await game.close();
	throw error;
}
console.log(`Snake server listening on port ${port}; SQLite: ${resolve(path)}`);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		if (closing) return;
		closing = true;
		void (async () => {
			await game.close();
		})().catch((error) => {
			console.error(error);
			process.exitCode = 1;
		});
	});
