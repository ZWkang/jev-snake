export type ElapsedSample = {
	elapsedGameTimeMs: number;
	receivedAt: number;
};

// Only display time advances here. Authoritative positions and rewards remain
// those of the most recent committed server event.
export function elapsedAt(sample: ElapsedSample, now: number) {
	return sample.elapsedGameTimeMs + Math.max(0, now - sample.receivedAt);
}

export function playbackTimeAt(
	baseTime: number,
	elapsedMs: number,
	rate: number,
	endTime: number,
) {
	return Math.min(endTime, baseTime + elapsedMs * rate);
}
