import "dotenv/config";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { z } from "zod";
import { inspectMove } from "../server/game/engine.js";
import { sendJevRequest } from "../server/jev/client.js";
import { jevConfig } from "../server/jev/config.js";
import {
	renderAsciiBoard,
	renderNamedBoard,
} from "../shared/snake/ascii-board.js";
import type { DecisionRequestV12 } from "../shared/snake/non-reverse.js";
import { decisionRequestSchema } from "../shared/snake/schema.js";
import {
	type DecisionRequest,
	type DecisionRequestV13,
	type DecisionRequestV14,
	type DecisionRequestV15,
	type DecisionRequestV16,
	type Direction,
	type PublicState,
	directions,
} from "../shared/snake/types.js";

type EvaluationInput = {
	cases: {
		id: string;
		split: "train" | "validation" | "control";
		observation: PublicState;
		variants: { name: string; request: DecisionRequest }[];
	}[];
};
const point = z.object({
	x: z.number().int().nonnegative(),
	y: z.number().int().nonnegative(),
});
const observationGeometry = z.object({
	config: z.object({
		width: z.number().int().positive(),
		height: z.number().int().positive(),
	}),
	snake: z.array(point).min(1),
	direction: z.enum(directions),
	obstacles: z.array(point),
	apple: point.nullable(),
	star: z.object({ point, expiresAt: z.number() }).nullable(),
	tick: z.number().int().nonnegative(),
});
const inputShape = z.object({
	cases: z
		.array(
			z.object({
				id: z.string().min(1),
				split: z.enum(["train", "validation", "control"]),
				observation: observationGeometry,
				variants: z
					.array(
						z.object({
							name: z.string().min(1),
							request: decisionRequestSchema,
						}),
					)
					.min(1),
			}),
		)
		.min(1),
});

function validateInput(value: unknown, model: string): EvaluationInput {
	// Validate without replacing the original JSON: no schema stripping or defaults reach the model.
	inputShape.parse(value);
	const input = value as EvaluationInput;
	const ids = new Set<string>();
	for (const entry of input.cases) {
		if (ids.has(entry.id)) throw new Error(`Duplicate case: ${entry.id}`);
		ids.add(entry.id);
		const names = new Set<string>();
		for (const { name, request } of entry.variants) {
			const label = `${entry.id}/${name}`;
			if (names.has(name)) throw new Error(`Duplicate variant: ${label}`);
			names.add(name);
			if (request.model !== model)
				throw new Error(
					`${label}: request.model ${request.model} differs from configured model ${model}`,
				);
			if (
				!("contextVersion" in request.state) ||
				![
					"non-reverse-v12",
					"legal-space-v13",
					"dynamic-space-v14",
					"growth-space-v15",
					"compact-growth-v16",
				].includes(request.state.contextVersion)
			)
				throw new Error(
					`${label}: this evaluator accepts V12 through V16 board requests only`,
				);
			const rawRequest = request as
				| DecisionRequestV12
				| DecisionRequestV13
				| DecisionRequestV14
				| DecisionRequestV15
				| DecisionRequestV16;
			const state = rawRequest.state;
			const observation = entry.observation;
			const comparisons = {
				width: [state.board.width, observation.config.width],
				height: [state.board.height, observation.config.height],
				bodyHeadToTail: [state.player.bodyHeadToTail, observation.snake],
				direction: [state.player.direction, observation.direction],
				obstacles: [state.board.obstacles, observation.obstacles],
				apple: [state.food.apple, observation.apple],
				star: [state.food.star, observation.star],
				observedTick: [state.timing.observedTick, observation.tick],
				targetTick: [state.timing.targetTick, observation.tick + 1],
			};
			for (const [field, [actual, expected]] of Object.entries(comparisons))
				if (!isDeepStrictEqual(actual, expected))
					throw new Error(`${label}: ${field} does not match the observation`);
			const board = {
				width: observation.config.width,
				height: observation.config.height,
				obstacles: observation.obstacles,
				bodyHeadToTail: observation.snake,
				apple: observation.apple,
				star: observation.star?.point ?? null,
			};
			const ascii = renderAsciiBoard(board).map;
			const named = renderNamedBoard(board).map;
			const lines = rawRequest.questions.direction.instructions.split("\n");
			for (let index = 0; index < lines.length; index++) {
				const symbolGrid = /^\s*y\\x\s/.test(lines[index]);
				const namedGrid = lines[index].startsWith("(0,0)=");
				if (!symbolGrid && !namedGrid) continue;
				const count = observation.config.height + (symbolGrid ? 1 : 0);
				if (
					lines.slice(index, index + count).join("\n") !==
					(symbolGrid ? ascii : named)
				)
					throw new Error(
						`${label}: inline instructions map does not match the observation`,
					);
				index += count - 1;
			}
		}
	}
	return input;
}

