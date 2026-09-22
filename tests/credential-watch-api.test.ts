import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { communitySettings } from "../server/community/config.js";
import { jevConfig, JEV_PROVIDERS } from "../server/jev/config.js";
import { gameConfig } from "../server/jev/game-config.js";
import { startServer } from "../server/start.js";
import { decisionResponse, validTransport } from "./credential-fixture";

for (const failure of [401, 429])
	test(`watch ${failure}: authenticates with pool and preserves error/step semantics`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "credential-watch-")),
			fetchOriginal = globalThis.fetch;
		let game: ReturnType<typeof startServer> | undefined,
			calls = 0;
		const keys: string[] = [],
			logs: string[] = [];
		const transport = vi
			.fn<typeof fetch>()
			.mockImplementation(async (url, init) => {
				if (String(url) !== JEV_PROVIDERS.typesafe.endpoint)
					return fetchOriginal(url, init);
				calls++;
				keys.push(new Headers(init?.headers).get("Authorization")!);
				if (calls === 1)
					return Response.json(
						{ error: { code: failure } },
						{ status: failure },
					);
				if (calls === 2) return decisionResponse(init);
				return new Promise((_resolve, reject) =>
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason),
						{ once: true },
					),
				);
			});
		vi.stubGlobal("fetch", transport);
		try {
			const settings = communitySettings({
				JEV_CONTRIBUTIONS_ENABLED: "true",
				JEV_CREDENTIAL_POOL: "true",
				CREDENTIALS_MASTER_KEY: randomBytes(32).toString("base64"),
			});
			game = startServer({
				path: join(dir, "snake.sqlite"),
				adminToken: "a".repeat(32),
				port: 0,
				community: settings,
				credentialFetch: validTransport(),
				watch: {
					jev: jevConfig({ TYPESAFE_API_KEY: "env-private-a" }),
					makeConfig: () =>
						gameConfig(
							{},
							{ width: "8", height: "6", obstacles: "0", seed: "pool-watch" },
						),
					intermissionMs: 5,
					log: (line) => logs.push(line),
				},
			});
			await game.ready;
			await game.community.credentials.contribute({
				requestId: randomUUID(),
				provider: "typesafe",
				apiKey: "contributed-private-b",
				consent: true,
				consentVersion: "watch-keys-v1",
			});
			game.channel.command({ requestId: randomUUID(), enabled: true });
			if (failure === 401) {
				await vi.waitFor(() => expect(calls).toBe(3));
				const id = game.channel.snapshot().currentMatchId!;
				expect(game.store.get(id).tick).toBe(1);
				expect(keys.slice(0, 2)).toEqual([
					"Bearer env-private-a",
					"Bearer contributed-private-b",
				]);
				game.channel.command({
					requestId: randomUUID(),
					enabled: false,
					stopCurrent: true,
				});
				await vi.waitFor(() =>
					expect(
						game!.community.credentials.store
							.attempts()
							.filter((a) => a.purpose === "watch")
							.at(-1)?.status,
					).toBe("cancelled"),
				);
				expect(calls).toBe(3);
				expect(game.store.get(id).tick).toBe(1);
				const events = JSON.stringify(game.store.events(id, -1, 200));
				expect(events).not.toContain("contributed-private-b");
				expect(events).not.toContain("credentialRef");
			} else {
				await vi.waitFor(() =>
					expect(game!.channel.snapshot().phase).toBe("fault"),
				);
				expect(calls).toBe(1);
				expect(game.store.get(game.channel.snapshot().lastMatchId!).tick).toBe(
					0,
				);
			}
			expect(logs.join("\n")).not.toContain("env-private-a");
			expect(logs.join("\n")).not.toContain("contributed-private-b");
		} finally {
			if (game) await game.close();
			vi.unstubAllGlobals();
			rmSync(dir, { recursive: true, force: true });
		}
	});

