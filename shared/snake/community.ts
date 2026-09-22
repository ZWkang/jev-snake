import { z } from "zod";

export const communityProviderSchema = z.enum(["typesafe", "openrouter"]);
export type CommunityProvider = z.infer<typeof communityProviderSchema>;
export const contributionConsentVersion = "watch-keys-v1";
const requestId = z.uuid();
const secret = z.string().trim().min(1);
export const feedbackInputSchema = z
	.object({ requestId, body: z.string().trim().min(1) })
	.strict();
export const visibilityInputSchema = z
	.object({ requestId, visible: z.boolean() })
	.strict();
export const contributionInputSchema = z
	.object({
		requestId,
		provider: communityProviderSchema,
		apiKey: secret,
		consent: z.literal(true),
		consentVersion: z.literal(contributionConsentVersion),
	})
	.strict();
export const contributionStatusInputSchema = z.object({ requestId }).strict();
export const revokeInputSchema = z
	.object({ requestId, provider: communityProviderSchema, apiKey: secret })
	.strict();
export const credentialCommandSchema = z
	.object({ requestId, action: z.enum(["disable", "revalidate-and-enable"]) })
	.strict();
export const communityErrorSchema = z
	.object({ code: z.string(), message: z.string() })
	.strict();
export const feedbackSchema = z
	.object({ id: z.uuid(), body: z.string(), createdAt: z.string() })
	.strict();
export const feedbackPageSchema = z
	.object({ items: z.array(feedbackSchema), nextCursor: z.string().nullable() })
	.strict();
export const contributionReceiptSchema = z
	.object({
		requestId,
		provider: communityProviderSchema,
		model: z.string(),
		status: z.enum([
			"validating",
			"enabled",
			"failed",
			"unconfirmed",
			"disabled",
			"revoked",
		]),
		created: z.boolean(),
		verifiedAt: z.string().nullable(),
		error: communityErrorSchema.nullable(),
	})
	.strict();
export const communityConfigSchema = z
	.object({
		joinUrl: z.string().nullable(),
		qrUrl: z.string().nullable(),
		contributionsEnabled: z.boolean(),
		poolEnabled: z.boolean(),
		currentProvider: communityProviderSchema,
		models: z.object({ typesafe: z.string(), openrouter: z.string() }).strict(),
		maxBodyBytes: z.number().int().nonnegative(),
	})
	.strict();
export type Feedback = z.infer<typeof feedbackSchema>;
export type FeedbackPage = z.infer<typeof feedbackPageSchema>;
export type AdminFeedback = Feedback & { visible: boolean };
export type ContributionInput = z.infer<typeof contributionInputSchema>;
export type ContributionReceipt = z.infer<typeof contributionReceiptSchema>;
export type CommunityConfig = z.infer<typeof communityConfigSchema>;
export type CommunityError = z.infer<typeof communityErrorSchema>;
export type CredentialStatus =
	| "unconfirmed"
	| "enabled"
	| "disabled"
	| "unusable"
	| "revoked";
export type AdminCredential = {
	id: string;
	provider: CommunityProvider;
	model: string;
	maskedKey: string;
	status: CredentialStatus;
	createdAt: string;
	verifiedAt: string | null;
	lastUsedAt: string | null;
	watchCalls: number;
	validationCalls: number;
	inputTokens: number | null;
	currentPool: boolean;
	lastError: CommunityError | null;
	lastSwitchReason: string | null;
};
