import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { communitySettings } from "../server/community/config.js";
import { startServer } from "../server/start.js";
import { validTransport } from "./credential-fixture";
const origin = "http://localhost:3000",
	admin = "community-admin-".repeat(3);
async function fixture(extra: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "community-http-")),
		transport = validTransport();
	const settings = communitySettings({
		JEV_CONTRIBUTIONS_ENABLED: "true",
		CREDENTIALS_MASTER_KEY: randomBytes(32).toString("base64"),
		...extra,
	});
	const game = startServer({
		path: join(dir, "snake.sqlite"),
		adminToken: admin,
		port: 0,
		community: settings,
		credentialFetch: transport,
	});
	await game.ready;
	const request = (
		path: string,
		body?: unknown,
		cookie?: string,
		requestOrigin = origin,
	) =>
		game.app.request(path, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Origin: requestOrigin,
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
				...(cookie ? { Cookie: cookie } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return {
		game,
		transport,
		request,
		async login() {
			const res = await request("/api/watch-admin/session", {
				password: admin,
			});
			expect(res.status).toBe(200);
			return res.headers.get("set-cookie")!.split(";")[0];
		},
		async close() {
			await game.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
test("anonymous feedback is immediately public, idempotent, stable and administratively hidden", async () => {
	const f = await fixture();
	try {
		const input = {
			requestId: randomUUID(),
			body: "<script>alert('feedback')</script>",
		};
		const first = await f.request("/api/feedback", input);
		expect(first.status).toBe(201);
		const receipt = await first.json();
		expect(await (await f.request("/api/feedback", input)).json()).toEqual(
			receipt,
		);
		expect(
			(await f.request("/api/feedback", { ...input, body: "different" }))
				.status,
		).toBe(409);
		const page = await (await f.request("/api/feedback")).json();
		expect(page.items).toEqual([{ ...receipt, body: input.body }]);
		expect(
			(
				await f.request(`/api/watch-admin/feedback/${receipt.id}/visibility`, {
					requestId: randomUUID(),
					visible: false,
				})
			).status,
		).toBe(401);
		const cookie = await f.login(),
			hide = { requestId: randomUUID(), visible: false };
		expect(
			(
				await f.request(
					`/api/watch-admin/feedback/${receipt.id}/visibility`,
					hide,
					cookie,
					"https://evil.example",
				)
			).status,
		).toBe(403);
		expect(
			(
				await f.request(
					`/api/watch-admin/feedback/${receipt.id}/visibility`,
					hide,
					cookie,
				)
			).status,
		).toBe(200);
		expect((await (await f.request("/api/feedback")).json()).items).toEqual([]);
		expect(
			(
				await (
					await f.request("/api/watch-admin/feedback", undefined, cookie)
				).json()
			).items[0],
		).toMatchObject({ body: input.body, visible: false });
		await f.request(
			`/api/watch-admin/feedback/${receipt.id}/visibility`,
			{ requestId: randomUUID(), visible: true },
			cookie,
		);
		for (let i = 0; i < 23; i++)
			await f.request("/api/feedback", {
				requestId: randomUUID(),
				body: `entry ${i}`,
			});
		const a = await (await f.request("/api/feedback")).json(),
			b = await (
				await f.request(`/api/feedback?cursor=${a.nextCursor}`)
			).json();
		expect(a.items).toHaveLength(20);
		expect(b.items).toHaveLength(4);
		expect(new Set([...a.items, ...b.items].map((x) => x.id)).size).toBe(24);
		f.game.store.db.exec(
			"CREATE TRIGGER reject_feedback BEFORE INSERT ON community_feedback BEGIN SELECT RAISE(ABORT,'disk write failed'); END;",
		);
		expect(
			(
				await f.request("/api/feedback", {
					requestId: randomUUID(),
					body: "failure",
				})
			).status,
		).toBe(500);
	} finally {
		await f.close();
	}
});
test("public writes require same origin and explicit consent, grant no game or management permission", async () => {
	const f = await fixture();
	try {
		const input = {
			requestId: randomUUID(),
			provider: "typesafe",
			apiKey: "unit-private-api-key",
			consent: true,
			consentVersion: "watch-keys-v1",
		};
		expect(
			(
				await f.request(
					"/api/key-contributions",
					input,
					undefined,
					"https://evil.example",
				)
			).status,
		).toBe(403);
		expect(
			(await f.request("/api/key-contributions", { ...input, consent: false }))
				.status,
		).toBe(400);
		expect(f.transport).not.toHaveBeenCalled();
		const result = await (
			await f.request("/api/key-contributions", input)
		).json();
		expect(result.status).toBe("enabled");
		expect(
			await (
				await f.request("/api/key-contributions/status", {
					requestId: input.requestId,
				})
			).json(),
		).toEqual(result);
		expect((await f.request("/api/watch-admin/credentials")).status).toBe(401);
		expect(
			(
				await f.request("/api/matches", {
					requestId: randomUUID(),
					credential: result,
				})
			).status,
		).toBe(401);
		const cookie = await f.login(),
			list = await (
				await f.request("/api/watch-admin/credentials", undefined, cookie)
			).json();
		expect(list.items).toHaveLength(1);
		expect(JSON.stringify(list)).not.toContain(input.apiKey);
		expect(list.items[0]).not.toHaveProperty("fingerprint");
		const id = list.items[0].id;
		expect(
			(
				await f.request(
					`/api/watch-admin/credentials/${id}/commands`,
					{ requestId: randomUUID(), action: "disable" },
					"snake_watch_owner=forged",
				)
			).status,
		).toBe(401);
		expect(
			(
				await f.request("/api/key-contributions/revoke", {
					requestId: randomUUID(),
					provider: input.provider,
					apiKey: input.apiKey,
				})
			).status,
		).toBe(200);
		expect(f.transport).toHaveBeenCalledOnce();
		f.game.owner.close();
		expect(
			(await f.request("/api/watch-admin/credentials", undefined, cookie))
				.status,
		).toBe(401);
	} finally {
		await f.close();
	}
});
test("community settings expose actual configured links, and body limits can explicitly be disabled", async () => {
	for (const max of ["64", "0"]) {
		const f = await fixture({
			COMMUNITY_MAX_BODY_BYTES: max,
			COMMUNITY_WECOM_JOIN_URL: "https://work.weixin.qq.com/test",
			COMMUNITY_WECOM_QR_URL: "/images/group.png",
		});
		try {
			const config = await (await f.request("/api/community")).json();
			expect(config.joinUrl).toBe("https://work.weixin.qq.com/test");
			expect(config.qrUrl).toBe("/images/group.png");
			expect(config).not.toHaveProperty("masterKey");
			expect(
				(
					await f.request("/api/feedback", {
						requestId: randomUUID(),
						body: "test".repeat(50),
					})
				).status,
			).toBe(max === "0" ? 201 : 413);
		} finally {
			await f.close();
		}
	}
	expect(communitySettings().joinUrl).toBeNull();
	expect(communitySettings().qrUrl).toBeNull();
	for (const value of [
		"javascript:alert(1)",
		"https://user:pass@example.com",
		"//evil.example",
	])
		expect(() =>
			communitySettings({ COMMUNITY_WECOM_JOIN_URL: value }),
		).toThrow();
});
