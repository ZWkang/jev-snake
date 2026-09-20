import { z } from "zod";

export const watchCommandSchema = z
	.object({
		requestId: z.string().min(1),
		enabled: z.boolean(),
		stopCurrent: z.literal(true).optional(),
	})
	.strict()
	.refine((command) => !command.stopCurrent || !command.enabled, {
		path: ["stopCurrent"],
		message: "Stopping the current match requires disabled scheduling",
	});
export const watchSnapshotSchema = z
	.object({
		channelId: z.literal("main"),
		revision: z.number().int().nonnegative(),
		enabled: z.boolean(),
		phase: z.enum([
			"stopped",
			"starting",
			"running",
			"draining",
			"countdown",
			"fault",
		]),
		currentMatchId: z.string().min(1).nullable(),
		lastMatchId: z.string().min(1).nullable(),
		nextStartAt: z.number().nonnegative().nullable(),
		serverTime: z.number().nonnegative(),
		error: z
			.object({ code: z.string().min(1), message: z.string().min(1) })
			.strict()
			.nullable(),
	})
	.strict()
	.superRefine((s, ctx) => {
		const require = (ok: boolean, message: string) => {
			if (!ok) ctx.addIssue({ code: "custom", message });
		};
		require((s.phase === "countdown") ===
			(s.nextStartAt !== null), "Only countdown has a scheduled start");
		if (["starting", "running", "countdown"].includes(s.phase))
			require(s.enabled, "Active scheduling requires enabled intent");
		if (["stopped", "draining"].includes(s.phase))
			require(!s.enabled, "Stopped scheduling requires disabled intent");
		if (["running", "draining"].includes(s.phase))
			require(s.currentMatchId !== null, "Running phases require a match");
		if (["stopped", "countdown"].includes(s.phase))
			require(s.currentMatchId ===
				null, "Inactive phases cannot own an active match");
		require((s.phase === "fault") ===
			(s.error !== null), "Only fault has a channel error");
	});
export const watchReceiptSchema = z
	.object({
		requestId: z.string().min(1),
		enabled: z.boolean(),
		revision: z.number().int().nonnegative(),
		acceptedAt: z.number().nonnegative(),
	})
	.strict();
export type WatchSnapshot = z.infer<typeof watchSnapshotSchema>;
export type WatchCommand = z.infer<typeof watchCommandSchema>;
export type WatchReceipt = z.infer<typeof watchReceiptSchema>;
export type WatchCommandResult = {
	receipt: WatchReceipt;
	state: WatchSnapshot;
};
export type OwnerSession = { authenticated: boolean; expiresAt: number | null };

export function initialWatchState(now: number): WatchSnapshot {
	return {
		channelId: "main",
		revision: 0,
		enabled: false,
		phase: "stopped",
		currentMatchId: null,
		lastMatchId: null,
		nextStartAt: null,
		serverTime: now,
		error: null,
	};
}
