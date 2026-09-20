import type { DecisionRequestV12 } from "./non-reverse.js";
import type { Direction, Point } from "./types.js";

export type MoveExclusion = "reverse" | "wall" | "obstacle" | "body";

/** One legal move, then a static view. No route search or future food sampling. */
export type LegalSpaceMoveFacts = {
	target: Point;
	turn: "straight" | "left turn" | "right turn";
	eatsApple: boolean;
	eatsStar: boolean;
	appleDistance: number | null;
	lengthAfter: number;
	freeCellsAfter: number;
	reachableFreeCells: number;
	canReachTail: boolean | null;
	nextLegalMoveCount: number | null;
	deadEndRisk: boolean;
	terminal: "board_complete" | null;
};

export type LegalSpaceInput = {
	width: number;
	height: number;
	bodyHeadToTail: readonly Point[];
	direction: Direction;
	obstacles: readonly Point[];
	apple: Point | null;
	star: Point | null;
};

export type LegalSpaceAnalysis = {
	moveFacts: Partial<Record<Direction, LegalSpaceMoveFacts>>;
	excludedMoves: Partial<Record<Direction, MoveExclusion>>;
};

export type DecisionRequestV13 = {
	model: string;
	state: Omit<DecisionRequestV12["state"], "contextVersion" | "strategyGuide"> &
		LegalSpaceAnalysis & {
			contextVersion: "legal-space-v13";
			factsSemantics: string;
		};
	questions: {
		direction: {
			type: "choice";
			instructions: string;
			criteria: Partial<Record<Direction, string>>;
		};
	};
};
