/**
 * The security audit's execution sandbox, as the audit run sees it: prepare the pinned commit once
 * per run, run agent commands in it, destroy it when the run ends. The wire and the container live
 * in the sandbox Worker (`apps/sandbox/src/executor*.ts`); this side owns the credential, waits out
 * a prepare in progress, and prepares again when the executor lost its container.
 */
import {
	EXECUTOR_LIMITS,
	type ExecutorCommandInput,
	ExecutorDestroyRequest,
	type ExecutorInstall,
	ExecutorPrepareRequest,
	ExecutorRunRequest,
	type ExecutorRunExited,
} from "@maple/domain/executor"
import type { OrgId } from "@maple/domain/http"
import { SandboxCheckout } from "@maple/domain/sandbox"
import {
	Cause,
	Context,
	Duration,
	Effect,
	Layer,
	Option,
	Schedule,
	Schema,
	Array as Arr,
	String as Str,
} from "effect"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { type ExecutorTransport, SandboxClient } from "@maple/backend/sandbox/client"
import { VcsSourceService } from "@maple/backend/services/integrations/vcs/VcsSourceService"

export class ExecutorServiceError extends Schema.TaggedError<ExecutorServiceError>()(
	"@maple/backend/sandbox/ExecutorServiceError",
	{
		message: Schema.String,
		reason: Schema.Literals(["no_executor", "prepare_failed", "unavailable", "invalid_command"]),
	},
) {}

/** A repository pinned to the commit the run audits. */
export interface ExecutorTarget {
	readonly repository: string
	readonly sha: string
}

export interface ExecutorCommand extends ExecutorCommandInput {
	readonly agentId: string
}

export interface ExecutorServiceApi {
	/** Whether this deployment has an execution sandbox at all. */
	readonly available: boolean
	/** Prepares the run's executor and waits for it; answers what each lockfile's install did. */
	readonly prepare: (
		orgId: OrgId,
		runId: string,
		target: ExecutorTarget,
	) => Effect.Effect<ReadonlyArray<ExecutorInstall>, ExecutorServiceError>
	readonly run: (
		orgId: OrgId,
		runId: string,
		target: ExecutorTarget,
		command: ExecutorCommand,
	) => Effect.Effect<ExecutorRunExited, ExecutorServiceError>
	/** Best effort: an executor nobody destroys stops on its own after its inactivity timeout. */
	readonly destroy: (runId: string) => Effect.Effect<void>
}

/** A run's executor is named by the run. */
export const executorKey = (runId: string): string =>
	Str.slice(0, 63)(`run-${Str.replace(/[^a-z0-9-]/gu, "-")(Str.toLowerCase(runId))}`)

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/u

/** The engine's agent id in the skill's canonical form: lowercase, `[a-z0-9_-]`, never a device name. */
export const executorAgentId = (agentId: string): string => {
	const id = Str.slice(0, 64)(Str.replace(/[^a-z0-9_-]/gu, "-")(Str.toLowerCase(agentId)))
	return /^[a-z0-9]/u.test(id) && !WINDOWS_DEVICE.test(id) ? id : Str.slice(0, 64)(`a${id}`)
}

export interface ExecutorDeps {
	readonly transport: ExecutorTransport
	readonly checkout: (
		orgId: OrgId,
		target: ExecutorTarget,
	) => Effect.Effect<SandboxCheckout, ExecutorServiceError>
	/** How often a prepare in progress is asked again (5 seconds). */
	readonly preparePoll?: Duration.Input
}

/** How long a prepare (fetch and installs) may take before the run gives up on executing. */
export const PREPARE_WAIT = Duration.minutes(22)
const PREPARE_POLL = Duration.seconds(5)
/**
 * Headroom over a command's own deadline for the call that carries it: the executor runs a few
 * commands at once, so one may first wait out a full-length command in each slot.
 */
const RUN_HEADROOM = Duration.sum(Duration.millis(EXECUTOR_LIMITS.maxTimeoutMs), Duration.minutes(2))

const decodeRunRequest = Schema.decodeUnknownEffect(ExecutorRunRequest)

const unavailable = (message: string) => new ExecutorServiceError({ message, reason: "unavailable" })
const noExecutor = new ExecutorServiceError({
	message: "this deployment has no execution sandbox",
	reason: "no_executor",
})

