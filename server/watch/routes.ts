import { upgradeWebSocket } from "@hono/node-server";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { WSContext } from "hono/ws";
import { z } from "zod";
import { GameError } from "../errors.js";
import type { WatchChannel } from "./channel.js";
import type { OwnerSessions } from "./owner.js";

const cookie = "snake_watch_owner";
const cookiePath = "/api/watch-admin";
const loginSchema = z.object({ password: z.string().min(1) }).strict();

async function jsonBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new GameError("invalid_request", "Request body must be JSON");
	}
}

export function mountWatchRoutes(
	app: Hono,
	channel: WatchChannel,
	owner: OwnerSessions,
) {
	app.get("/api/watch-channel", (c) => {
		c.header("Cache-Control", "no-store");
		return c.json(channel.snapshot());
	});
	app.use("/api/watch-admin/*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		if (c.req.method !== "GET") owner.checkOrigin(c.req.header("Origin"));
		await next();
	});
	app.post("/api/watch-admin/session", async (c) => {
		const parsed = loginSchema.safeParse(await jsonBody(c));
		if (!parsed.success)
			throw new GameError("invalid_request", "请输入管理员口令");
		const session = owner.login(parsed.data.password);
		setCookie(c, cookie, session.token, {
			path: cookiePath,
			httpOnly: true,
			sameSite: "Strict",
			secure: owner.secure,
			maxAge: Math.ceil(owner.ttlMs / 1000),
		});
		return c.json({ authenticated: true, expiresAt: session.expiresAt });
	});
	app.get("/api/watch-admin/session", (c) =>
		c.json(owner.status(getCookie(c, cookie))),
	);
	app.delete("/api/watch-admin/session", (c) => {
		const token = getCookie(c, cookie);
		owner.authorize(token);
		owner.logout(token);
		deleteCookie(c, cookie, {
			path: cookiePath,
			httpOnly: true,
			sameSite: "Strict",
			secure: owner.secure,
		});
		return c.json({ authenticated: false, expiresAt: null });
	});
	app.post("/api/watch-admin/commands", async (c) => {
		owner.authorize(getCookie(c, cookie));
		return c.json(channel.command(await jsonBody(c)));
	});
	app.get(
		"/ws/watch-channel",
		upgradeWebSocket(() => {
			let socket: WSContext | null = null,
				unsubscribe = () => {};
			function send() {
				try {
					socket?.send(
						JSON.stringify({ type: "channel", state: channel.snapshot() }),
					);
				} catch (error) {
					console.error(
						"[watch channel subscription]",
						error instanceof Error ? error.message : String(error),
					);
					try {
						socket?.send(
							JSON.stringify({
								type: "service_error",
								error: {
									code: "channel_unavailable",
									message: "频道同步已中断，请重新连接",
								},
							}),
						);
					} catch (sendError) {
						console.error("[watch channel send]", sendError);
					}
					unsubscribe();
					socket?.close(1011, "Channel unavailable");
				}
			}
			return {
				onOpen(_event, ws) {
					socket = ws;
					unsubscribe = channel.subscribe(send);
					send();
				},
				onMessage() {
					socket?.send(
						JSON.stringify({
							type: "error",
							error: {
								code: "read_only",
								message: "Channel observation is read-only",
							},
						}),
					);
				},
				onClose() {
					unsubscribe();
					socket = null;
				},
				onError() {
					unsubscribe();
					socket = null;
				},
			};
		}),
	);
}
