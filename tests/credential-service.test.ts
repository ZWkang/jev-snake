import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { CredentialService } from "../server/credentials/service.js";
import { providerHttpError } from "../server/jev/transport-error.js";
import {
	contributionConsentVersion,
	type ContributionInput,
} from "../shared/snake/community.js";
import {
	credentialFixture,
	decisionResponse,
	validTransport,
} from "./credential-fixture";
const input = (
	apiKey = "unit-private-credential",
	provider: ContributionInput["provider"] = "typesafe",
): ContributionInput => ({
	requestId: randomUUID(),
	apiKey,
	provider,
	consent: true,
	consentVersion: contributionConsentVersion,
});

test("both providers validate real contracts, seal keys and deduplicate without creating games", async () => {
	const transport = validTransport(),
		f = credentialFixture(transport);
	try {
		for (const provider of ["typesafe", "openrouter"] as const) {
			const request = input(`unit-${provider}-private`, provider),
				result = await f.service.contribute(request);
			expect(result).toMatchObject({
				status: "enabled",
				created: true,
				provider,
			});
			expect(await f.service.contribute(request)).toEqual(result);
			expect(
				await f.service.contribute({ ...request, requestId: randomUUID() }),
			).toMatchObject({ status: "enabled", created: false });
			const c = f.service.store.all().find((row) => row.provider === provider)!;
			expect(f.service.requireCrypto().open(c.id, provider, c.secret!)).toBe(
				request.apiKey,
			);
			expect(
				JSON.stringify(
					f.store.db.prepare("SELECT * FROM contributed_credentials").all(),
				),
			).not.toContain(request.apiKey);
			expect(JSON.stringify(f.service.list())).not.toContain(request.apiKey);
			expect(JSON.stringify(f.service.list())).not.toContain(c.fingerprint);
		}
		expect(transport).toHaveBeenCalledTimes(2);
		expect(f.store.db.prepare("SELECT * FROM matches").all()).toEqual([]);
		expect(f.service.list()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					watchCalls: 0,
					validationCalls: 1,
					lastUsedAt: null,
					inputTokens: null,
				}),
			]),
		);
	} finally {
		await f.close();
	}
});
test("concurrent same-key validation shares a single request and never overrides revocation", async () => {
	let release!: () => void;
	const transport = vi
		.fn<typeof fetch>()
		.mockImplementation(async (_url, init) => {
			await new Promise<void>((r) => (release = r));
			return decisionResponse(init);
		});
	const f = credentialFixture(transport),
		a = input();
	try {
		const first = f.service.contribute(a);
		await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
		expect(await f.service.contribute(a)).toMatchObject({
			status: "validating",
		});
		const second = f.service.contribute({ ...a, requestId: randomUUID() });
		f.service.revoke(randomUUID(), a.provider, a.apiKey);
		release();
		expect(await first).toMatchObject({ status: "revoked" });
		expect(await second).toMatchObject({ status: "revoked" });
		expect(transport).toHaveBeenCalledOnce();
		expect(f.service.store.all()[0]).toMatchObject({
			status: "revoked",
			secret: null,
		});
	} finally {
		await f.close();
	}
});
test("validation fails for invalid response, forbidden, limit and network errors without retaining plaintext", async () => {
	for (const failure of [
		() => Response.json({ bad: "unit-private-credential" }),
		() => Response.json({ error: { code: 403 } }, { status: 403 }),
		() => Response.json({ error: { code: 429 } }, { status: 429 }),
		() => {
			throw new Error("unit-private-credential", {
				cause: { key: "unit-private-credential" },
			});
		},
	]) {
		const f = credentialFixture(
			vi.fn<typeof fetch>().mockImplementation(async () => failure()),
		);
		try {
			const result = await f.service.contribute(input());
			expect(result.status).toBe("failed");
			expect(JSON.stringify(result)).not.toContain("unit-private-credential");
			expect(f.service.store.all()[0].secret).toBeNull();
		} finally {
			await f.close();
		}
	}
});
test("database failure after valid response never activates an in-memory credential", async () => {
	const f = credentialFixture();
	try {
		f.store.db.exec(
			"CREATE TRIGGER fail_key_save BEFORE UPDATE ON contributed_credentials WHEN NEW.secret_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected write failure'); END;",
		);
		await expect(f.service.contribute(input())).rejects.toThrow(
			"injected write failure",
		);
		expect(f.service.store.all()[0]).toMatchObject({
			status: "unconfirmed",
			secret: null,
		});
		expect(f.service.store.attempts()[0].status).toBe("started");
	} finally {
		await f.close();
	}
});
test("shutdown and startup leave uncertain validation explicit and do not replay", async () => {
	const transport = vi
		.fn<typeof fetch>()
		.mockImplementation(
			async (_url, init) =>
				new Promise((_resolve, reject) =>
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason),
						{ once: true },
					),
				),
		);
	const f = credentialFixture(transport),
		request = input();
	try {
		const task = f.service.contribute(request);
		await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
		await f.service.close();
		expect(await task).toMatchObject({ status: "unconfirmed" });
		const next = new CredentialService(
			f.store.db,
			f.settings,
			f.config,
			transport,
		);
		expect(next.status(request.requestId).status).toBe("unconfirmed");
		expect(transport).toHaveBeenCalledOnce();
		await next.close();
	} finally {
		await f.close();
	}
});
test("administrator disable cannot be bypassed by public resubmission, revalidation is idempotent", async () => {
	const transport = validTransport(),
		f = credentialFixture(transport),
		request = input();
	try {
		await f.service.contribute(request);
		const c = f.service.store.all()[0];
		await f.service.command(c.id, randomUUID(), "disable");
		expect(
			await f.service.contribute({ ...request, requestId: randomUUID() }),
		).toMatchObject({ status: "disabled" });
		expect(transport).toHaveBeenCalledOnce();
		const revalidateId = randomUUID();
		expect(
			await f.service.command(c.id, revalidateId, "revalidate-and-enable"),
		).toMatchObject({ status: "enabled" });
		await f.service.command(c.id, revalidateId, "revalidate-and-enable");
		expect(transport).toHaveBeenCalledTimes(2);
		f.service.revoke(randomUUID(), request.provider, request.apiKey);
		await expect(
			f.service.command(c.id, randomUUID(), "revalidate-and-enable"),
		).rejects.toThrow("活动密文");
	} finally {
		await f.close();
	}
});
test("only evidenced credential errors permit rotation, never temporary budgets or policy failures", () => {
	const error = (
		provider: "typesafe" | "openrouter",
		status: number,
		body: unknown,
		headers: HeadersInit = {},
	) =>
		providerHttpError(provider, new Response(null, { status, headers }), body);
	expect(error("typesafe", 401, null).rotate).toBe(true);
	expect(
		error("typesafe", 402, {
			error: { code: 402, message: "Insufficient credits" },
		}).rotate,
	).toBe(false);
	expect(error("openrouter", 401, { error: { code: 401 } }).rotate).toBe(true);
	expect(
		error("openrouter", 402, {
			error: { code: 402, message: "Insufficient credits" },
		}).rotate,
	).toBe(true);
	for (const result of [
		error(
			"openrouter",
			402,
			{ error: { code: 402, message: "Insufficient credits" } },
			{ "Retry-After": "30" },
		),
		error("openrouter", 402, {
			error: {
				code: 402,
				message: "Insufficient credits",
				metadata: { limit_source: "openrouter_in_flight_budget" },
			},
		}),
		error("openrouter", 402, {
			error: { code: 402, message: "Policy budget exceeded" },
		}),
		error("openrouter", 401, {
			error: { code: 401, metadata: { provider_name: "upstream" } },
		}),
		error("openrouter", 403, {}),
		error("typesafe", 429, {}),
		error("typesafe", 529, {}),
	])
		expect(result.rotate).toBe(false);
});

