import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { CredentialCrypto, maskKey } from "../server/credentials/crypto.js";

test("credential encryption authenticates identity and ciphertext, fingerprint deduplicates full keys", () => {
	const crypto = new CredentialCrypto(randomBytes(32).toString("base64"));
	const a = crypto.seal("one", "typesafe", "unit-secret-one");
	const b = crypto.seal("one", "typesafe", "unit-secret-one");
	expect(a.nonce).not.toBe(b.nonce);
	expect(JSON.stringify(a)).not.toContain("unit-secret-one");
	expect(crypto.open("one", "typesafe", a)).toBe("unit-secret-one");
	for (const work of [
		() => crypto.open("two", "typesafe", a),
		() => crypto.open("one", "openrouter", a),
		() =>
			crypto.open("one", "typesafe", {
				...a,
				tag: randomBytes(16).toString("base64"),
			}),
		() =>
			new CredentialCrypto(randomBytes(32).toString("base64")).open(
				"one",
				"typesafe",
				a,
			),
	])
		expect(work).toThrow("解密失败");
	expect(crypto.fingerprint("typesafe", "unit-secret-one")).toBe(
		crypto.fingerprint("typesafe", "unit-secret-one"),
	);
	expect(crypto.fingerprint("typesafe", "a-same")).not.toBe(
		crypto.fingerprint("typesafe", "b-same"),
	);
	expect(crypto.fingerprint("typesafe", "same")).not.toBe(
		crypto.fingerprint("openrouter", "same"),
	);
	expect(maskKey("key12345")).toBe("•••• 2345");
	expect(maskKey("1234")).toBe("••••");
	expect(() => new CredentialCrypto("bad")).toThrow("32-byte");
});
