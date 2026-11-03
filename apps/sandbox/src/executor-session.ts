/**
 * The execution sandbox's requests as a function of {@link ExecutorHost}: which scripts run in
 * which order, how their output becomes a wire answer, and that a credential never travels back.
 * `executor.ts` implements the host over `ctx.container`; tests use a fake.
 */
import {
	ExecutorArtifact,
	ExecutorDestroyed,
	type ExecutorDestroyResponse,
	ExecutorInstall,
	ExecutorNotPrepared,
	ExecutorPrepared,
	ExecutorPrepareFailed,
	type ExecutorPrepareRequest,
	type ExecutorPrepareResponse,
	ExecutorPreparing,
	ExecutorRejectedArtifact,
	ExecutorRunExited,
	type ExecutorRunRequest,
	type ExecutorRunResponse,
	ExecutorUnavailable,
} from "@maple/domain/executor"
import { boundMessage, redactSecret } from "@maple/domain/sandbox"
import { Effect, Schema, Array as Arr, String as Str } from "effect"
import type { GatewayProps } from "./executor-gateway"
import {
	parsePrepareStatus,
	parseRunOutput,
	prepareRunner,
	prepareStatusScript,
	promoteScript,
	resetPrepareScript,
	runScript,
} from "./executor-scripts"

export interface ExecResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
	readonly durationMs: number
}

/** What the executor asks of its container. Failures are messages. */
export interface ExecutorHost {
	readonly isRunning: () => boolean
	/** Starts the container with internet off if needed, routing the gateway host to `gateway`. */
	readonly ensureStarted: (gateway: GatewayProps) => Effect.Effect<void, string>
	readonly exec: (script: string, timeoutMs: number) => Effect.Effect<ExecResult, string>
	/** Starts `script` in the background; it outlives the request. */
	readonly spawn: (script: string) => Effect.Effect<void, string>
	readonly destroy: Effect.Effect<void, string>
}

const STATUS_TIMEOUT_MS = 60_000
/** Headroom over a command's own deadline before the exec itself is abandoned. */
const RUN_HEADROOM_MS = 60_000
const PROMOTE_TIMEOUT_MS = 60_000

const PromotionOutput = Schema.Struct({
	promoted: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			bytes: Schema.Finite,
			sha256: Schema.String,
			preview: Schema.String,
		}),
	),
	rejected: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
})
const decodePromotion = Schema.decodeUnknownEffect(Schema.fromJsonString(PromotionOutput))

const utf8 = new TextEncoder()

export const prepare = (
	host: ExecutorHost,
	request: ExecutorPrepareRequest,
): Effect.Effect<ExecutorPrepareResponse> => {
	const { checkout } = request
	const redact = (text: string) => boundMessage(redactSecret(text, checkout.token))
	return Effect.gen(function* () {
		yield* host.ensureStarted({ git: { remoteUrl: checkout.remoteUrl, token: checkout.token } })
		const status = parsePrepareStatus((yield* host.exec(prepareStatusScript(), STATUS_TIMEOUT_MS)).stdout)
		switch (status._tag) {
			case "ready":
				if (status.sha !== checkout.sha)
					return new ExecutorPrepareFailed({
						message: `this executor was prepared for ${status.sha}, not ${checkout.sha}`,
					})
				return new ExecutorPrepared({
					installs: Arr.map(
						status.installs,
						(install) => new ExecutorInstall({ ...install, detail: redact(install.detail) }),
					),
				})
			case "failed":
				return new ExecutorPrepareFailed({
					message: redact(
						`preparing ${checkout.repository} failed (exit ${status.code}): ${status.log}`,
					),
				})
			case "lost":
				yield* host.exec(resetPrepareScript(), STATUS_TIMEOUT_MS)
				return new ExecutorPreparing({
					message: "prepare stopped before it finished; starting it again",
				})
			case "claimed":
				yield* host.spawn(prepareRunner(checkout.sha)).pipe(
					// A claim with nothing behind it would read as running forever.
					Effect.tapError(() =>
						host.exec(resetPrepareScript(), STATUS_TIMEOUT_MS).pipe(Effect.ignore),
					),
				)
				yield* Effect.logInfo("executor prepare started").pipe(
					Effect.annotateLogs({ "maple.executor.key": request.executorKey }),
				)
				return new ExecutorPreparing({
					message: `fetching ${checkout.repository} at ${checkout.sha}`,
				})
			case "running":
				return new ExecutorPreparing({ message: `still preparing ${checkout.repository}` })
		}
	}).pipe(
		Effect.catch((error) =>
			Effect.logWarning("executor prepare failed to run").pipe(
				Effect.annotateLogs({
					"maple.executor.key": request.executorKey,
					"error.message": redact(error),
				}),
				Effect.as(new ExecutorUnavailable({ message: redact(error) })),
			),
		),
	)
}