test("revocation before dispatch and failed admin command persistence never bill validation", async () => {
	const transport = validTransport(),
		f = credentialFixture(transport);
	try {
		const request = input("cancel-before-dispatch"),
			result = f.service.contribute(request);
		f.service.revoke(randomUUID(), request.provider, request.apiKey);
		expect((await result).status).toBe("revoked");
		expect(transport).not.toHaveBeenCalled();
		const good = input("existing-secret");
		await f.service.contribute(good);
		const c = f.service.store.all().find((c) => c.status === "enabled")!;
		f.store.db.exec(
			"CREATE TRIGGER reject_admin_receipt BEFORE INSERT ON community_requests WHEN NEW.namespace='credential-command' BEGIN SELECT RAISE(ABORT,'command write failed'); END;",
		);
		await expect(
			f.service.command(c.id, randomUUID(), "revalidate-and-enable"),
		).rejects.toThrow("command write failed");
		expect(transport).toHaveBeenCalledOnce();
		expect(f.service.store.get(c.id)?.status).toBe("enabled");
	} finally {
		await f.close();
	}
});

test("late successful validation after shutdown cancellation is not activated", async () => {
	let release!: () => void;
	const transport = vi
		.fn<typeof fetch>()
		.mockImplementation(async (_url, init) => {
			await new Promise<void>((resolve) => (release = resolve));
			return decisionResponse(init);
		});
	const f = credentialFixture(transport);
	try {
		const request = input("late-validation"),
			pending = f.service.contribute(request);
		await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
		const closing = f.service.close();
		release();
		await closing;
		expect(await pending).toMatchObject({ status: "unconfirmed" });
		expect(f.service.store.all()[0].secret).toBeNull();
	} finally {
		await f.close();
	}
});
