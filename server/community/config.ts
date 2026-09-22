import type { CommunityConfig } from "../../shared/snake/community.js";
import { JEV_PROVIDERS, type jevConfig } from "../jev/config.js";

export type CommunitySettings = {
	joinUrl: string | null;
	qrUrl: string | null;
	contributionsEnabled: boolean;
	poolEnabled: boolean;
	masterKey: string | undefined;
	maxBodyBytes: number;
};
function booleanSetting(value: string | undefined, name: string) {
	if (value !== undefined && value !== "true" && value !== "false")
		throw new Error(`${name} must be true or false`);
	return value === "true";
}
function resource(value: string | undefined, name: string, local: boolean) {
	if (!value) return null;
	if (
		local &&
		value.startsWith("/") &&
		!value.startsWith("//") &&
		!value.includes("\\")
	)
		return value;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must be a valid HTTPS URL`);
	}
	if (url.protocol !== "https:" || url.username || url.password)
		throw new Error(`${name} must be a credential-free HTTPS URL`);
	return url.href;
}
export function communitySettings(
	env: Record<string, string | undefined> = {},
): CommunitySettings {
	const maxBodyBytes = Number(env.COMMUNITY_MAX_BODY_BYTES ?? 16384);
	if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0)
		throw new Error("COMMUNITY_MAX_BODY_BYTES must be a non-negative integer");
	return {
		joinUrl: resource(
			env.COMMUNITY_WECOM_JOIN_URL,
			"COMMUNITY_WECOM_JOIN_URL",
			false,
		),
		qrUrl: resource(env.COMMUNITY_WECOM_QR_URL, "COMMUNITY_WECOM_QR_URL", true),
		contributionsEnabled: booleanSetting(
			env.JEV_CONTRIBUTIONS_ENABLED,
			"JEV_CONTRIBUTIONS_ENABLED",
		),
		poolEnabled: booleanSetting(env.JEV_CREDENTIAL_POOL, "JEV_CREDENTIAL_POOL"),
		masterKey: env.CREDENTIALS_MASTER_KEY,
		maxBodyBytes,
	};
}
export function publicCommunityConfig(
	settings: CommunitySettings,
	jev: ReturnType<typeof jevConfig>,
): CommunityConfig {
	return {
		joinUrl: settings.joinUrl,
		qrUrl: settings.qrUrl,
		contributionsEnabled: settings.contributionsEnabled,
		poolEnabled: settings.poolEnabled,
		currentProvider: jev.provider,
		maxBodyBytes: settings.maxBodyBytes,
		models: {
			typesafe:
				jev.provider === "typesafe" ? jev.model : JEV_PROVIDERS.typesafe.model,
			openrouter:
				jev.provider === "openrouter"
					? jev.model
					: JEV_PROVIDERS.openrouter.model,
		},
	};
}
