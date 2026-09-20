import type { DecisionProgress, Direction, Point } from "./types.js";

export type DecisionRequestV6 = {
	model: string;
	state: {
		contextVersion: "board-state-v6";
		rules: {
			objective: string;
			applePoints: number;
			starPoints: number;
			coordinates: string;
			mechanics: string;
		};
		board: { width: number; height: number; obstacles: Point[] };
		player: {
			bodyHeadToTail: Point[];
			direction: Direction;
			score: number;
			applesEaten: number;
		};
		food: {
			apple: Point | null;
			star: { point: Point; expiresAt: number } | null;
		};
		timing: {
			stateIsProjected: false;
			stepMode: "response";
			observedTick: number;
			targetTick: number;
			gameTimeMs: number;
			tickIntervalMs: null;
			deadlineInMs: null;
		};
		progress?: DecisionProgress;
	};
	questions: {
		direction: {
			type: "choice";
			instructions: string;
			criteria: Record<Direction, { meaning: string }>;
		};
	};
};
