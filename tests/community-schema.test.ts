import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import {
	contributionInputSchema,
	contributionReceiptSchema,
	feedbackInputSchema,
	feedbackSchema,
	visibilityInputSchema,
} from "../shared/snake/community.js";

test("public inputs require explicit consent and do not accept identity or control fields", () => {
	const base = {
		requestId: randomUUID(),
		provider: "typesafe",
		apiKey: "test-key",
		consent: true,
		consentVersion: "watch-keys-v1",
	};
	expect(contributionInputSchema.parse(base).provider).toBe("typesafe");
	for (const change of [
		{ consent: false },
		{ consent: undefined },
		{ provider: "typeless" },
		{ admin: true },
		{ apiKey: "  " },
	])
		expect(
			contributionInputSchema.safeParse({ ...base, ...change }).success,
		).toBe(false);
	expect(
		feedbackInputSchema.parse({ requestId: randomUUID(), body: " 意见 " }).body,
	).toBe("意见");
	for (const body of ["", " \n "])
		expect(
			feedbackInputSchema.safeParse({ requestId: randomUUID(), body }).success,
		).toBe(false);
	expect(
		feedbackInputSchema.safeParse({
			requestId: randomUUID(),
			body: "意见",
			name: "author",
		}).success,
	).toBe(false);
	expect(
		visibilityInputSchema.safeParse({ requestId: randomUUID(), toggle: true })
			.success,
	).toBe(false);
});
test("public DTOs reject secrets and author identity", () => {
	const feedback = {
		id: randomUUID(),
		body: "意见",
		createdAt: new Date().toISOString(),
	};
	expect(feedbackSchema.parse(feedback)).toEqual(feedback);
	expect(
		feedbackSchema.safeParse({ ...feedback, author: "user" }).success,
	).toBe(false);
	const receipt = {
		requestId: randomUUID(),
		provider: "openrouter",
		model: "jev",
		status: "enabled",
		created: true,
		verifiedAt: null,
		error: null,
	};
	for (const field of ["apiKey", "fingerprint", "ciphertext", "credentialRef"])
		expect(
			contributionReceiptSchema.safeParse({ ...receipt, [field]: "secret" })
				.success,
		).toBe(false);
});
