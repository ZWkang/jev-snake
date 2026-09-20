export const stagnationStopReasons = [
	"stagnation_loop",
	"stagnation_no_apple",
] as const;

export type StagnationStopReason = (typeof stagnationStopReasons)[number];

export type StagnationSettings = {
	enabled: boolean;
	maxPositionVisits: number;
	/** null uses max(64, 2 * traversableCells). */
	maxMovesWithoutApple: number | null;
};

export type StagnationEvidence = {
	reason: StagnationStopReason;
	observedTick: number;
	movesSinceApple: number;
	positionVisits: number;
	maxPositionVisits: number;
	maxMovesWithoutApple: number;
};

export function isStagnationStopReason(
	value: string | null,
): value is StagnationStopReason {
	return value === "stagnation_loop" || value === "stagnation_no_apple";
}

export function stagnationMessage(reason: StagnationStopReason): string {
	return reason === "stagnation_loop"
		? "费用保护：检测到同一完整局面反复无果返回，已暂停本局及连续开局，等待手动恢复。"
		: "连续未吃苹果保护：本局已结束；连续观战开启时会自动开始下一局。";
}
