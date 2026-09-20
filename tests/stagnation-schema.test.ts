import { afterEach, describe, expect, test } from "vitest";
import { Store } from "../server/db/store.js";
import { MatchService } from "../server/matches/service.js";
import {
	allControlSchema,
	controlSchema,
	stagnationEvidenceSchema,
} from "../shared/snake/schema.js";
import type {
	StagnationEvidence,
	StagnationStopReason,
} from "../shared/snake/stagnation.js";
import type { Direction } from "../shared/snake/types.js";

function evidence(
	reason: StagnationStopReason = "stagnation_loop",
): StagnationEvidence {
	return {
		reason,
		observedTick: 80,
		movesSinceApple: 64,
		positionVisits: 3,
		maxPositionVisits: 3,
		maxMovesWithoutApple: 64,
	};
}
function stop(guard = evidence()) {
	return {
		protocolVersion: 1,
		requestId: "guard-stop",
		type: "stop",
		reason: guard.reason,
		guard,
	};
}

describe("stagnation stop evidence", () => {
	test.each(["stagnation_loop", "stagnation_no_apple"] as const)(
		"accepts %s exactly at its threshold",
		(reason) => {
			const value = stop(evidence(reason));
			expect(stagnationEvidenceSchema.parse(value.guard)).toEqual(value.guard);
			expect(controlSchema.parse(value)).toEqual(value);
			expect(allControlSchema.parse(value)).toEqual(value);
		},
	);

	test("each reason checks its own threshold and preserves actual values", () => {
		const loop = evidence();
		loop.movesSinceApple = 8;
		loop.positionVisits = 5;
		expect(controlSchema.parse(stop(loop))).toEqual(stop(loop));
		const noApple = evidence("stagnation_no_apple");
		noApple.positionVisits = 1;
		noApple.movesSinceApple = 75;
		expect(controlSchema.parse(stop(noApple))).toEqual(stop(noApple));
		loop.positionVisits = loop.maxPositionVisits - 1;
		noApple.movesSinceApple = noApple.maxMovesWithoutApple - 1;
		expect(controlSchema.safeParse(stop(loop)).success).toBe(false);
		expect(controlSchema.safeParse(stop(noApple)).success).toBe(false);
	});

	test.each([
		"observedTick",
		"movesSinceApple",
		"positionVisits",
		"maxPositionVisits",
		"maxMovesWithoutApple",
	] as const)("requires integral valid %s", (field) => {
		for (const invalid of [-1, 0.5, Number.POSITIVE_INFINITY]) {
			const guard = evidence();
			guard[field] = invalid;
			expect(controlSchema.safeParse(stop(guard)).success).toBe(false);
		}
	});

	test("visit thresholds start at two, no-apple thresholds at one and actual visits at one", () => {
		for (const invalid of [
			{ maxPositionVisits: 1 },
			{ maxMovesWithoutApple: 0 },
			{ positionVisits: 0 },
		]) {
			const guard = { ...evidence(), ...invalid };
			expect(controlSchema.safeParse(stop(guard)).success).toBe(false);
		}
	});

	test.each(["stagnation_loop", "stagnation_no_apple"] as const)(
		"requires reason-matched evidence for %s",
		(reason) => {
			const { guard: _guard, ...missing } = stop(evidence(reason));
			expect(controlSchema.safeParse(missing).success).toBe(false);
			const wrong = stop(evidence(reason));
			wrong.guard.reason =
				reason === "stagnation_loop"
					? "stagnation_no_apple"
					: "stagnation_loop";
			expect(controlSchema.safeParse(wrong).success).toBe(false);
		},
	);

	test("guard fields are strict and cannot be attached to unrelated commands", () => {
		const value = stop();
		expect(
			controlSchema.safeParse({ ...value, reason: "controller_stop" }).success,
		).toBe(false);
		expect(
			controlSchema.safeParse({
				...value,
				guard: { ...value.guard, guessedSafe: true },
			}).success,
		).toBe(false);
		expect(
			controlSchema.safeParse({
				protocolVersion: 1,
				requestId: "start",
				type: "start",
				guard: evidence(),
			}).success,
		).toBe(false);
	});

	test("ordinary and historical stop commands retain their original guard-free shape", () => {
		const command = {
			protocolVersion: 1,
			requestId: "manual-stop",
			type: "stop",
		};
		expect(controlSchema.parse(command)).toEqual({
			...command,
			reason: "controller_stop",
		});
		for (const reason of [
			"controller_stop",
			"server_shutdown",
			"server_restart",
			"model_error",
		])
			expect(controlSchema.parse({ ...command, reason })).toEqual({
				...command,
				reason,
			});
		expect(
			controlSchema.parse({
				...command,
				protocolVersion: 2,
				reason: "server_shutdown",
			}),
		).toEqual({ ...command, protocolVersion: 2, reason: "server_shutdown" });
	});
});

