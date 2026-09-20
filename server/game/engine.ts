import { createHash } from "node:crypto";
import { inspectMove } from "../../shared/snake/move-rules.js";
import type {
	Direction,
	GameConfig,
	MatchState,
	Point,
} from "../../shared/snake/types.js";
import {
	directions,
	isResponseMode,
	vectors,
} from "../../shared/snake/types.js";
import { GameError } from "../errors.js";

export { inspectMove } from "../../shared/snake/move-rules.js";

const key = (p: Point) => `${p.x},${p.y}`;
export const equal = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
function seedNumber(seed: string) {
	let value = 2166136261;
	for (const c of seed) value = Math.imul(value ^ c.charCodeAt(0), 16777619);
	return value >>> 0;
}
function random(s: MatchState) {
	s.rngState = (s.rngState + 0x6d2b79f5) >>> 0;
	let value = s.rngState;
	value = Math.imul(value ^ (value >>> 15), value | 1);
	value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
	return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}
function connected(config: GameConfig, obstacles: Point[]) {
	const occupied = new Set(obstacles.map(key));
	const visited = new Set<string>(["0,0"]);
	const queue: Point[] = [{ x: 0, y: 0 }];
	for (let i = 0; i < queue.length; i++) {
		const p = queue[i];
		for (const v of Object.values(vectors)) {
			const n = { x: p.x + v.x, y: p.y + v.y };
			const k = key(n);
			if (
				n.x < 0 ||
				n.y < 0 ||
				n.x >= config.width ||
				n.y >= config.height ||
				occupied.has(k) ||
				visited.has(k)
			)
				continue;
			visited.add(k);
			queue.push(n);
		}
	}
	return visited.size === config.width * config.height - obstacles.length;
}
function balancedObstacleQuota(
	s: MatchState,
	candidates: Point[],
): [number, number] {
	const total = s.config.width * s.config.height;
	const remaining = total - s.config.obstacleCount;
	const boardColors = [Math.ceil(total / 2), Math.floor(total / 2)];
	const available = [0, 0];
	for (const point of candidates) available[(point.x + point.y) % 2]++;
	const quotas: [number, number][] = [];
	for (const evenCells of new Set([
		Math.floor(remaining / 2),
		Math.ceil(remaining / 2),
	])) {
		const quota: [number, number] = [
			boardColors[0] - evenCells,
			boardColors[1] - (remaining - evenCells),
		];
		if (quota.every((count, color) => count >= 0 && count <= available[color]))
			quotas.push(quota);
	}
	if (!quotas.length)
		throw new GameError(
			"invalid_map",
			"Cannot satisfy obstacle count, checkerboard balance and spawn protection",
		);
	// Every snake body alternates colors. This necessary balance removes some
	// impossible boards; it does not prove that a board can be completed.
	return quotas.length === 1
		? quotas[0]
		: quotas[Math.floor(random(s) * quotas.length)];
}
function free(s: MatchState, includeStar = false): Point[] {
	const occupied = new Set(
		[
			...s.snake,
			...s.obstacles,
			...(s.apple ? [s.apple] : []),
			...(!includeStar && s.star ? [s.star.point] : []),
		].map(key),
	);
	const cells: Point[] = [];
	for (let y = 0; y < s.config.height; y++)
		for (let x = 0; x < s.config.width; x++) {
			if (!occupied.has(`${x},${y}`)) cells.push({ x, y });
		}
	return cells;
}
function placeApple(s: MatchState) {
	let cells = free(s);
	if (cells.length === 0 && s.star) {
		s.star = null;
		cells = free(s);
	}
	if (!cells.length)
		throw new GameError("invalid_board", "No free cell for an apple", 500);
	s.apple = cells[Math.floor(random(s) * cells.length)];
}
export function createState(
	id: string,
	agentName: string,
	model: string | null,
	config: GameConfig,
	createdAt: string,
): MatchState {
	const x = Math.max(3, Math.floor(config.width / 3) - 1);
	const y = Math.floor(config.height / 2);
	const s: MatchState = {
		id,
		agentName,
		model,
		config,
		recordVersion: isResponseMode(config)
			? 3
			: config.decisionMode === "two_step_fallback"
				? 2
				: 1,
		rulesVersion: isResponseMode(config)
			? 3
			: config.decisionMode === "two_step_fallback"
				? 2
				: 1,
		status: "ready",
		createdAt,
		startedAt: null,
		endedAt: null,
		seq: -1,
		tick: 0,
		gameTimeMs: 0,
		...(isResponseMode(config) ? { lastMoveGameTimeMs: 0 } : {}),
		score: 0,
		applesEaten: 0,
		snake: Array.from({ length: 4 }, (_, i) => ({ x: x - i, y })),
		direction: "right",
		obstacles: [],
		apple: null,
		star: null,
		rngState: seedNumber(config.seed),
		pending: [],
		...(config.decisionMode === "two_step_fallback" ? { plans: [] } : {}),
		endReason: null,
		lastDecision: null,
	};
	if (config.layoutVersion === 2 || config.layoutVersion === 3) {
		// Sample headings equally, then sample a head position with room for the
		// four-cell body behind it and three clear cells ahead of it.
		const headings = directions.filter((direction) =>
			vectors[direction].x === 0 ? config.height >= 7 : config.width >= 7,
		);
		if (!headings.length)
			throw new GameError(
				"invalid_map",
				"No room for the initial snake and runway",
			);
		s.direction = headings[Math.floor(random(s) * headings.length)];
		const v = vectors[s.direction];
		const marginX = Math.abs(v.x) * 3;
		const marginY = Math.abs(v.y) * 3;
		const head = {
			x: marginX + Math.floor(random(s) * (config.width - marginX * 2)),
			y: marginY + Math.floor(random(s) * (config.height - marginY * 2)),
		};
		s.snake = Array.from({ length: 4 }, (_, i) => ({
			x: head.x - v.x * i,
			y: head.y - v.y * i,
		}));
	}
	const heading = vectors[s.direction];
	const safe = new Set(
		[
			...s.snake,
			...[1, 2, 3].map((i) => ({
				x: s.snake[0].x + heading.x * i,
				y: s.snake[0].y + heading.y * i,
			})),
		].map(key),
	);
	const candidates: Point[] = [];
	for (let cy = 1; cy < config.height - 1; cy++)
		for (let cx = 1; cx < config.width - 1; cx++) {
			if (!safe.has(`${cx},${cy}`)) candidates.push({ x: cx, y: cy });
		}
	if (config.obstacleCount > candidates.length)
		throw new GameError(
			"invalid_map",
			"Obstacle count exceeds available interior cells",
		);
	for (let i = candidates.length - 1; i > 0; i--) {
		const j = Math.floor(random(s) * (i + 1));
		[candidates[i], candidates[j]] = [candidates[j], candidates[i]];
	}
	const quota =
		config.layoutVersion === 3 ? balancedObstacleQuota(s, candidates) : null;
	const obstacleColors = [0, 0];
	for (const candidate of candidates) {
		if (s.obstacles.length === config.obstacleCount) break;
		const color = (candidate.x + candidate.y) % 2;
		if (quota && obstacleColors[color] === quota[color]) continue;
		const next = [...s.obstacles, candidate];
		if (connected(config, next)) {
			s.obstacles = next;
			obstacleColors[color]++;
		}
	}
	if (s.obstacles.length !== config.obstacleCount)
		throw new GameError(
			"invalid_map",
			config.layoutVersion === 3
				? "Cannot satisfy obstacle count, checkerboard balance and connectivity"
				: "Cannot satisfy obstacle count and connectivity",
		);
	placeApple(s);
	return s;
}
export function expireStar(s: MatchState, at: number) {
	if (s.star && s.star.expiresAt <= at) {
		s.star = null;
		return true;
	}
	return false;
}
export function move(
	s: MatchState,
	direction: Direction,
): { type: string; data: Record<string, unknown> } {
	const {
		target,
		eatsApple: growing,
		immediateCollision,
	} = inspectMove(s, direction);
	if (immediateCollision === "reverse")
		throw new GameError("invalid_direction", "Direct reversal is not allowed");
	const reason = immediateCollision === "body" ? "self" : immediateCollision;
	s.tick++;
	if (reason) {
		s.status = "gameover";
		s.endReason = reason;
		return {
			type: "gameover",
			data: { reason, attemptedDirection: direction, target },
		};
	}
	s.direction = direction;
	s.snake.unshift(target);
	if (!growing) s.snake.pop();
	let type = "move";
	let points = 0;
	if (growing) {
		s.score += 10;
		points = 10;
		s.applesEaten++;
		s.apple = null;
		type = "apple";
		if (
			s.snake.length ===
			s.config.width * s.config.height - s.obstacles.length
		) {
			s.status = "won";
			s.endReason = "board_complete";
			s.star = null;
			return { type: "won", data: { points, grew: true } };
		}
		placeApple(s);
		if (s.applesEaten % 5 === 0 && !s.star) {
			const cells = free(s);
			if (cells.length)
				s.star = {
					point: cells[Math.floor(random(s) * cells.length)],
					expiresAt: s.gameTimeMs + 8000,
				};
		}
	} else if (s.star && equal(target, s.star.point)) {
		s.star = null;
		s.score += 30;
		points = 30;
		type = "star";
	}
	return { type, data: { direction, points, grew: growing } };
}
export function stateHash(s: MatchState): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				tick: s.tick,
				status: s.status,
				snake: s.snake,
				direction: s.direction,
				obstacles: s.obstacles,
				apple: s.apple,
				star: s.star,
				score: s.score,
				config: s.config,
				rngState: s.rngState,
			}),
		)
		.digest("hex");
}
