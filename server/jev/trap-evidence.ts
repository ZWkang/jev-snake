import { directions, type PublicState } from "../../shared/snake/types.js";
import { inspectMove } from "../game/engine.js";
import {
	type ContinuationDeathProof,
	createDeathAnalyzer,
	type DeathAnalyzer,
} from "./branch-death.js";
import { advanceGeometry } from "./context-v3.js";
import {
	type PostAppleForcedDeath,
	trappedRegion,
	type TrappedRegion,
} from "./trap-geometry.js";

export { trappedRegion, type TrappedRegion } from "./trap-geometry.js";

// The model gets the conclusion and first-fork bounds, not a recursively
// repeated derivation. The analyzer retains the full certificate for auditing.
export function summarizeContinuationProof(proof: ContinuationDeathProof) {
	type Counts = { certificateNodes: number; certifiedExits: number };
	const counts = new WeakMap<ContinuationDeathProof, Counts>();
	const active = new WeakSet<ContinuationDeathProof>();
	const frame = (current: ContinuationDeathProof) => ({
		proof: current,
		nextBranch: 0,
		certificateNodes: 1,
		certifiedExits: current.branches.length,
	});
	const pending = [frame(proof)];
	active.add(proof);
	// Memoized proofs form a DAG. Count each subtree once, then add its total
	// for every incoming edge to preserve the original expanded-tree counts.
	// Iterative postorder also handles a deep proof without recursive calls.
	while (pending.length) {
		const current = pending[pending.length - 1];
		if (current.nextBranch === current.proof.branches.length) {
			counts.set(current.proof, {
				certificateNodes: current.certificateNodes,
				certifiedExits: current.certifiedExits,
			});
			active.delete(current.proof);
			pending.pop();
			continue;
		}
		const child = current.proof.branches[current.nextBranch].proof;
		if (child.kind !== "continuation") {
			current.nextBranch++;
			continue;
		}
		const childCounts = counts.get(child);
		if (childCounts) {
			current.certificateNodes += childCounts.certificateNodes;
			current.certifiedExits += childCounts.certifiedExits;
			if (
				!Number.isSafeInteger(current.certificateNodes) ||
				!Number.isSafeInteger(current.certifiedExits)
			)
				throw new RangeError(
					"Continuation proof counts exceed safe integer precision",
				);
			current.nextBranch++;
		} else {
			if (active.has(child))
				throw new Error("Continuation proof contains a cycle");
			active.add(child);
			pending.push(frame(child));
		}
	}
	const { certificateNodes, certifiedExits } = counts.get(proof)!;
	return {
		collisionWithinMoves: proof.collisionWithinMoves,
		forcedPrefixMoves: proof.forcedPrefixMoves,
		branchHead: proof.branchHead,
		branches: proof.branches.map((branch) => ({
			direction: branch.direction,
			collisionWithinMoves: branch.collisionWithinMoves,
			proofKind: branch.proof.kind,
		})),
		certificateNodes,
		certifiedExits,
	};
}

export function trapInstructions(
	state: PublicState,
	twoStep = false,
	analyzer: DeathAnalyzer = createDeathAnalyzer(),
): string {
	const proofs: ({ move: string } & TrappedRegion)[] = [];
	const postAppleProofs: ({ move: string } & PostAppleForcedDeath)[] = [];
	const continuationProofs: ({ move: string } & ReturnType<
		typeof summarizeContinuationProof
	>)[] = [];
	const record = (move: string, after: PublicState, ateKnownApple: boolean) => {
		const proof = trappedRegion(after);
		if (proof) proofs.push({ move, ...proof });
		if (ateKnownApple) {
			const postApple = analyzer.postApple(after);
			if (postApple) postAppleProofs.push({ move, ...postApple });
		} else {
			const continuation = analyzer.continuation(after);
			if (continuation)
				continuationProofs.push({
					move,
					...summarizeContinuationProof(continuation),
				});
		}
	};
	for (const first of directions) {
		const next = inspectMove(state, first);
		if (next.immediateCollision) continue;
		const after = advanceGeometry(state, first);
		record(twoStep ? `first:${first}` : first, after, next.eatsApple);
		// After growth the actual second position is unknown. Do not invent it.
		if (!twoStep || next.eatsApple) continue;
		for (const second of directions) {
			const secondMove = inspectMove(after, second);
			if (secondMove.immediateCollision) continue;
			record(
				`second:${first}_${second}`,
				advanceGeometry(after, second),
				secondMove.eatsApple,
			);
		}
	}
	const regionInstructions = proofs.length
		? " Proven trapped regions: " +
			JSON.stringify(proofs) +
			". Counts start AFTER the named move. regionCells includes the head; fewer cells than bodyLength means the region runs out before a body revisit. Boundary body cells cannot vacate before boundaryReleaseLowerBound moves, which is greater than regionCells. Every continuation therefore collides; a branch or a path to food does not escape this proof. Unlisted moves are not proven safe."
		: "";
	const postAppleInstructions = postAppleProofs.length
		? " Proven unavoidable death after eating the known apple: " +
			JSON.stringify(postAppleProofs) +
			". collisionWithinMoves is an upper bound AFTER the named move, proved across every legal continuation even with no later growth. Further growth only blocks more cells; freeCellsAfterGrowth excludes filling the board before that collision. New food positions are not predicted. Unlisted moves are not proven safe."
		: "";
	const continuationInstructions = continuationProofs.length
		? " Proven continuation deaths: " +
			JSON.stringify(continuationProofs) +
			". collisionWithinMoves counts from AFTER the named move; forcedPrefixMoves counts unique legal moves before branchHead. branches lists every legal exit there, each with an independent sufficient death certificate; an empty list means no legal exits. The total upper bound is the prefix plus the longest branch bound (or one collision attempt when there are no exits). Branch bounds include their first move; proofKind names the supporting certificate. Nested certificates are summarized by certificateNodes/certifiedExits, which count proof structure, not moves. Every legal branch must be certified; a reachable cycle, win or uncertified growth prevents this proof. Unlisted moves are not proven safe."
		: "";
	return regionInstructions + postAppleInstructions + continuationInstructions;
}
