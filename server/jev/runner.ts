import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import {
	isResponseMode,
	type DecisionContext,
	type MatchEvent,
	type PublicState,
	type Receipt,
} from "../../shared/snake/types.js";
import { askJev } from "./client.js";
import type { jevConfig } from "./config.js";
import { gameClient } from "./game-client.js";

export type RunJevOptions = {
	root: string;
	state: PublicState;
	controlToken: string;
	jev: ReturnType<typeof jevConfig>;
	signal?: AbortSignal;
	log?: (message: string) => void;
	error?: (message: string) => void;
};
export async function runJevMatch(
	options: RunJevOptions,
): Promise<PublicState> {
	options.signal?.throwIfAborted();
	const { root, controlToken, jev } = options;
	const log = options.log ?? console.log;
	const reportError = options.error ?? console.error;
	let latest = options.state;
	if (!isResponseMode(latest.config))
		throw new Error("Only response single-step matches can run");
	const protocolVersion = 1;
	const request = gameClient(root);
	const socket = new WebSocket(
		`${root.replace(/^http/, "ws")}/ws/matches/${latest.id}/control`,
		{ headers: { Authorization: `Bearer ${controlToken}` } },
	);
	const pending = new Map<
		string,
		{ resolve: (r: Receipt) => void; reject: (error: Error) => void }
	>();
	let inference: AbortController | null = null;
	let activeRequest: {
		observedTick: number;
		targetTick: number;
		started: number;
	} | null = null;
	let connectionError: Error | null = null;
	function observe(state: PublicState) {
		if (state.seq < latest.seq) return;
		latest = state;
		if (latest.status !== "running" && latest.status !== "ready")
			inference?.abort(new DOMException("match_ended", "AbortError"));
	}
	function connectionFailed(error: Error) {
		connectionError = error;
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
		inference?.abort(error);
	}
	socket.on("message", (raw) => {
		const message = JSON.parse(raw.toString()) as {
			type: string;
			event?: MatchEvent;
			receipt?: Receipt;
			error?: { message: string };
		};
		if (message.type === "event" && message.event) {
			observe(message.event.state);
		} else if (message.type === "ack" && message.receipt) {
			pending.get(message.receipt.requestId)?.resolve(message.receipt);
			pending.delete(message.receipt.requestId);
		} else if (message.type === "error" || message.type === "service_error") {
			connectionFailed(
				new Error(message.error?.message ?? "Game protocol error"),
			);
		}
	});
	socket.on("close", () => {
		connectionFailed(new Error("Control WebSocket disconnected"));
	});
	socket.on("error", (error) => {
		connectionFailed(error);
	});
	const opening = new Promise<void>((resolve, reject) => {
		const abortOpen = () => {
			reject(options.signal?.reason);
			socket.terminate();
		};
		const cleanup = () =>
			options.signal?.removeEventListener("abort", abortOpen);
		socket.once("open", () => {
			cleanup();
			resolve();
		});
		socket.once("error", (error) => {
			cleanup();
			reject(error);
		});
		socket.once("unexpected-response", (_req, response) => {
			cleanup();
			reject(new Error(`Control handshake HTTP ${response.statusCode}`));
		});
		options.signal?.addEventListener("abort", abortOpen, { once: true });
	});
	function command(data: Record<string, unknown>): Promise<Receipt> {
		const requestId = randomUUID();
		return new Promise((resolve, reject) => {
			if (connectionError) {
				reject(connectionError);
				return;
			}
			pending.set(requestId, { resolve, reject });
			socket.send(
				JSON.stringify({ protocolVersion, requestId, ...data }),
				(error) => {
					if (error) {
						pending.delete(requestId);
						reject(error);
					}
				},
			);
		});
	}
	let stopping = false;
	let stopTask: Promise<void> | undefined;
	function stop(reason: string): Promise<void> {
		if (stopTask) return stopTask;
		stopping = true;
		inference?.abort(new DOMException(reason, "AbortError"));
		stopTask = (async () => {
			if (
				socket.readyState === WebSocket.OPEN &&
				(latest.status === "running" || latest.status === "ready")
			)
				await command({ type: "stop", reason });
		})();
		return stopTask;
	}
	const onAbort = () => {
		const reason =
			options.signal?.reason instanceof Error
				? options.signal.reason.message
				: "controller_stop";
		void stop(reason).catch(connectionFailed);
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	log(
		`JEV match ${latest.id} | one move per response | seed ${latest.config.seed} | provider ${jev.provider} | mode single_step`,
	);

	try {
		await opening;
		if (stopping) {
			await stopTask;
			return latest;
		}
		const start = await command({ type: "start" });
		if (start.status !== "applied")
			throw new Error(`Start rejected: ${start.code}`);
		observe(
			await request<PublicState>(`/api/matches/${latest.id}`, controlToken),
		);
		while (latest.status === "running" && !stopping) {
			let context: DecisionContext;
			try {
				context = await request<DecisionContext>(
					`/api/matches/${latest.id}/decision-context`,
					controlToken,
				);
			} catch (error) {
				const code = (error as { code?: string }).code;
				if (code === "not_running") {
					observe(
						await request<PublicState>(
							`/api/matches/${latest.id}`,
							controlToken,
						),
					);
					if (latest.status !== "running") break;
				}
				throw error;
			}
			if (stopping || latest.status !== "running") break;
			if (latest.tick > context.state.tick) {
				log(
					`Observed step ${context.state.tick} expired before inference; reading the current position`,
				);
				continue;
			}
			if (!context.progress)
				throw new Error(
					"Game server decision context is missing progress history",
				);
			if (context.progress.throughTick !== context.state.tick)
				throw new Error(
					"Game server progress history does not match observed tick",
				);
			inference = new AbortController();
			activeRequest = {
				observedTick: context.state.tick,
				targetTick: context.targetTick,
				started: performance.now(),
			};
			log(
				JSON.stringify({
					type: "model_request_started",
					provider: jev.provider,
					model: jev.model,
					observedTick: context.state.tick,
					targetTick: context.targetTick,
					movesSinceApple: context.progress.movesSinceApple,
					positionVisits: context.progress.positionVisits,
					repeatAfterMoves: context.progress.repeatAfterMoves,
				}),
			);
			const decision = await askJev(jev.apiKey, context.state, {
				signal: inference.signal,
				provider: jev.provider,
				model: jev.model,
				progress: context.progress,
				timing: {
					elapsedGameTimeMs: context.elapsedGameTimeMs,
					deadlineInMs: context.deadlineInMs,
				},
			});
			const receipt = await command({
				type: "action",
				observedSeq: context.observedSeq,
				targetTick: context.targetTick,
				expectedStateHash: context.expectedStateHash,
				direction: decision.choice,
				decision,
			});
			log(
				JSON.stringify({
					observedTick: context.state.tick,
					targetTick: context.targetTick,
					direction: decision.choice,
					requestMs: Math.round(decision.requestMs),
					contextBuildMs: decision.contextBuildMs,
					requestBytes: decision.requestBytes,
					inputTokens: decision.inputTokens,
					contextVersion: decision.request?.state.contextVersion,
					probabilities: decision.probabilities,
					status: receipt.status,
					code: receipt.code,
				}),
			);
			inference = null;
			activeRequest = null;
			if (
				receipt.status === "applied" ||
				(receipt.status === "rejected" && receipt.code === "stale_state")
			)
				continue;
			throw new Error(
				`Response action ${receipt.status}: ${receipt.code ?? "expected immediate applied confirmation"}`,
			);
		}
	} catch (error) {
		const expectedCancellation =
			(options.signal?.aborted && error === options.signal.reason) ||
			(inference?.signal.aborted &&
				error === inference.signal.reason &&
				(stopping ||
					(latest.status !== "running" && latest.status !== "ready")));
		if (activeRequest) {
			const failure = error instanceof Error ? error : new Error(String(error));
			const cause = failure.cause as NodeJS.ErrnoException | undefined;
			reportError(
				JSON.stringify({
					type: expectedCancellation
						? "model_request_cancelled"
						: "model_request_failed",
					provider: jev.provider,
					observedTick: activeRequest.observedTick,
					targetTick: activeRequest.targetTick,
					elapsedMs: Math.round(performance.now() - activeRequest.started),
					reason: failure.message.replaceAll(jev.apiKey, "[redacted]"),
					code: cause?.code,
				}),
			);
		}
		if (!expectedCancellation) {
			if (
				!stopping &&
				(latest.status === "running" || latest.status === "ready")
			)
				await stop("model_error");
			throw error;
		}
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		inference?.abort("runner_closed");
		try {
			await stopTask;
		} finally {
			await new Promise<void>((resolve) => {
				if (socket.readyState === WebSocket.CLOSED) {
					resolve();
					return;
				}
				socket.once("close", resolve);
				if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
				else socket.close();
			});
		}
	}
	log(
		"Match ended: " +
			latest.status +
			", score " +
			latest.score +
			", reason " +
			latest.endReason,
	);

	return latest;
}
