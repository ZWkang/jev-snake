import type { ActionFact, Direction, Point } from "./types.js";

// All move counts begin at the observed state and include the candidate move.
// These are existence witnesses, never instructions or a ranking of actions.
export type ReleasePassage = {
	point: Point;
	originalBodyIndex: number;
	// Fastest possible release without growth; the actual route is replayed too.
	earliestReleaseStep: number;
	enteredAtStep: number;
};

export type PositiveGeometry = {
	snake: Point[];
	direction: Direction;
	// null at an apple endpoint means future food is unknown, not absent in play.
	apple: Point | null;
};

export type AppleWitness = {
	directions: Direction[];
	end: PositiveGeometry;
	releasePassages: ReleasePassage[];
};

export type CycleWitness = {
	// Includes the candidate. The cycle begins after this prefix.
	prefixDirections: Direction[];
	cycleDirections: Direction[];
	cycleStart: PositiveGeometry;
	end: PositiveGeometry;
	releasePassages: ReleasePassage[];
};

export type PositiveEvidence =
	| {
			status: "initial_collision";
			collision: NonNullable<ActionFact["immediateCollision"]>;
	  }
	| {
			status: "apple_eaten_now" | "apple_route_found";
			source: "direct" | "static_candidate" | "dynamic_search";
			witness: AppleWitness;
			terminal: "board_complete" | "none";
	  }
	| {
			status: "non_growth_cycle";
			// A cycle does not imply the observed apple is unreachable. Search stops
			// at this witness; other branches may reach the apple.
			witness: CycleWitness;
	  }
	| {
			status: "exhausted";
			// Every reachable complete geometry was explored, with no apple/cycle.
			searchedStates: number;
	  };