type Counts = {
	calls: number;
	passed: number;
	choices: Partial<Record<Direction, number>>;
	collisions: Record<string, number>;
};
const emptyCounts = (): Counts => ({
	calls: 0,
	passed: 0,
	choices: {},
	collisions: {},
});

async function main() {
	const { values } = parseArgs({
		options: {
			input: { type: "string" },
			out: { type: "string" },
			repeats: { type: "string", default: "3" },
			live: { type: "boolean", default: false },
		},
	});
	if (!values.input || !values.out)
		throw new Error(
			"Usage: bun scripts/evaluate-snake-prompt.ts --input cases.json --out NEW_DIRECTORY [--repeats 3] [--live]",
		);
	const repeats = Number(values.repeats);
	if (!Number.isSafeInteger(repeats) || repeats < 1)
		throw new Error("--repeats must be a positive integer");
	const out = resolve(values.out);
	await mkdir(dirname(out), { recursive: true });
	await mkdir(out); // EEXIST is intentional: never overwrite previous evidence.
	const writeJson = (name: string, value: unknown) =>
		writeFile(resolve(out, name), `${JSON.stringify(value, null, 2)}\n`, {
			flag: "wx",
		});
	const config = jevConfig();
	const redact = (message: string) =>
		config.apiKey ? message.replaceAll(config.apiKey, "[redacted]") : message;
	let input: EvaluationInput;
	try {
		input = validateInput(
			JSON.parse(await readFile(resolve(values.input), "utf8")),
			config.model,
		);
		if (values.live && !config.apiKey)
			throw new Error(`${config.keyEnv} is required for --live`);
	} catch (error) {
		await writeJson("error.json", {
			phase: "validation",
			error: redact(error instanceof Error ? error.message : String(error)),
		});
		throw error;
	}
	const schedule: {
		caseIndex: number;
		variantIndex: number;
		repeat: number;
	}[] = [];
	const maxVariants = Math.max(
		...input.cases.map((entry) => entry.variants.length),
	);
	for (let repeat = 0; repeat < repeats; repeat++)
		for (let rank = 0; rank < maxVariants; rank++)
			for (let offset = 0; offset < input.cases.length; offset++) {
				const caseIndex = (offset + repeat) % input.cases.length;
				const variants = input.cases[caseIndex].variants.length;
				if (rank < variants)
					schedule.push({
						caseIndex,
						variantIndex: (rank + repeat + caseIndex) % variants,
						repeat: repeat + 1,
					});
			}
	const interpretation =
		"Pass means the selected direction enters no immediate collision under the recorded rules. This does not measure winning, long-term survival or route quality. Offline inspection is never added to model requests.";
	await writeJson("manifest.json", {
		createdAt: new Date().toISOString(),
		mode: values.live ? "live" : "offline",
		provider: config.provider,
		model: config.model,
		endpoint: config.endpoint,
		inputPath: resolve(values.input),
		repeats,
		plannedCalls: values.live ? schedule.length : 0,
		interpretation,
		cases: input.cases,
		schedule: schedule.map(({ caseIndex, variantIndex, repeat }) => ({
			caseId: input.cases[caseIndex].id,
			variant: input.cases[caseIndex].variants[variantIndex].name,
			repeat,
		})),
	});
	if (!values.live) {
		console.log(
			JSON.stringify({
				mode: "offline",
				calls: 0,
				message: "Validated and wrote manifest; no model API was called.",
				out,
			}),
		);
		return;
	}
	const byCaseVariant: Record<string, Record<string, Counts>> = {};
	const byVariant: Record<string, Counts> = {};
	const bySplitVariant: Record<string, Record<string, Counts>> = {};
	let completedCalls = 0;
	const summary = (status: "complete" | "failed") => ({
		status,
		completedCalls,
		plannedCalls: schedule.length,
		interpretation,
		byCaseVariant,
		byVariant,
		bySplitVariant,
	});
	for (const { caseIndex, variantIndex, repeat } of schedule) {
		const entry = input.cases[caseIndex];
		const variant = entry.variants[variantIndex];
		const startedAt = new Date().toISOString();
		const started = performance.now();
		let httpStatus: number | null = null;
		let responseText: string | null = null;
		const base = {
			caseId: entry.id,
			split: entry.split,
			variant: variant.name,
			repeat,
			startedAt,
			provider: config.provider,
			request: variant.request,
		};
		const transport: typeof fetch = async (url, init) => {
			const response = await fetch(url, init);
			httpStatus = response.status;
			responseText = redact(await response.clone().text());
			return response;
		};
		try {
			const { decision, response } = await sendJevRequest(
				config.apiKey,
				variant.request,
				{ provider: config.provider, fetch: transport },
			);
			const elapsedMs = performance.now() - started;
			const finishedAt = new Date().toISOString();
			const assessment = inspectMove(entry.observation, decision.choice);
			const passed = assessment.immediateCollision === null;
			await appendFile(
				resolve(out, "calls.jsonl"),
				`${JSON.stringify({
					...base,
					status: "ok",
					finishedAt,
					elapsedMs,
					httpStatus,
					responseText,
					response,
					choice: decision.choice,
					probabilities: decision.probabilities,
					confidence: decision.confidence,
					model: decision.model,
					inputTokens: decision.inputTokens ?? null,
					requestMs: decision.requestMs,
					assessment: { ...assessment, passed },
				})}\n`,
			);
			for (const counts of [
				((byCaseVariant[entry.id] ??= {})[variant.name] ??= emptyCounts()),
				(byVariant[variant.name] ??= emptyCounts()),
				((bySplitVariant[entry.split] ??= {})[variant.name] ??= emptyCounts()),
			]) {
				counts.calls++;
				counts.passed += Number(passed);
				counts.choices[decision.choice] =
					(counts.choices[decision.choice] ?? 0) + 1;
				if (assessment.immediateCollision)
					counts.collisions[assessment.immediateCollision] =
						(counts.collisions[assessment.immediateCollision] ?? 0) + 1;
			}
			completedCalls++;
			console.log(
				JSON.stringify({
					caseId: entry.id,
					variant: variant.name,
					repeat,
					choice: decision.choice,
					immediateCollision: assessment.immediateCollision,
					passed,
					model: decision.model,
					elapsedMs,
				}),
			);
		} catch (error) {
			const message = redact(
				error instanceof Error ? error.message : String(error),
			);
			await appendFile(
				resolve(out, "calls.jsonl"),
				`${JSON.stringify({ ...base, status: "error", finishedAt: new Date().toISOString(), elapsedMs: performance.now() - started, httpStatus, responseText, error: message })}\n`,
			);
			await writeJson("summary.json", summary("failed"));
			console.error(
				JSON.stringify({
					caseId: entry.id,
					variant: variant.name,
					repeat,
					status: "error",
					error: message,
				}),
			);
			throw new Error(message, { cause: error });
		}
	}
	await writeJson("summary.json", summary("complete"));
	console.log(
		JSON.stringify({ status: "complete", calls: completedCalls, out }),
	);
}

await main();
