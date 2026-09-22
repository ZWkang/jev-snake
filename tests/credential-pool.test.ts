import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { CredentialPool } from "../server/credentials/pool.js";
import { jevConfig } from "../server/jev/config.js";
import { gameConfig } from "../server/jev/game-config.js";
import { ProviderError } from "../server/jev/transport-error.js";
import { MatchService } from "../server/matches/service.js";
import { credentialFixture } from "./credential-fixture";
const contribution = (
	apiKey: string,
	provider: "typesafe" | "openrouter" = "typesafe",
) => ({
	requestId: randomUUID(),
	apiKey,
	provider,
	consent: true as const,
	consentVersion: "watch-keys-v1" as const,
});
test("normal rounds rotate stable candidates, deduplicate environment keys, and preserve cursor on rollback", async () => {
	const f = credentialFixture(),
		games = new MatchService(f.store, () => 0, false);
	try {
		await f.service.contribute(contribution("env-key-a"));
		await f.service.contribute(contribution("contribution-b"));
		await f.service.contribute(contribution("other-provider", "openrouter"));
		const pool = new CredentialPool(
			f.service,
			jevConfig({ TYPESAFE_API_KEY: "env-key-a" }),
		);
		const create = () =>
			games.create({
				requestId: randomUUID(),
				controlToken: "s".repeat(32),
				agentName: "pool",
				config: gameConfig({}),
			});
		const a = create();
		pool.bindNew(a.id);
		expect(
			pool
				.forMatch(a.id)
				.begin({ observedSeq: 0, targetTick: 1, actionRequestId: randomUUID() })
				.apiKey,
		).toBe("env-key-a");
		const before = f.store.db
			.prepare("SELECT * FROM credential_pool_state")
			.all();
		expect(() =>
			f.store.db
				.transaction(() => {
					pool.bindNew(create().id);
					throw new Error("rollback");
				})
				.immediate(),
		).toThrow("rollback");
		expect(
			f.store.db.prepare("SELECT * FROM credential_pool_state").all(),
		).toEqual(before);
		const b = create();
		pool.bindNew(b.id);
		expect(
			pool
				.forMatch(b.id)
				.begin({ observedSeq: 0, targetTick: 1, actionRequestId: randomUUID() })
				.apiKey,
		).toBe("contribution-b");
		const cursor = f.store.db
			.prepare("SELECT cursor FROM credential_pool_state")
			.get();
		pool.ensureRound(b.id);
		expect(
			f.store.db.prepare("SELECT cursor FROM credential_pool_state").get(),
		).toEqual(cursor);
		const changed = new CredentialPool(f.service, {
			...pool.jev,
			model: "another-model",
		});
		expect(() => changed.ensureRound(b.id)).toThrow("配置已改变");
	} finally {
		games.close();
		await f.close();
	}
});
test("credential failure excludes a member while temporary failures never rotate", async () => {
	const f = credentialFixture(),
		games = new MatchService(f.store, () => 0, false);
	try {
		await f.service.contribute(contribution("key-a"));
		await f.service.contribute(contribution("key-b"));
		const pool = new CredentialPool(f.service, f.jev),
			state = games.create({
				requestId: randomUUID(),
				controlToken: "s".repeat(32),
				agentName: "pool",
				config: gameConfig({}),
			});
		pool.bindNew(state.id);
		const source = pool.forMatch(state.id),
			a = source.begin({
				observedSeq: 0,
				targetTick: 1,
				actionRequestId: randomUUID(),
			});
		source.started(a);
		expect(
			source.failed(
				a,
				new ProviderError("typesafe", "invalid_key", 401),
				false,
			),
		).toBe(true);
		const b = source.begin({
			observedSeq: 0,
			targetTick: 1,
			actionRequestId: randomUUID(),
		});
		source.started(b);
		expect(b.attempt.credentialRef).not.toBe(a.attempt.credentialRef);
		expect(
			source.failed(
				b,
				new ProviderError("typesafe", "rate_limited", 429),
				false,
			),
		).toBe(false);
		expect(f.service.store.get(b.attempt.credentialRef)?.status).toBe(
			"enabled",
		);
		f.service.revoke(randomUUID(), "typesafe", "key-b");
		expect(() =>
			source.begin({
				observedSeq: 0,
				targetTick: 1,
				actionRequestId: randomUUID(),
			}),
		).toThrow("没有可用凭证");
		expect(
			f.service.store.attempts().filter((a) => a.purpose === "watch"),
		).toHaveLength(2);
	} finally {
		games.close();
		await f.close();
	}
});
test("decryption and attempt storage failures surface instead of trying another key", async () => {
	const f = credentialFixture(),
		games = new MatchService(f.store, () => 0, false);
	try {
		await f.service.contribute(contribution("key-a"));
		const pool = new CredentialPool(f.service, f.jev),
			state = games.create({
				requestId: randomUUID(),
				controlToken: "s".repeat(32),
				agentName: "pool",
				config: gameConfig({}),
			});
		pool.bindNew(state.id);
		f.store.db.exec(
			"CREATE TRIGGER fail_attempt BEFORE INSERT ON credential_attempts BEGIN SELECT RAISE(ABORT,'private failure'); END;",
		);
		const source = pool.forMatch(state.id);
		const call = source.begin({
			observedSeq: 0,
			targetTick: 1,
			actionRequestId: randomUUID(),
		});
		expect(() => source.started(call)).toThrow("记录保存失败");
		f.store.db.exec("DROP TRIGGER fail_attempt");
		const c = f.service.store.all()[0];
		f.service.store.save({ ...c, secret: { ...c.secret!, tag: "bad" } });
		expect(() => pool.ensureRound(state.id)).toThrow("解密失败");
	} finally {
		games.close();
		await f.close();
	}
});