test("pool exhaustion stays faulted after new contribution until owner explicitly resumes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pool-empty-")),
		original = globalThis.fetch;
	let game: ReturnType<typeof startServer> | undefined,
		calls = 0;
	vi.stubGlobal(
		"fetch",
		async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			if (String(url) !== JEV_PROVIDERS.typesafe.endpoint)
				return original(url, init);
			calls++;
			if (calls === 1)
				return Response.json({ error: { code: 401 } }, { status: 401 });
			return new Promise((_resolve, reject) =>
				init?.signal?.addEventListener(
					"abort",
					() => reject(init.signal?.reason),
					{ once: true },
				),
			);
		},
	);
	try {
		const community = communitySettings({
			JEV_CONTRIBUTIONS_ENABLED: "true",
			JEV_CREDENTIAL_POOL: "true",
			CREDENTIALS_MASTER_KEY: randomBytes(32).toString("base64"),
		});
		game = startServer({
			path: join(dir, "snake.sqlite"),
			adminToken: "a".repeat(32),
			port: 0,
			community,
			credentialFetch: validTransport(),
			watch: {
				jev: jevConfig({}),
				makeConfig: () =>
					gameConfig(
						{},
						{ width: "8", height: "6", obstacles: "0", seed: "exhausted" },
					),
				intermissionMs: 5,
				log: () => {},
			},
		});
		await game.ready;
		const add = (apiKey: string) =>
			game!.community.credentials.contribute({
				requestId: randomUUID(),
				provider: "typesafe",
				apiKey,
				consent: true,
				consentVersion: "watch-keys-v1",
			});
		await add("pool-a");
		expect(
			(await (await game.app.request("/api/health")).json()).jevConfigured,
		).toBe(true);
		game.channel.command({ requestId: randomUUID(), enabled: true });
		await vi.waitFor(() =>
			expect(game!.channel.snapshot().error?.code).toBe(
				"credential_pool_exhausted",
			),
		);
		expect(calls).toBe(1);
		expect(game.store.get(game.channel.snapshot().lastMatchId!).tick).toBe(0);
		await add("pool-b");
		expect(game.channel.snapshot().phase).toBe("fault");
		expect(calls).toBe(1);
		game.channel.command({ requestId: randomUUID(), enabled: true });
		await vi.waitFor(() => expect(calls).toBe(2));
		game.channel.command({
			requestId: randomUUID(),
			enabled: false,
			stopCurrent: true,
		});
	} finally {
		if (game) await game.close();
		vi.unstubAllGlobals();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("restart resumes the same draining round and credential without advancing rotation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pool-resume-")),
		original = globalThis.fetch;
	let game: ReturnType<typeof startServer> | undefined,
		calls = 0;
	const keys: string[] = [];
	vi.stubGlobal(
		"fetch",
		async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			if (String(url) !== JEV_PROVIDERS.typesafe.endpoint)
				return original(url, init);
			calls++;
			keys.push(new Headers(init?.headers).get("Authorization")!);
			if (calls === 1) return decisionResponse(init);
			return new Promise((_resolve, reject) =>
				init?.signal?.addEventListener(
					"abort",
					() => reject(init.signal?.reason),
					{ once: true },
				),
			);
		},
	);
	try {
		const community = communitySettings({
			JEV_CONTRIBUTIONS_ENABLED: "true",
			JEV_CREDENTIAL_POOL: "true",
			CREDENTIALS_MASTER_KEY: randomBytes(32).toString("base64"),
		});
		const options = {
			path: join(dir, "snake.sqlite"),
			adminToken: "a".repeat(32),
			port: 0,
			community,
			credentialFetch: validTransport(),
			watch: {
				jev: jevConfig({}),
				makeConfig: () =>
					gameConfig(
						{},
						{ width: "8", height: "6", obstacles: "0", seed: "resume-pool" },
					),
				intermissionMs: 5,
				log: () => {},
			},
		};
		game = startServer(options);
		await game.ready;
		for (const apiKey of ["resume-key-a", "resume-key-b"])
			await game.community.credentials.contribute({
				requestId: randomUUID(),
				provider: "typesafe",
				apiKey,
				consent: true,
				consentVersion: "watch-keys-v1",
			});
		game.channel.command({ requestId: randomUUID(), enabled: true });
		await vi.waitFor(() => expect(calls).toBe(2));
		const id = game.channel.snapshot().currentMatchId!,
			before = game.store.get(id),
			cursor = game.store.db
				.prepare("SELECT cursor FROM credential_pool_state")
				.get();
		game.channel.command({ requestId: randomUUID(), enabled: false });
		await game.close();
		game = undefined;
		game = startServer(options);
		await game.ready;
		await vi.waitFor(() => expect(calls).toBe(3));
		expect(game.channel.snapshot()).toMatchObject({
			currentMatchId: id,
			enabled: false,
			phase: "draining",
		});
		const after = game.store.get(id);
		expect(after.tick).toBe(before.tick);
		expect(after.snake).toEqual(before.snake);
		expect(after.rngState).toBe(before.rngState);
		expect(after.config).toEqual(before.config);
		expect(after.gameTimeMs).toBeGreaterThanOrEqual(before.gameTimeMs);
		expect(new Set(keys).size).toBe(1);
		expect(
			game.store.db.prepare("SELECT cursor FROM credential_pool_state").get(),
		).toEqual(cursor);
		game.channel.command({
			requestId: randomUUID(),
			enabled: false,
			stopCurrent: true,
		});
	} finally {
		if (game) await game.close();
		vi.unstubAllGlobals();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("revoke lets an already dispatched response finish, then prevents every further call", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pool-revoke-")),
		original = globalThis.fetch;
	let game: ReturnType<typeof startServer> | undefined,
		calls = 0,
		release!: () => void;
	vi.stubGlobal(
		"fetch",
		async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			if (String(url) !== JEV_PROVIDERS.typesafe.endpoint)
				return original(url, init);
			calls++;
			await new Promise<void>((r) => (release = r));
			return decisionResponse(init);
		},
	);
	try {
		const community = communitySettings({
			JEV_CONTRIBUTIONS_ENABLED: "true",
			JEV_CREDENTIAL_POOL: "true",
			CREDENTIALS_MASTER_KEY: randomBytes(32).toString("base64"),
		});
		game = startServer({
			path: join(dir, "snake.sqlite"),
			adminToken: "a".repeat(32),
			port: 0,
			community,
			credentialFetch: validTransport(),
			watch: {
				jev: jevConfig({}),
				makeConfig: () =>
					gameConfig(
						{},
						{ width: "8", height: "6", obstacles: "0", seed: "revoke-pool" },
					),
				intermissionMs: 5,
				log: () => {},
			},
		});
		await game.ready;
		await game.community.credentials.contribute({
			requestId: randomUUID(),
			provider: "typesafe",
			apiKey: "revocable-key",
			consent: true,
			consentVersion: "watch-keys-v1",
		});
		game.channel.command({ requestId: randomUUID(), enabled: true });
		await vi.waitFor(() => expect(calls).toBe(1));
		const id = game.channel.snapshot().currentMatchId!;
		game.community.credentials.revoke(
			randomUUID(),
			"typesafe",
			"revocable-key",
		);
		release();
		await vi.waitFor(() =>
			expect(game!.channel.snapshot().phase).toBe("fault"),
		);
		expect(calls).toBe(1);
		expect(game.store.get(id).tick).toBe(1);
		expect(game.community.credentials.store.all()[0]).toMatchObject({
			status: "revoked",
			secret: null,
		});
	} finally {
		if (game) await game.close();
		vi.unstubAllGlobals();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("failed call-result persistence stops before submitting a model action", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pool-persist-")),
		original = globalThis.fetch;
	let game: ReturnType<typeof startServer> | undefined,
		calls = 0;
	vi.stubGlobal(
		"fetch",
		async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			if (String(url) !== JEV_PROVIDERS.typesafe.endpoint)
				return original(url, init);
			calls++;
			return decisionResponse(init);
		},
	);
	try {
		const community = communitySettings({
			JEV_CONTRIBUTIONS_ENABLED: "true",
			JEV_CREDENTIAL_POOL: "true",
			CREDENTIALS_MASTER_KEY: randomBytes(32).toString("base64"),
		});
		game = startServer({
			path: join(dir, "snake.sqlite"),
			adminToken: "a".repeat(32),
			port: 0,
			community,
			credentialFetch: validTransport(),
			watch: {
				jev: jevConfig({}),
				makeConfig: () =>
					gameConfig(
						{},
						{ width: "8", height: "6", obstacles: "0", seed: "persist-pool" },
					),
				intermissionMs: 5,
				log: () => {},
			},
		});
		await game.ready;
		await game.community.credentials.contribute({
			requestId: randomUUID(),
			provider: "typesafe",
			apiKey: "persist-key",
			consent: true,
			consentVersion: "watch-keys-v1",
		});
		game.store.db.exec(
			"CREATE TRIGGER fail_watch_result BEFORE INSERT ON credential_attempts WHEN NEW.purpose='watch' AND json_extract(NEW.data_json,'$.status')='succeeded' BEGIN SELECT RAISE(ABORT,'injected persistence failure'); END;",
		);
		game.channel.command({ requestId: randomUUID(), enabled: true });
		await vi.waitFor(() =>
			expect(game!.channel.snapshot().phase).toBe("fault"),
		);
		expect(calls).toBe(1);
		expect(game.store.get(game.channel.snapshot().lastMatchId!).tick).toBe(0);
		expect(game.channel.snapshot().error?.code).toBe(
			"credential_storage_error",
		);
	} finally {
		if (game) await game.close();
		vi.unstubAllGlobals();
		rmSync(dir, { recursive: true, force: true });
	}
});
