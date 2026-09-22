import {
	createCipheriv,
	createDecipheriv,
	createHmac,
	hkdfSync,
	randomBytes,
} from "node:crypto";
import type { CommunityProvider } from "../../shared/snake/community.js";
import { GameError } from "../errors.js";

export type SealedKey = {
	version: 1;
	ciphertext: string;
	nonce: string;
	tag: string;
};
export class CredentialCrypto {
	private key: Buffer;
	private fingerprintKey: Buffer;
	constructor(encoded: string) {
		const key = Buffer.from(encoded, "base64");
		if (key.length !== 32 || key.toString("base64") !== encoded)
			throw new GameError(
				"credentials_configuration",
				"CREDENTIALS_MASTER_KEY must be a base64-encoded 32-byte secret",
				503,
			);
		this.key = key;
		this.fingerprintKey = Buffer.from(
			hkdfSync("sha256", key, "snake-credentials-v1", "fingerprint", 32),
		);
	}
	fingerprint(provider: CommunityProvider, key: string) {
		return this.hash([provider, key]);
	}
	hash(value: unknown) {
		return createHmac("sha256", this.fingerprintKey)
			.update(JSON.stringify(value))
			.digest("hex");
	}
	seal(id: string, provider: CommunityProvider, value: string): SealedKey {
		const nonce = randomBytes(12),
			cipher = createCipheriv("aes-256-gcm", this.key, nonce);
		cipher.setAAD(Buffer.from(JSON.stringify([id, provider, 1])));
		const ciphertext = Buffer.concat([
			cipher.update(value, "utf8"),
			cipher.final(),
		]);
		return {
			version: 1,
			ciphertext: ciphertext.toString("base64"),
			nonce: nonce.toString("base64"),
			tag: cipher.getAuthTag().toString("base64"),
		};
	}
	open(id: string, provider: CommunityProvider, sealed: SealedKey): string {
		try {
			if (sealed.version !== 1) throw new Error("Unknown cipher version");
			const decipher = createDecipheriv(
				"aes-256-gcm",
				this.key,
				Buffer.from(sealed.nonce, "base64"),
			);
			decipher.setAAD(Buffer.from(JSON.stringify([id, provider, 1])));
			decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
			return Buffer.concat([
				decipher.update(Buffer.from(sealed.ciphertext, "base64")),
				decipher.final(),
			]).toString("utf8");
		} catch {
			throw new GameError(
				"credentials_decryption",
				"贡献凭证解密失败，请检查加密配置和数据库完整性",
				503,
			);
		}
	}
}
export function maskKey(key: string) {
	return key.length > 4 ? `•••• ${key.slice(-4)}` : "••••";
}