const disposers: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposers.splice(0).reverse()) dispose();
});
function fixture() {
	const store = new Store(":memory:");
	let now = 0;
	const service = new MatchService(store, () => now, false);
	disposers.push(() => {
		service.close();
		if (store.db.open) store.close();
	});
	const created = service.create({
		requestId: "create",
		controlToken: "stagnation-archive-test-secret".repeat(2),
		agentName: "Stagnation archive test",
		config: {
			layoutVersion: 3,
			width: 8,
			height: 6,
			obstacleCount: 0,
			seed: "stagnation-archive-test",
			stepMode: "response",
			tickIntervalMs: null,
		},
	});
	service.command(created.id, {
		protocolVersion: 1,
		requestId: "start",
		type: "start",
	});
	let count = 0;
	const step = (direction: Direction) => {
		const context = service.decisionContext(created.id);
		now += 100;
		const receipt = service.command(created.id, {
			protocolVersion: 1,
			requestId: `move-${++count}`,
			type: "action",
			observedSeq: context.observedSeq,
			targetTick: context.targetTick,
			expectedStateHash: context.expectedStateHash,
			direction,
		});
		expect(receipt.status).toBe("applied");
	};
	for (let round = 0; round < 2; round++)
		for (const direction of ["down", "right", "up", "left"] as const)
			step(direction);
	const context = service.decisionContext(created.id);
	expect(context.progress).toMatchObject({
		throughTick: 8,
		movesSinceApple: 8,
		positionVisits: 2,
	});
	return {
		store,
		service,
		id: created.id,
		step,
		guard: (reason: StagnationStopReason): StagnationEvidence => ({
			reason,
			observedTick: context.state.tick,
			movesSinceApple: context.progress!.movesSinceApple,
			positionVisits: context.progress!.positionVisits,
			maxPositionVisits: reason === "stagnation_loop" ? 2 : 3,
			maxMovesWithoutApple: 8,
		}),
	};
}

describe("stagnation evidence in committed stop events", () => {
	test.each(["stagnation_loop", "stagnation_no_apple"] as const)(
		"stores %s evidence as interruption without inventing a loss",
		(reason) => {
			const f = fixture();
			const before = f.store.get(f.id);
			const guard = f.guard(reason);
			const command = stop(guard);
			const receipt = f.service.command(f.id, command);
			expect(receipt.status).toBe("applied");
			const after = f.store.get(f.id);
			expect(after).toMatchObject({
				status: "interrupted",
				endReason: reason,
				tick: before.tick,
				snake: before.snake,
				score: before.score,
				applesEaten: before.applesEaten,
			});
			const events = f.store.events(f.id, -1).events;
			expect(events.at(-1)).toMatchObject({
				type: "interrupted",
				tick: before.tick,
				data: { reason, guard },
			});
			expect(
				events.some(
					(event) => event.type === "gameover" || event.type === "won",
				),
			).toBe(false);
			const count = events.length;
			expect(f.service.command(f.id, command)).toEqual(receipt);
			expect(f.store.events(f.id, -1).events).toHaveLength(count);
			guard.positionVisits += 1;
			expect(f.store.events(f.id, -1).events.at(-1)!.data.guard).not.toEqual(
				guard,
			);
		},
	);

	test("rejects stale evidence after a real intervening move and does not stop the match", () => {
		const f = fixture();
		const command = stop(f.guard("stagnation_loop"));
		f.step("down");
		const before = f.store.get(f.id);
		const result = f.service.command(f.id, command);
		expect(result).toMatchObject({ status: "rejected", code: "stale_state" });
		expect(f.store.get(f.id)).toMatchObject({
			status: "running",
			endReason: null,
			tick: 9,
			snake: before.snake,
		});
		expect(f.store.events(f.id, -1).events.at(-1)).toMatchObject({
			type: "action_rejected",
			data: { code: "stale_state" },
		});
	});

	test("malformed or unrelated evidence is rejected before changing persisted history", () => {
		const f = fixture();
		const before = f.store.events(f.id, -1).events;
		for (const command of [
			{ ...stop(f.guard("stagnation_loop")), reason: "server_shutdown" },
			{
				protocolVersion: 1,
				requestId: "missing",
				type: "stop",
				reason: "stagnation_loop",
			},
		])
			expect(() => f.service.command(f.id, command)).toThrow();
		expect(f.store.events(f.id, -1).events).toEqual(before);
		expect(f.store.get(f.id).status).toBe("running");
	});

	test.each(["controller_stop", "server_shutdown"])(
		"ordinary %s does not acquire guard evidence",
		(reason) => {
			const f = fixture();
			f.service.command(f.id, {
				protocolVersion: 1,
				requestId: "normal-stop",
				type: "stop",
				reason,
			});
			expect(f.store.events(f.id, -1).events.at(-1)!.data).toEqual({ reason });
			expect(f.store.get(f.id)).toMatchObject({
				status: "interrupted",
				endReason: reason,
			});
		},
	);
});
