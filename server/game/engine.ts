import { createHash } from "node:crypto";
import type {
	ActionFact,
	Direction,
	GameConfig,
	MatchState,
	Point,
} from "../../shared/snake/types.js";
import { isResponseMode, opposite, vectors } from "../../shared/snake/types.js";
import { GameError } from "../errors.js";

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
	const safe = new Set(
		[...s.snake, ...[1, 2, 3].map((i) => ({ x: x + i, y }))].map(key),
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
	for (const candidate of candidates) {
		if (s.obstacles.length === config.obstacleCount) break;
		const next = [...s.obstacles, candidate];
		if (connected(config, next)) s.obstacles = next;
	}
	if (s.obstacles.length !== config.obstacleCount)
		throw new GameError(
			"invalid_map",
			"Cannot satisfy obstacle count and connectivity",
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
// Shared by live movement and context analysis so body/tail rules stay identical.
export function inspectMove(
	s: Pick<MatchState, "config" | "snake" | "direction" | "obstacles" | "apple">,
	direction: Direction,
): Pick<ActionFact, "target" | "eatsApple" | "immediateCollision"> {
	const from = s.snake[0];
	const v = vectors[direction];
	const target = { x: from.x + v.x, y: from.y + v.y };
	const growing = !!s.apple && equal(target, s.apple);
	const body = growing ? s.snake : s.snake.slice(0, -1);
	const immediateCollision =
		direction === opposite[s.direction]
			? "reverse"
			: target.x < 0 ||
				  target.y < 0 ||
				  target.x >= s.config.width ||
				  target.y >= s.config.height
				? "wall"
				: s.obstacles.some((p) => equal(p, target))
					? "obstacle"
					: body.some((p) => equal(p, target))
						? "body"
						: null;
	return { target, eatsApple: growing, immediateCollision };
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
