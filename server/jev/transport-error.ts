import type {
	CommunityError,
	CommunityProvider,
} from "../../shared/snake/community.js";

export type ProviderFailure =
	| "invalid_key"
	| "exhausted"
	| "rate_limited"
	| "temporary_budget"
	| "forbidden"
	| "invalid_response"
	| "unoffered_choice"
	| "invalid_probabilities"
	| "network_error"
	| "invalid_request"
	| "upstream_error";
const descriptions: Record<ProviderFailure, string> = {
	invalid_key: "模型 Key 无效或已停用",
	exhausted: "模型账户或 Key 余额不足",
	rate_limited: "模型服务限流，请稍后由管理员恢复",
	temporary_budget: "模型服务临时预算限制，请稍后由管理员恢复",
	forbidden: "没有所需模型权限或请求被服务商策略拒绝",
	invalid_response: "Invalid JEV decision response: 模型响应格式不正确",
	network_error: "模型服务网络请求失败",
	unoffered_choice:
		"Invalid JEV decision response: chosen direction was not offered in this request",
	invalid_probabilities:
		"Invalid JEV decision response: probabilities must cover exactly the offered directions",
	invalid_request: "模型服务拒绝了请求格式",
	upstream_error: "模型服务返回未确认的错误",
};
export class ProviderError extends Error {
	readonly rotate: boolean;
	constructor(
		readonly provider: CommunityProvider,
		readonly kind: ProviderFailure,
		readonly httpStatus: number | null = null,
		readonly networkCode?: string,
	) {
		super(
			`${provider}${httpStatus === null ? "" : ` API returned HTTP ${httpStatus}`}: ${descriptions[kind]}${networkCode ? ` (${networkCode})` : ""}`,
		);
		this.name = "ProviderError";
		if (networkCode) this.cause = { code: networkCode };
		this.rotate = kind === "invalid_key" || kind === "exhausted";
	}
}
function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
export function providerHttpError(
	provider: CommunityProvider,
	response: Response,
	body: unknown,
): ProviderError {
	const status = response.status,
		error = object(object(body)?.error),
		metadata = object(error?.metadata);
	let kind: ProviderFailure = "upstream_error";
	if (
		status === 401 &&
		(provider === "typesafe" ||
			(!metadata?.provider_name &&
				!metadata?.provider_code &&
				error?.code === 401))
	)
		kind = "invalid_key";
	else if (status === 402 && provider === "openrouter") {
		if (
			response.headers.has("retry-after") ||
			metadata?.limit_source === "openrouter_in_flight_budget"
		)
			kind = "temporary_budget";
		// Only accept an explicit account/key credit failure, not arbitrary 402 policy errors.
		else if (
			error?.code === 402 &&
			!metadata?.provider_name &&
			!metadata?.limit_source &&
			typeof error?.message === "string" &&
			/^(insufficient credits\b|your (account|api key) has insufficient credits\b)/i.test(
				error.message,
			)
		)
			kind = "exhausted";
	} else if (status === 403) kind = "forbidden";
	else if (status === 429) kind = "rate_limited";
	else if (status === 400 || status === 422) kind = "invalid_request";
	return new ProviderError(provider, kind, status);
}
export function providerPublicError(error: unknown): CommunityError {
	return error instanceof ProviderError
		? { code: error.kind, message: error.message }
		: {
				code: "verification_failed",
				message: "验证未完成，请查看服务端状态后显式重试",
			};
}

const networkCodes = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"ENOTFOUND",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"CERT_HAS_EXPIRED",
	"UNKNOWN_CERTIFICATE_VERIFICATION_ERROR",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
]);
export function networkError(provider: CommunityProvider, error: unknown) {
	const code = object(error)?.code ?? object(object(error)?.cause)?.code;
	return new ProviderError(
		provider,
		"network_error",
		null,
		typeof code === "string" && networkCodes.has(code) ? code : undefined,
	);
}
