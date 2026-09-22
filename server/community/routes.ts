import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { z } from "zod";
import {
	contributionInputSchema,
	contributionStatusInputSchema,
	credentialCommandSchema,
	feedbackInputSchema,
	revokeInputSchema,
	visibilityInputSchema,
	type CommunityConfig,
} from "../../shared/snake/community.js";
import type { CredentialService } from "../credentials/service.js";
import { GameError } from "../errors.js";
import type { OwnerSessions } from "../watch/owner.js";
import { ownerCookie } from "../watch/routes.js";
import type { CommunityStore } from "./store.js";

export type CommunityServices = {
	feedback: CommunityStore;
	credentials: CredentialService;
	config: CommunityConfig;
};
async function readInput<T>(
	c: Context,
	schema: z.ZodType<T>,
	limit: number,
): Promise<T> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = c.req.raw.body?.getReader();
	if (reader) {
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (limit > 0 && size > limit) {
					await reader.cancel();
					throw new GameError(
						"body_too_large",
						"提交内容超过站点允许的大小",
						413,
					);
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
	}
	let input: unknown;
	try {
		input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new GameError("invalid_request", "请提交有效的 JSON 内容");
	}
	const parsed = schema.safeParse(input);
	if (!parsed.success)
		throw new GameError(
			"invalid_request",
			"提交内容不正确，请检查必填项、服务商和使用授权",
		);
	return parsed.data;
}
export function mountCommunityRoutes(
	app: Hono,
	services: CommunityServices,
	owner: OwnerSessions,
) {
	const { feedback, credentials, config } = services;
	// createApp owns the safe error boundary for all community routes.
	const secure = async (c: Context, next: () => Promise<void>) => {
		c.header("Cache-Control", "no-store");
		if (c.req.method !== "GET") owner.checkOrigin(c.req.header("Origin"));
		if (
			c.req.path.startsWith("/api/key-contributions") &&
			!owner.secure &&
			!["localhost", "127.0.0.1", "[::1]"].includes(
				new URL(owner.origin).hostname,
			)
		)
			throw new GameError(
				"https_required",
				"生产环境的 Key 贡献必须通过 HTTPS",
				403,
			);
		await next();
	};
	for (const path of [
		"/api/community",
		"/api/feedback",
		"/api/key-contributions",
		"/api/key-contributions/*",
		"/api/watch-admin/feedback",
		"/api/watch-admin/feedback/*",
		"/api/watch-admin/credentials",
		"/api/watch-admin/credentials/*",
	])
		app.use(path, secure);
	const authorize = (c: Context) => owner.authorize(getCookie(c, ownerCookie));
	app.get("/api/community", (c) => c.json(config));
	app.get("/api/feedback", (c) => c.json(feedback.list(c.req.query("cursor"))));
	app.post("/api/feedback", async (c) => {
		const input = await readInput(c, feedbackInputSchema, config.maxBodyBytes);
		return c.json(feedback.create(input.requestId, input.body), 201);
	});
	app.post("/api/key-contributions", async (c) => {
		const input = await readInput(
			c,
			contributionInputSchema,
			config.maxBodyBytes,
		);
		return c.json(await credentials.contribute(input));
	});
	app.post("/api/key-contributions/status", async (c) => {
		const input = await readInput(
			c,
			contributionStatusInputSchema,
			config.maxBodyBytes,
		);
		return c.json(credentials.status(input.requestId));
	});
	app.post("/api/key-contributions/revoke", async (c) => {
		const input = await readInput(c, revokeInputSchema, config.maxBodyBytes);
		return c.json(
			credentials.revoke(input.requestId, input.provider, input.apiKey),
		);
	});
	app.get("/api/watch-admin/feedback", (c) => {
		authorize(c);
		return c.json(feedback.list(c.req.query("cursor"), true));
	});
	app.post("/api/watch-admin/feedback/:id/visibility", async (c) => {
		authorize(c);
		const input = await readInput(
			c,
			visibilityInputSchema,
			config.maxBodyBytes,
		);
		return c.json(
			feedback.visibility(c.req.param("id"), input.requestId, input.visible),
		);
	});
	app.get("/api/watch-admin/credentials", (c) => {
		authorize(c);
		return c.json({ items: credentials.list() });
	});
	app.post("/api/watch-admin/credentials/:id/commands", async (c) => {
		authorize(c);
		const input = await readInput(
			c,
			credentialCommandSchema,
			config.maxBodyBytes,
		);
		return c.json(
			await credentials.command(
				c.req.param("id"),
				input.requestId,
				input.action,
			),
		);
	});
}
