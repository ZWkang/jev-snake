import type { Point } from "../../../shared/snake/types";

export type SnakeGeometry = {
	/** SVG pixel centers, in the same order as the supplied points. */
	points: Point[];
	path: string;
	length: number;
	head: Point;
	tail: Point;
};

export type SnakeColorBand = SnakeGeometry & {
	index: number;
	fromDistance: number;
	toDistance: number;
};

const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const distance = (a: Point, b: Point) =>
	Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const pixelCenter = (point: Point, cellSize: number) => ({
	x: (point.x + 0.5) * cellSize,
	y: (point.y + 0.5) * cellSize,
});

function validCellSize(cellSize: number) {
	if (!Number.isFinite(cellSize) || cellSize <= 0)
		throw new Error("Snake cell size must be finite and positive");
}

function inspectPoints(points: readonly Point[]): number {
	if (points.length === 0) throw new Error("Snake geometry requires a point");
	let length = 0;
	for (let index = 0; index < points.length; index++) {
		const point = points[index];
		if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
			throw new Error("Snake geometry coordinates must be finite");
		if (index === 0) continue;
		const previous = points[index - 1];
		if (previous.x !== point.x && previous.y !== point.y)
			throw new Error("Snake centerline must follow orthogonal segments");
		length += distance(previous, point);
	}
	return length;
}

/** Keep every supplied vertex. SVG round joins round the stroke, not the route. */
export function snakeGeometryFromPoints(
	points: readonly Point[],
): SnakeGeometry {
	const length = inspectPoints(points);
	const copies = points.map((point) => ({ ...point }));
	const head = copies[0];
	const tail = copies[copies.length - 1];
	const path = copies
		.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`)
		.join(" ");
	return {
		points: copies,
		// A zero-length line still permits a round SVG cap for a one-cell snake.
		path: copies.length === 1 ? `${path} L${head.x} ${head.y}` : path,
		length,
		head,
		tail,
	};
}

export function snakeGeometry(
	bodyHeadToTail: readonly Point[],
	cellSize = 32,
): SnakeGeometry {
	validCellSize(cellSize);
	return snakeGeometryFromPoints(
		bodyHeadToTail.map((point) => pixelCenter(point, cellSize)),
	);
}

function pointAtDistance(
	points: readonly Point[],
	amount: number,
	length: number,
): Point {
	if (amount <= 0) return { ...points[0] };
	if (amount >= length) return { ...points[points.length - 1] };
	let traveled = 0;
	for (let index = 1; index < points.length; index++) {
		const start = points[index - 1];
		const end = points[index];
		const segment = distance(start, end);
		if (segment === 0) continue;
		if (traveled + segment >= amount) {
			const fraction = (amount - traveled) / segment;
			return {
				x: start.x + (end.x - start.x) * fraction,
				y: start.y + (end.y - start.y) * fraction,
			};
		}
		traveled += segment;
	}
	return { ...points[points.length - 1] };
}

/** Distance is in pixels along the supplied route, clamped to its endpoints. */
export function pointOnSnake(points: readonly Point[], amount: number): Point {
	if (!Number.isFinite(amount))
		throw new Error("Snake path distance must be finite");
	return pointAtDistance(points, amount, inspectPoints(points));
}

/** Cut along the route without replacing its corners by diagonals. */
export function sliceSnakePath(
	points: readonly Point[],
	fromDistance: number,
	toDistance: number,
): SnakeGeometry {
	if (
		!Number.isFinite(fromDistance) ||
		!Number.isFinite(toDistance) ||
		fromDistance > toDistance
	)
		throw new Error("Snake path slice requires finite, increasing distances");
	const length = inspectPoints(points);
	const start = Math.max(0, Math.min(length, fromDistance));
	const end = Math.max(0, Math.min(length, toDistance));
	const sliced = [pointAtDistance(points, start, length)];
	let traveled = 0;
	for (let index = 1; index < points.length; index++) {
		traveled += distance(points[index - 1], points[index]);
		if (traveled > start && traveled < end) sliced.push({ ...points[index] });
	}
	const last = pointAtDistance(points, end, length);
	if (!samePoint(sliced[sliced.length - 1], last)) sliced.push(last);
	return snakeGeometryFromPoints(sliced);
}

function contiguousBody(body: readonly Point[]): boolean {
	return (
		body.length > 0 &&
		body.every(
			(point, index) =>
				Number.isInteger(point.x) &&
				Number.isInteger(point.y) &&
				(index === 0 || distance(body[index - 1], point) === 1),
		)
	);
}

/** Visual eligibility only; it neither decides nor validates a game action. */
export function canInterpolateSnakeMove(
	from: readonly Point[],
	to: readonly Point[],
): boolean {
	return (
		contiguousBody(from) &&
		contiguousBody(to) &&
		(to.length === from.length || to.length === from.length + 1) &&
		distance(from[0], to[0]) === 1 &&
		to.slice(1).every((point, index) => samePoint(point, from[index]))
	);
}

/** Move a window along tail -> old head -> new head, preserving each corner. */
export function interpolateSnakeGeometry(
	from: readonly Point[],
	to: readonly Point[],
	progress: number,
	cellSize = 32,
): SnakeGeometry {
	validCellSize(cellSize);
	if (!Number.isFinite(progress) || progress < 0 || progress > 1)
		throw new Error("Snake movement progress must be between zero and one");
	if (!canInterpolateSnakeMove(from, to))
		throw new Error("Snake interpolation requires one continuous move");
	const trace = [...from]
		.reverse()
		.concat(to[0])
		.map((point) => pixelCenter(point, cellSize));
	const oldLength = (from.length - 1) * cellSize;
	const headDistance = oldLength + progress * cellSize;
	const tailDistance = to.length > from.length ? 0 : progress * cellSize;
	return snakeGeometryFromPoints(
		sliceSnakePath(trace, tailDistance, headDistance).points.reverse(),
	);
}

/** Full-cell arc intervals for matching endpoint gradients, with no per-band outline. */
export function snakeColorBands(
	geometry: SnakeGeometry,
	cellSize = 32,
): SnakeColorBand[] {
	validCellSize(cellSize);
	if (geometry.length === 0)
		return [
			{
				...snakeGeometryFromPoints(geometry.points),
				index: 0,
				fromDistance: 0,
				toDistance: 0,
			},
		];
	const bands: SnakeColorBand[] = [];
	for (let index = 0; ; index++) {
		const fromDistance = index * cellSize;
		if (fromDistance >= geometry.length) break;
		const toDistance = Math.min(geometry.length, (index + 1) * cellSize);
		bands.push({
			...sliceSnakePath(geometry.points, fromDistance, toDistance),
			index,
			fromDistance,
			toDistance,
		});
	}
	return bands;
}
