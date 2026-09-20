import type { Point, PublicState } from "../../../shared/snake/types";
import {
	canInterpolateSnakeMove,
	sliceSnakePath,
	snakeGeometry,
	snakeGeometryFromPoints,
	type SnakeGeometry,
} from "./snakeGeometry";

type Tween = {
	fromHead: number;
	fromTail: number;
	started: number;
	duration: number;
	progress: number;
};

/** Visual time only; the committed game state never waits for this duration. */
export function motionDuration(
	state: Pick<PublicState, "lastStepDurationMs"> & {
		config?: Pick<PublicState["config"], "stepMode" | "tickIntervalMs">;
	},
	playbackRate = 1,
): number {
	if (!Number.isFinite(playbackRate) || playbackRate <= 0)
		throw new RangeError("Playback rate must be finite and positive");
	const observed = state.lastStepDurationMs;
	const fixedInterval =
		state.config?.stepMode !== "response" ? state.config?.tickIntervalMs : null;
	const step =
		observed !== undefined && Number.isFinite(observed) && observed > 0
			? observed
			: typeof fixedInterval === "number" &&
				  Number.isFinite(fixedInterval) &&
				  fixedInterval > 0
				? fixedInterval
				: null;
	const duration = step === null ? 220 : step * 0.8;
	return Math.min(220, duration) / playbackRate;
}

/**
 * A visual head and tail travel along the actual orthogonal movement trace.
 * Retargeting preserves unfinished corners rather than lerping across them.
 * No timers, game rules, predictions or authoritative state mutations live here.
 */
export class SnakeMotion {
	private body: Point[] = [];
	private trace: Point[] = [];
	private renderHead = 0;
	private renderTail = 0;
	private targetHead = 0;
	private targetTail = 0;
	private tween: Tween | null = null;

	constructor(
		body: readonly Point[],
		private readonly cellSize = 32,
	) {
		this.snap(body);
	}

	get isAnimating(): boolean {
		return this.tween !== null;
	}

	snap(body: readonly Point[]): void {
		const geometry = snakeGeometry(body, this.cellSize);
		this.body = body.map((point) => ({ ...point }));
		this.trace = geometry.points.slice().reverse();
		this.renderHead = this.targetHead = geometry.length;
		this.renderTail = this.targetTail = 0;
		this.tween = null;
	}

	sample(now: number): SnakeGeometry {
		const tween = this.tween;
		if (tween) {
			const progress = Math.max(
				tween.progress,
				Math.min(1, Math.max(0, (now - tween.started) / tween.duration)),
			);
			tween.progress = progress;
			const eased = 1 - (1 - progress) ** 3;
			this.renderHead =
				tween.fromHead + (this.targetHead - tween.fromHead) * eased;
			this.renderTail =
				tween.fromTail + (this.targetTail - tween.fromTail) * eased;
			if (progress === 1) this.snap(this.body);
		}
		const visible = sliceSnakePath(
			this.trace,
			this.renderTail,
			this.renderHead,
		);
		return snakeGeometryFromPoints(visible.points.slice().reverse());
	}

	move(
		fromBody: readonly Point[],
		toBody: readonly Point[],
		now: number,
		duration: number,
	): void {
		this.sample(now);
		const matchesPrevious =
			fromBody.length === this.body.length &&
			fromBody.every(
				(point, index) =>
					point.x === this.body[index].x && point.y === this.body[index].y,
			);
		// Seeks, missing movement frames and a zero-duration request deliberately
		// land at the committed pose instead of inventing intermediate movement.
		if (
			!matchesPrevious ||
			!canInterpolateSnakeMove(fromBody, toBody) ||
			duration <= 0
		) {
			this.snap(toBody);
			return;
		}
		if (!Number.isFinite(duration))
			throw new RangeError("Animation duration must be finite");

		// Retire only already-passed trace. Continuous fast events can otherwise
		// retain an entire match even though the visual lag stays under a cell.
		const retired = Math.max(0, this.renderTail);
		const remaining = sliceSnakePath(
			this.trace,
			retired,
			snakeGeometryFromPoints(this.trace).length,
		);
		// Slice to the measured endpoint, not the accumulated scalar: a tiny
		// rounding deficit could otherwise truncate the exact corner before a turn.
		this.trace = remaining.points;
		this.renderHead = Math.min(remaining.length, this.renderHead - retired);
		this.targetHead = remaining.length;
		this.targetTail -= retired;
		this.renderTail = 0;
		this.trace.push({
			x: (toBody[0].x + 0.5) * this.cellSize,
			y: (toBody[0].y + 0.5) * this.cellSize,
		});
		this.targetHead += this.cellSize;
		this.targetTail = this.targetHead - (toBody.length - 1) * this.cellSize;
		this.body = toBody.map((point) => ({ ...point }));
		this.tween = {
			fromHead: this.renderHead,
			fromTail: this.renderTail,
			started: now,
			duration,
			progress: 0,
		};
	}
}
