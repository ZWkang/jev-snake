export function gameClient(root: string) {
	return async function request<T>(
		path: string,
		token: string,
		body?: unknown,
	): Promise<T> {
		const response = await fetch(root + path, {
			method: body ? "POST" : "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		let data: T & { error?: { code: string; message: string } };
		try {
			data = await response.json();
		} catch {
			throw new Error(
				`Game server HTTP ${response.status} returned invalid JSON for ${path}`,
			);
		}
		if (!response.ok)
			throw Object.assign(
				new Error(data.error?.message ?? `Game server HTTP ${response.status}`),
				{ code: data.error?.code },
			);
		return data;
	};
}
