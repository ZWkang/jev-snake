import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import {
	communitySettings,
	publicCommunityConfig,
} from "../server/community/config.js";
import { CredentialService } from "../server/credentials/service.js";
import { Store } from "../server/db/store.js";
import { jevConfig } from "../server/jev/config.js";

export function decisionResponse(init?: RequestInit, model?: string) {
	const request = JSON.parse(init?.body as string),
		offered = Object.keys(request.questions.direction.criteria);
	return Response.json({
		model: model ?? request.model,
		answers: {
			direction: {
				type: "choice",
				choice: offered[0],
				probabilities: Object.fromEntries(
					offered.map((key, i) => [key, i === 0 ? 1 : 0]),
				),
				confidence: 1,
			},
		},
		usage: { input_tokens: 17 },
	});
}
export const validTransport = () =>
	vi
		.fn<typeof fetch>()
		.mockImplementation(async (_url, init) => decisionResponse(init));
export function credentialFixture(transport: typeof fetch = validTransport()) {
	const directory = mkdtempSync(join(tmpdir(), "credential-test-")),
		store = new Store(join(directory, "snake.sqlite"));
	const settings = communitySettings({
		JEV_CONTRIBUTIONS_ENABLED: "true",
		JEV_CREDENTIAL_POOL: "true",
		CREDENTIALS_MASTER_KEY: randomBytes(32).toString("base64"),
	});
	const jev = jevConfig({}),
		config = publicCommunityConfig(settings, jev),
		service = new CredentialService(store.db, settings, config, transport);
	return {
		store,
		service,
		settings,
		config,
		jev,
		async close() {
			await service.close();
			store.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}
