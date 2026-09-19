import { upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import type WebSocket from "ws";
import { watchSchema } from "../shared/snake/schema.js";
import { publicState } from "../shared/snake/types.js";
import { GameError } from "./errors.js";
import { JEV_PROVIDERS } from "./jev/config.js";
import { digest, type MatchService, secretEqual } from "./matches/service.js";
import type { WatchChannel } from "./watch/channel.js";
import type { OwnerSessions } from "./watch/owner.js";
import { mountWatchRoutes } from "./watch/routes.js";

const bearer = (header: string | undefined) =>
	header?.startsWith("Bearer ") ? header.slice(7) : "";
function numberParam(
	value: string | undefined,
	defaultValue: number,
	min: number,
) {
	if (value === undefined) return defaultValue;
	const n = Number(value);
	if (!Number.isSafeInteger(n) || n < min)
		throw new GameError("invalid_request", "Invalid numeric query parameter");
	return n;
}
const errorObject = (error: unknown) =>
	error instanceof GameError
		? { code: error.code, message: error.message }
		: {
				code: "internal_error",
				message: error instanceof Error ? error.message : String(error),
			};

export function createApp(
	service: MatchService,
	options: {
		adminToken: string;
		jevConfigured: boolean;
		jevProvider?: string;
		jevModel?: string;
		watch?: { channel: WatchChannel; owner: OwnerSessions };
	},
) {
	if (options.adminToken.length < 32)
		throw new Error("GAME_ADMIN_TOKEN must contain at least 32 characters");
	const app = new Hono();
	const adminHash = digest(options.adminToken);
	app.onError((error, c) => {
		if (!(error instanceof GameError))
			console.error("[http error]", error.message);
		return c.json(
			{ error: errorObject(error) },
			(error instanceof GameError ? error.status : 500) as 400,
		);
	});
	if (options.watch)
		mountWatchRoutes(app, options.watch.channel, options.watch.owner);
	app.get("/api/health", (c) =>
		c.json(
			{
				status: service.fault ? "error" : "ok",
				error: service.fault,
				jevConfigured: options.jevConfigured,
				model: options.jevModel ?? JEV_PROVIDERS.typesafe.model,
				provider: options.jevProvider ?? "typesafe",
				protocolVersion: 1,
				supportedProtocolVersions: [1, 2],
			},
			service.fault ? 503 : 200,
		),
	);
	app.get("/api/matches", (c) => {
		const status = c.req.query("status");
		if (
			status &&
			!["ready", "running", "gameover", "won", "interrupted"].includes(status)
		)
			throw new GameError("invalid_request", "Unknown match status");
		return c.json({
			...service.store.list({
				status,
				agent: c.req.query("agent"),
				cursor: c.req.query("cursor"),
				limit: numberParam(c.req.query("limit"), 20, 1),
			}),
			agents: service.store.agents(),
		});
	});
	app.get("/api/matches/:id", (c) =>
		c.json({
			...publicState(service.store.get(c.req.param("id"))),
			...service.timing(c.req.param("id")),
		}),
	);
	app.get("/api/matches/:id/events", (c) =>
		c.json(
			service.store.events(
				c.req.param("id"),
				numberParam(c.req.query("afterSeq"), -1, -1),
				numberParam(c.req.query("limit"), 200, 1),
			),
		),
	);
	app.get("/api/matches/:id/decision-context", (c) => {
		const id = c.req.param("id") as string;
		service.authorize(id, bearer(c.req.header("Authorization")));
		return c.json(service.decisionContext(id));
	});
	app.post("/api/matches", async (c) => {
		const token = bearer(c.req.header("Authorization"));
		if (!token || !secretEqual(token, adminHash))
			throw new GameError(
				"unauthorized",
				"Administrator credential required",
				401,
			);
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			throw new GameError("invalid_request", "Request body must be JSON");
		}
		return c.json(service.create(body), 201);
	});
	app.post("/api/matches/:id/fork", async (c) => {
		const token = bearer(c.req.header("Authorization"));
		if (!token || !secretEqual(token, adminHash))
			throw new GameError(
				"unauthorized",
				"Administrator credential required",
				401,
			);
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			throw new GameError("invalid_request", "Request body must be JSON");
		}
		return c.json(service.fork(c.req.param("id"), body), 201);
	});
	for (const role of ["watch", "control"] as const) {
		app.get(
			`/ws/matches/:id/${role}`,
			async (c, next) => {
				const id = c.req.param("id") as string;
				service.store.get(id);
				if (role === "control")
					service.authorize(id, bearer(c.req.header("Authorization")));
				return next();
			},
			upgradeWebSocket((c) => {
				const id = c.req.param("id") as string;
				let socket: WSContext | null = null;
				let cursor = -1;
				let active = false;
				let pumping = false;
				let dirty = false;
				let unsubscribe = () => {};
				function send(message: unknown): Promise<void> {
					const raw = socket?.raw as WebSocket | undefined;
					return new Promise((resolve, reject) => {
						if (!raw || raw.readyState !== 1) {
							reject(new Error("WebSocket closed"));
							return;
						}
						raw.send(JSON.stringify(message), (error) =>
							error ? reject(error) : resolve(),
						);
					});
				}
				function connectionError(error: unknown) {
					console.error(
						"[websocket error]",
						error instanceof Error ? error.message : String(error),
					);
					socket?.close(1011, "Connection or event stream failed");
				}
				async function pump() {
					dirty = true;
					if (!active || pumping) return;
					pumping = true;
					try {
						do {
							dirty = false;
							let page: ReturnType<typeof service.store.events>;
							do {
								page = service.store.events(id, cursor);
								for (const event of page.events) {
									if (!active) return;
									await send({ type: "event", event, ...service.timing(id) });
									cursor = event.seq;
								}
							} while (active && page.hasMore);
						} while (active && dirty);
					} catch (error) {
						if (active) {
							try {
								await send({ type: "error", error: errorObject(error) });
							} catch (sendError) {
								console.error(
									"[websocket delivery error]",
									sendError instanceof Error
										? sendError.message
										: String(sendError),
								);
							}
							connectionError(error);
						}
					} finally {
						pumping = false;
					}
				}
				function subscribe(afterSeq: number) {
					const state = service.store.get(id);
					if (afterSeq > state.seq)
						throw new GameError(
							"invalid_cursor",
							"Cursor is ahead of this match",
							409,
						);
					if (active)
						throw new GameError(
							"already_subscribed",
							"This connection is already subscribed",
							409,
						);
					cursor = afterSeq;
					active = true;
					unsubscribe = service.subscribe((changed) => {
						if (changed === "") {
							void send({
								type: "service_error",
								error: { code: "service_failed", message: service.fault },
							}).catch(connectionError);
							return;
						}
						if (changed === id) void pump();
					});
					void send({
						type: "subscribed",
						matchId: id,
						latestSeq: state.seq,
						...service.timing(id),
					})
						.then(pump)
						.catch(connectionError);
				}
				return {
					onOpen(_event, ws) {
						socket = ws;
						if (role === "control") subscribe(service.store.get(id).seq - 1);
					},
					onMessage(event) {
						const receivedAt = service.clock();
						try {
							if (typeof event.data !== "string")
								throw new GameError(
									"invalid_message",
									"Only JSON text messages are accepted",
								);
							let data: unknown;
							try {
								data = JSON.parse(event.data);
							} catch {
								throw new GameError("invalid_message", "Invalid JSON");
							}
							if (role === "watch") {
								const parsed = watchSchema.safeParse(data);
								if (!parsed.success)
									throw new GameError(
										"readonly",
										"Spectators can only subscribe",
									);
								subscribe(parsed.data.afterSeq);
							} else {
								const receipt = service.command(id, data, receivedAt);
								void send({ type: "ack", receipt }).catch(connectionError);
							}
						} catch (error) {
							void send({ type: "error", error: errorObject(error) }).catch(
								connectionError,
							);
						}
					},
					onClose() {
						active = false;
						unsubscribe();
						socket = null;
					},
					onError() {
						active = false;
						unsubscribe();
					},
				};
			}),
		);
	}
	return app;
}
