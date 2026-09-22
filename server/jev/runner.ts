import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import type { StagnationEvidence } from "../../shared/snake/stagnation.js";
import {
	isResponseMode,
	type DecisionContext,
	type MatchEvent,
	type PublicState,
	type Receipt,
} from "../../shared/snake/types.js";
import type {
	CredentialCall,
	WatchCredentialSource,
} from "../credentials/pool.js";
import { askJev } from "./client.js";
import type { jevConfig } from "./config.js";
import { gameClient } from "./game-client.js";
import { GrowthRouteMemory } from "./growth-route-memory.js";
import { evaluateStagnation } from "./stagnation.js";

export type RunJevOptions = {
	root: string;
	state: PublicState;
	controlToken: string;
	jev: ReturnType<typeof jevConfig>;
	credentials?: WatchCredentialSource;
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
	const routeMemory = new GrowthRouteMemory();
	const socket = new WebSocket(
		`${root.replace(/^http/, "ws")}/ws/matches/${latest.id}/control`,
		{ headers: { Authorization: `Bearer ${controlToken}` } },
	);
	const pending = new Map<
		string,
		{ resolve: (r: Receipt) => void; reject: (error: Error) => void }
	>();
	let inference: AbortController | null = null;
	const inFlight: {
		request: {
			observedTick: number;
			targetTick: number;
			started: number;
		} | null;
	} = { request: null };
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
	function command(
		data: Record<string, unknown>,
		requestId = randomUUID(),
	): Promise<Receipt> {
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
	function stop(reason: string, guard?: StagnationEvidence): Promise<void> {
		if (stopTask) return stopTask;
		stopping = true;
		inference?.abort(new DOMException(reason, "AbortError"));
		stopTask = (async () => {
			if (
				socket.readyState === WebSocket.OPEN &&
				(latest.status === "running" || latest.status === "ready")
			) {
				const receipt = await command({
					type: "stop",
					reason,
					...(guard ? { guard } : {}),
				});
				if (guard && receipt.status !== "applied")
					throw new Error(
						`Spending protection stop was rejected: ${receipt.code ?? receipt.status}`,
					);
			}
		})();
		return stopTask;
	}
	const onAbort = () => {
		const cancellation = options.signal?.reason;
		if (
			cancellation instanceof Error &&
			"matchStopped" in cancellation &&
			cancellation.matchStopped === latest.id
		) {
			// The owner already committed this match's terminal state. A second
			// stop can race its WS event and create a spurious rejection record.
			stopping = true;
			inference?.abort(cancellation);
			stopTask ??= Promise.resolve();
			return;
		}
		const reason =
			cancellation instanceof Error ? cancellation.message : "controller_stop";
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
			const guard = evaluateStagnation(
				context.state,
				context.progress,
				jev.stagnationGuard,
			);
			if (guard) {
				log(
					JSON.stringify({
						type: "stagnation_guard_triggered",
						matchId: latest.id,
						...guard,
					}),
				);
				await stop(guard.reason, guard);
				const stoppedState = await request<PublicState>(
					`/api/matches/${latest.id}`,
					controlToken,
				);
				observe(stoppedState);
				if (
					stoppedState.status !== "interrupted" ||
					stoppedState.endReason !== guard.reason
				)
					throw new Error(
						"Spending protection did not persist the expected interruption",
					);
				break;
			}
			options.signal?.throwIfAborted();
			inference = new AbortController();
			const actionRequestId = randomUUID();
			let credentialCall: CredentialCall | undefined;
			credentialCall = options.credentials?.begin({
				observedSeq: context.observedSeq,
				targetTick: context.targetTick,
				actionRequestId,
			});
			let decision: Awaited<ReturnType<typeof askJev>>;
			try {
				decision = await askJev(
					credentialCall ? credentialCall.apiKey : jev.apiKey,
					context.state,
					{
						dynamicAnalysis: jev.dynamicAnalysis,
						routeMemory,
						onRequestStarted: () => {
							if (credentialCall) options.credentials!.started(credentialCall);
							inFlight.request = {
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
						},
						signal: inference.signal,
						provider: jev.provider,
						model: jev.model,
						progress: context.progress,
						timing: {
							elapsedGameTimeMs: context.elapsedGameTimeMs,
							deadlineInMs: context.deadlineInMs,
						},
					},
				);
			} catch (error) {
				if (credentialCall && options.credentials) {
					const cancelled =
						inference.signal.aborted && error === inference.signal.reason;
					const rotate = options.credentials.failed(
						credentialCall,
						error,
						cancelled,
					);
					if (
						rotate &&
						!stopping &&
						!options.signal?.aborted &&
						latest.status === "running"
					) {
						reportError(
							JSON.stringify({
								type: "model_request_failed",
								provider: jev.provider,
								observedTick: context.state.tick,
								targetTick: context.targetTick,
								reason:
									error instanceof Error ? error.message : "credential_error",
								credentialRotation: true,
							}),
						);
						inference = null;
						inFlight.request = null;
						continue;
					}
				}
				throw error;
			}
			if (credentialCall)
				options.credentials!.succeeded(credentialCall, decision);
			if (stopping || options.signal?.aborted || latest.status !== "running")
				break;
			const receipt = await command(
				{
					type: "action",
					observedSeq: context.observedSeq,
					targetTick: context.targetTick,
					expectedStateHash: context.expectedStateHash,
					direction: decision.choice,
					decision,
				},
				actionRequestId,
			);
			if (credentialCall) options.credentials!.applied(credentialCall, receipt);
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
			inFlight.request = null;
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
		if (inFlight.request) {
			const failure = error instanceof Error ? error : new Error(String(error));
			const cause = failure.cause as NodeJS.ErrnoException | undefined;
			reportError(
				JSON.stringify({
					type: expectedCancellation
						? "model_request_cancelled"
						: "model_request_failed",
					provider: jev.provider,
					observedTick: inFlight.request.observedTick,
					targetTick: inFlight.request.targetTick,
					elapsedMs: Math.round(performance.now() - inFlight.request.started),
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
