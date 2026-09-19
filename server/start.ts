import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createApp } from "./app.js";
import { Store } from "./db/store.js";
import { jevConfig } from "./jev/config.js";
import { gameConfig } from "./jev/game-config.js";
import { MatchService } from "./matches/service.js";
import { WatchChannel, type WatchSettings } from "./watch/channel.js";
import { OwnerSessions } from "./watch/owner.js";

export function startServer(options: {
	path: string;
	adminToken: string;
	port: number;
	hostname?: string;
	jevConfigured?: boolean;
	jevProvider?: string;
	jevModel?: string;
	watch?: WatchSettings;
	watchPublicOrigin?: string;
	watchSessionTtlMs?: number;
}) {
	const owner = new OwnerSessions(
		options.adminToken,
		options.watchPublicOrigin ?? "http://localhost:3000",
		options.watchSessionTtlMs,
	);
	const store = new Store(options.path);
	const service = new MatchService(store);
	const channel = new WatchChannel(
		service,
		options.watch ?? {
			jev: jevConfig({}),
			makeConfig: () => gameConfig({}),
			intermissionMs: 5000,
		},
	);
	const app = createApp(service, {
		adminToken: options.adminToken,
		jevConfigured: options.jevConfigured ?? false,
		jevProvider: options.jevProvider,
		jevModel: options.jevModel,
		watch: { channel, owner },
	});
	const wss = new WebSocketServer({ noServer: true });
	const server = serve({
		fetch: app.fetch,
		port: options.port,
		hostname: options.hostname ?? "127.0.0.1",
		websocket: { server: wss },
	});
	const ready = new Promise<void>((resolve, reject) => {
		const listening = () => {
			try {
				const address = server.address();
				if (!address || typeof address === "string")
					throw new Error("Game server has no listening TCP address");
				const host = address.family === "IPv6" ? "[::1]" : "127.0.0.1";
				channel.activate(`http://${host}:${address.port}`);
				resolve();
			} catch (error) {
				reject(error);
			}
		};
		server.once("error", reject);
		if (server.listening) listening();
		else server.once("listening", listening);
	});
	let closing: Promise<void> | undefined;
	return {
		channel,
		owner,
		ready,
		store,
		service,
		app,
		server,
		wss,
		close() {
			if (closing) return closing;
			closing = (async () => {
				const errors: unknown[] = [];
				try {
					await channel.close();
				} catch (error) {
					errors.push(error);
				}
				try {
					if (!service.fault)
						for (const match of store.active())
							service.command(match.id, {
								protocolVersion: 1,
								requestId: randomUUID(),
								type: "stop",
								reason: "server_shutdown",
							});
				} catch (error) {
					errors.push(error);
				}
				service.close();
				owner.close();
				for (const socket of wss.clients) socket.terminate();
				try {
					await new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					);
				} catch (error) {
					errors.push(error);
				}
				wss.close();
				store.close();
				if (errors.length)
					throw new AggregateError(errors, "Game server shutdown failed");
			})();
			return closing;
		},
	};
}
