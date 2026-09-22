export class CommunityHttpError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string,
	) {
		super(message);
	}
}
export async function communityApi<T>(
	path: string,
	body?: unknown,
): Promise<T> {
	const response = await fetch(`/api${path}`, {
		method: body === undefined ? "GET" : "POST",
		credentials: "same-origin",
		headers: body === undefined ? {} : { "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	let result;
	try {
		result = await response.json();
	} catch {
		throw new CommunityHttpError(
			`服务返回了无法读取的响应（${response.status}）`,
			response.status,
			"invalid_response",
		);
	}
	if (!response.ok)
		throw new CommunityHttpError(
			result.error?.message ?? `请求失败（${response.status}）`,
			response.status,
			result.error?.code ?? "request_failed",
		);
	return result as T;
}
export const communityErrorMessage = (error: unknown) =>
	error instanceof Error ? error.message : "请求未完成，请检查连接";
