import { randomBytes } from "node:crypto";
import { GameError } from "../errors.js";
import { digest, secretEqual } from "../matches/service.js";

export class OwnerSessions {
	private sessions = new Map<string, number>();
	private hash: string;
	readonly origin: string;
	readonly secure: boolean;
	constructor(
		secret: string,
		origin: string,
		readonly ttlMs = 8 * 60 * 60 * 1000,
		private now: () => number = Date.now,
	) {
		if (secret.length < 32)
			throw new Error("GAME_ADMIN_TOKEN must contain at least 32 characters");
		if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)
			throw new Error("WATCH_SESSION_TTL_MS must be a positive integer");
		const url = new URL(origin);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.origin !== origin
		)
			throw new Error("WATCH_PUBLIC_ORIGIN must be an exact http(s) origin");
		this.origin = origin;
		this.secure = url.protocol === "https:";
		this.hash = digest(secret);
	}
	checkOrigin(origin: string | undefined) {
		if (origin !== this.origin)
			throw new GameError(
				"forbidden_origin",
				"Owner requests must come from the configured site origin",
				403,
			);
	}
	login(password: string) {
		if (!secretEqual(password, this.hash))
			throw new GameError("unauthorized", "管理员口令不正确", 401);
		for (const [key, expires] of this.sessions)
			if (expires <= this.now()) this.sessions.delete(key);
		const token = randomBytes(32).toString("hex"),
			expiresAt = this.now() + this.ttlMs;
		this.sessions.set(digest(token), expiresAt);
		return { token, expiresAt };
	}
	status(token: string | undefined) {
		const key = token ? digest(token) : "",
			expiresAt = this.sessions.get(key);
		if (expiresAt === undefined || expiresAt <= this.now()) {
			this.sessions.delete(key);
			return { authenticated: false, expiresAt: null };
		}
		return { authenticated: true, expiresAt };
	}
	authorize(token: string | undefined) {
		if (!this.status(token).authenticated)
			throw new GameError("unauthorized", "请先使用管理员口令解锁", 401);
	}
	logout(token: string | undefined) {
		if (token) this.sessions.delete(digest(token));
	}
	close() {
		this.sessions.clear();
	}
}