export const makeExecutor = (deps: ExecutorDeps): ExecutorServiceApi => {
	const { transport } = deps
	const call = <A>(
		effect: Effect.Effect<Option.Option<A>, { readonly message: string; readonly cause?: unknown }>,
	) =>
		effect.pipe(
			// The cause carries the decode or HTTP detail the message only names.
			Effect.mapError((error) =>
				unavailable(
					error.cause === undefined
						? error.message
						: `${error.message}: ${Str.slice(0, 300)(summarizeCause(Cause.fail(error.cause)))}`,
				),
			),
			Effect.flatMap(Option.match({ onNone: () => Effect.fail(noExecutor), onSome: Effect.succeed })),
		)

	const prepare: ExecutorServiceApi["prepare"] = Effect.fn("ExecutorService.prepare")(
		function* (orgId, runId, target) {
			yield* Effect.annotateCurrentSpan({
				"maple.security_audit.run_id": runId,
				"vcs.repository.full_name": target.repository,
				"vcs.ref.head.revision": target.sha,
			})
			const checkout = yield* deps.checkout(orgId, target)
			const request = new ExecutorPrepareRequest({ executorKey: executorKey(runId), checkout })
			const answer = yield* call(transport.prepare(request)).pipe(
				// A transient failure of one poll is waited out like a prepare still running.
				Effect.retry({
					while: (error) => error.reason === "unavailable",
					schedule: Schedule.spaced(deps.preparePoll ?? PREPARE_POLL),
				}),
				Effect.repeat({
					while: (answer) => answer._tag === "ExecutorPreparing",
					schedule: Schedule.spaced(deps.preparePoll ?? PREPARE_POLL),
				}),
				Effect.timeoutOrElse({
					duration: PREPARE_WAIT,
					orElse: () =>
						Effect.fail(
							new ExecutorServiceError({
								message: `preparing ${target.repository} took longer than ${Duration.toMinutes(PREPARE_WAIT)} minutes`,
								reason: "prepare_failed",
							}),
						),
				}),
			)
			switch (answer._tag) {
				case "ExecutorPrepared":
					yield* Effect.annotateCurrentSpan(
						"maple.executor.installs",
						Arr.join(
							Arr.map(
								answer.installs,
								(install) => `${install.dir}:${install.manager}:${install.outcome}`,
							),
							",",
						),
					)
					return answer.installs
				case "ExecutorPrepareFailed":
					return yield* new ExecutorServiceError({
						message: answer.message,
						reason: "prepare_failed",
					})
				default:
					return yield* unavailable(answer.message)
			}
		},
	)

	const runOnce = (request: ExecutorRunRequest) =>
		call(transport.run(request)).pipe(
			Effect.timeoutOrElse({
				duration: Duration.sum(Duration.millis(request.timeoutMs), RUN_HEADROOM),
				orElse: () => Effect.fail(unavailable("the execution sandbox did not answer in time")),
			}),
		)

	const run: ExecutorServiceApi["run"] = Effect.fn("ExecutorService.run")(
		function* (orgId, runId, target, command) {
			// Decoded, not constructed: a command the wire refuses (too long, a NUL) is the agent's to fix.
			const request = yield* decodeRunRequest({
				executorKey: executorKey(runId),
				agentId: executorAgentId(command.agentId),
				command: command.command,
				cwd: command.cwd,
				timeoutMs: command.timeoutMs,
				promote: command.promote,
			}).pipe(
				Effect.mapError(
					(error) =>
						new ExecutorServiceError({
							message: `the command was not run: ${Str.slice(0, 300)(error.message)}`,
							reason: "invalid_command",
						}),
				),
			)
			yield* Effect.annotateCurrentSpan({
				"maple.security_audit.run_id": runId,
				"maple.security_audit.agent_id": request.agentId,
			})
			let answer = yield* runOnce(request)
			// The container stopped (inactivity, an eviction): prepare the same commit again, once.
			if (answer._tag === "ExecutorNotPrepared") {
				yield* Effect.annotateCurrentSpan("maple.executor.reprepared", true)
				yield* prepare(orgId, runId, target)
				answer = yield* runOnce(request)
			}
			switch (answer._tag) {
				case "ExecutorRunExited":
					yield* Effect.annotateCurrentSpan({
						"maple.executor.exit_code": answer.exitCode,
						"maple.executor.timed_out": answer.timedOut,
						"maple.executor.promoted": answer.promoted.length,
					})
					return answer
				default:
					return yield* unavailable(answer.message)
			}
		},
	)

	const destroy: ExecutorServiceApi["destroy"] = (runId) =>
		transport.destroy(new ExecutorDestroyRequest({ executorKey: executorKey(runId) })).pipe(
			Effect.asVoid,
			Effect.catch((error) =>
				Effect.logWarning("could not destroy a security audit executor").pipe(
					Effect.annotateLogs({
						"maple.security_audit.run_id": runId,
						"error.message": error.message,
					}),
				),
			),
			Effect.withSpan("ExecutorService.destroy"),
		)

	return { available: transport.available, prepare, run, destroy }
}

export class ExecutorService extends Context.Service<ExecutorService, ExecutorServiceApi>()(
	"@maple/backend/services/sandbox/ExecutorService",
	{
		make: Effect.gen(function* () {
			const client = yield* SandboxClient
			const source = yield* VcsSourceService
			return makeExecutor({
				transport: client.executor,
				checkout: (orgId, target) =>
					source.resolveCheckout(orgId, target.repository, target.sha).pipe(
						Effect.mapBoth({
							onSuccess: (checkout) =>
								new SandboxCheckout({
									repository: checkout.fullName,
									sha: checkout.sha,
									remoteUrl: checkout.remoteUrl,
									token: checkout.token,
								}),
							onFailure: (error) => unavailable(`${error._tag}: ${error.message}`),
						}),
					),
			})
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
