import { expect, test } from "vitest";
import {
	continuationDeathProof,
	type ContinuationDeathProof,
} from "../server/jev/branch-death.js";
import { decisionBodyV4 as decisionBody } from "../server/jev/client.js";
import { advanceGeometry } from "../server/jev/context-v3.js";
import {
	summarizeContinuationProof,
	trapInstructions,
} from "../server/jev/trap-evidence.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import type { Direction, PublicState } from "../shared/snake/types.js";
import replay from "./fixtures/multilevel-branch-trap.json" with { type: "json" };

test("a nested certificate becomes a bounded-size first-junction summary without losing its bound", () => {
	const state = replay.state as PublicState;
	const proof = continuationDeathProof(advanceGeometry(state, "left"));
	expect(proof).not.toBeNull();
	if (!proof) throw new Error("Missing expected certificate");
	const before = structuredClone(proof),
		summary = summarizeContinuationProof(proof);
	expect(summary.collisionWithinMoves).toBe(proof.collisionWithinMoves);
	expect(summary.branchHead).toEqual(proof.branchHead);
	expect(summary.certificateNodes).toBeGreaterThan(1);
	expect(
		summary.branches.map((b) => [b.direction, b.collisionWithinMoves]),
	).toEqual(proof.branches.map((b) => [b.direction, b.collisionWithinMoves]));
	expect(summary.branches.every((b) => !("proof" in b))).toBe(true);
	expect(JSON.stringify(summary).length).toBeLessThan(
		JSON.stringify(proof).length,
	);
	expect(proof).toEqual(before);
	expect(trapInstructions(state)).toContain('"certificateNodes":');
});

test("the model gets distinguishing facts while keeping its strategy and full option set", () => {
	const request = decisionBody(replay.state as PublicState);
	expect(request.questions.direction.criteria.left.danger).toBe("proven_fatal");
	expect(request.questions.direction.criteria.up.danger).toBeNull();
	expect(Object.keys(request.questions.direction.criteria)).toEqual([
		"up",
		"right",
		"down",
		"left",
	]);
	expect(request.questions.direction.instructions).toContain(
		"Decide your strategy",
	);
	expect(request.questions.direction.instructions).not.toMatch(
		/prefer an UNTRIED|First compare danger|prefer fewer/,
	);
	expect(decisionRequestSchema.parse(request)).toEqual(request);
});

function branch(direction: Direction, proof: ContinuationDeathProof) {
	return {
		direction,
		collisionWithinMoves: 1 + proof.collisionWithinMoves,
		proof: { kind: "continuation" as const, ...proof },
	};
}

function proofDag(depth: number): ContinuationDeathProof {
	let proof: ContinuationDeathProof = {
		collisionWithinMoves: 1,
		forcedPrefixMoves: 0,
		branchHead: { x: 0, y: 0 },
		branches: [],
	};
	for (let i = 0; i < depth; i++)
		proof = {
			collisionWithinMoves: 1 + proof.collisionWithinMoves,
			forcedPrefixMoves: 0,
			branchHead: { x: 0, y: i + 1 },
			// The analyzer spreads cached proof roots but shares their child arrays.
			branches: [branch("up", proof), branch("right", proof)],
		};
	return proof;
}

test("shared certificate DAG preserves expanded counts without rewalking every path", () => {
	const proof = proofDag(40);
	const summary = summarizeContinuationProof(proof);
	expect(summary.certificateNodes).toBe(2 ** 41 - 1);
	expect(summary.certifiedExits).toBe(2 ** 41 - 2);
	expect(summary.branches).toEqual([
		{ direction: "up", collisionWithinMoves: 41, proofKind: "continuation" },
		{ direction: "right", collisionWithinMoves: 41, proofKind: "continuation" },
	]);
	expect(proof.branches[0].proof).not.toBe(proof.branches[1].proof);
	if (
		proof.branches[0].proof.kind !== "continuation" ||
		proof.branches[1].proof.kind !== "continuation"
	)
		throw new Error("Expected shared continuation branches");
	expect(proof.branches[0].proof.branches).toBe(
		proof.branches[1].proof.branches,
	);
});

test("proof counting supports deep chains without overflowing the call stack", () => {
	let proof = proofDag(0);
	for (let i = 0; i < 20000; i++)
		proof = {
			collisionWithinMoves: i + 2,
			forcedPrefixMoves: 0,
			branchHead: { x: 0, y: i + 1 },
			branches: [branch("up", proof)],
		};
	expect(summarizeContinuationProof(proof)).toMatchObject({
		certificateNodes: 20001,
		certifiedExits: 20000,
	});
});

test("unrepresentable expanded counts fail explicitly instead of silently rounding", () => {
	expect(summarizeContinuationProof(proofDag(52))).toMatchObject({
		certificateNodes: Number.MAX_SAFE_INTEGER,
		certifiedExits: Number.MAX_SAFE_INTEGER - 1,
	});
	expect(() => summarizeContinuationProof(proofDag(53))).toThrow(
		"Continuation proof counts exceed safe integer precision",
	);
});

test("a cyclic object cannot be summarized as a finite death certificate", () => {
	const proof = proofDag(0);
	proof.branches.push(branch("up", proof));
	expect(() => summarizeContinuationProof(proof)).toThrow(
		"Continuation proof contains a cycle",
	);
});