export const run = (
	host: ExecutorHost,
	request: ExecutorRunRequest,
	callId: string,
): Effect.Effect<ExecutorRunResponse> =>
	Effect.gen(function* () {
		if (!host.isRunning())
			return new ExecutorNotPrepared({
				message: "the executor's container is not running; prepare it again",
			})
		const result = yield* host.exec(
			runScript({
				agentId: request.agentId,
				callId,
				command: request.command,
				cwd: request.cwd,
				timeoutMs: request.timeoutMs,
			}),
			request.timeoutMs + RUN_HEADROOM_MS,
		)
		const parsed = parseRunOutput(result.stdout)
		if (parsed === undefined)
			return new ExecutorUnavailable({
				message: boundMessage(
					`the executor did not run the command: ${Str.slice(0, 500)(Str.trim(result.stderr)) || "no output"}`,
				),
			})
		const { body, trailer } = parsed
		if (trailer.state === "not-prepared")
			return new ExecutorNotPrepared({
				message: "the executor holds no prepared checkout; prepare it again",
			})
		if (trailer.state === "setup-failed")
			return new ExecutorUnavailable({
				message: boundMessage(
					`the executor could not isolate the command: ${Str.slice(0, 500)(Str.trim(result.stderr))}`,
				),
			})
		const promotion =
			request.promote.length === 0
				? { promoted: [], rejected: [] }
				: trailer.state === "unreaped"
					? {
							promoted: [],
							rejected: Arr.map(request.promote, ({ path }) => ({
								path,
								reason: "a process of the command could not be stopped, so scratch was not promoted",
							})),
						}
					: yield* host
							.exec(promoteScript(request.agentId, request.promote), PROMOTE_TIMEOUT_MS)
							.pipe(
								Effect.flatMap((answer) =>
									decodePromotion(answer.stdout).pipe(
										Effect.mapError(
											() =>
												`promotion answered unreadably: ${Str.slice(0, 300)(answer.stderr)}`,
										),
									),
								),
								// Step 11: a promotion that cannot run discards every entry, with why.
								Effect.catch((error) =>
									Effect.succeed({
										promoted: [],
										rejected: Arr.map(request.promote, ({ path }) => ({
											path,
											reason: error,
										})),
									}),
								),
							)
		const stderr = result.stderr
		yield* Effect.logInfo("executor command finished").pipe(
			Effect.annotateLogs({
				"maple.executor.key": request.executorKey,
				"maple.executor.agent_id": request.agentId,
				"maple.executor.exit_code": trailer.exitCode,
				"maple.executor.wall_time_ms": result.durationMs,
				"maple.executor.promoted": promotion.promoted.length,
				"maple.executor.rejected": promotion.rejected.length,
			}),
		)
		return new ExecutorRunExited({
			exitCode: trailer.exitCode,
			timedOut:
				(trailer.exitCode === 124 || trailer.exitCode === 137) &&
				result.durationMs >= request.timeoutMs,
			stdout: body,
			stderr,
			stdoutBytes: Math.max(trailer.stdoutBytes, utf8.encode(body).length),
			stderrBytes: Math.max(trailer.stderrBytes, utf8.encode(stderr).length),
			wallTimeMs: result.durationMs,
			promoted: Arr.map(promotion.promoted, (artifact) => new ExecutorArtifact(artifact)),
			rejected: Arr.map(
				promotion.rejected,
				(rejected) =>
					new ExecutorRejectedArtifact({
						path: rejected.path,
						reason: boundMessage(rejected.reason),
					}),
			),
		})
	}).pipe(
		Effect.catch((error) =>
			Effect.logWarning("executor command failed to run").pipe(
				Effect.annotateLogs({ "maple.executor.key": request.executorKey, "error.message": error }),
				Effect.as(new ExecutorUnavailable({ message: boundMessage(error) })),
			),
		),
	)

export const destroy = (host: ExecutorHost): Effect.Effect<ExecutorDestroyResponse> =>
	host.destroy.pipe(
		Effect.as(new ExecutorDestroyed()),
		Effect.catch((error) => Effect.succeed(new ExecutorUnavailable({ message: boundMessage(error) }))),
	)
