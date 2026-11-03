/**
 * Target-code execution for audit agents: `run_in_sandbox`, given to hunters and verifiers when the
 * run's executor prepared the commit. `AuditExecution` is the port: a deployed run answers it with
 * the execution sandbox (`ExecutorService`), the local runner with a Docker executor.
 */
import type { Ecosystem, ExecutionPolicy } from "@maple/security-audit"
import {
	EXECUTOR_LIMITS,
	type ExecutorCommandInput,
	type ExecutorInstall,
	executorLimitsText,
	ExecutorPromotion,
	ExecutorScratchPath,
	type ExecutorRunExited,
} from "@maple/domain/executor"
import { Effect, Schema, Semaphore, Array as Arr, String as Str } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { toolHandlersWithContent } from "../platform/genai-spans"
import { AUDIT_TOOLKIT, type SourceReaderApi, sourceHandlers, ToolFailure } from "./source"

export class AuditExecutionError extends Schema.TaggedError<AuditExecutionError>()(
	"@maple/ai/security-audit/ExecutionError",
	{ message: Schema.String },
) {}

export interface AuditExecutionApi {
	readonly run: (
		agentId: string,
		command: ExecutorCommandInput,
	) => Effect.Effect<ExecutorRunExited, AuditExecutionError>
}

/** Where the executor puts things, as the agent's commands see them. */
export const EXECUTOR_CHECKOUT = "/work/checkout"

const runInSandboxTool = Tool.make("run_in_sandbox", {
	description: Arr.join(
		[
			`Run a bash program against the audited commit inside the run's OS-enforced execution sandbox. The checkout is at ${EXECUTOR_CHECKOUT}, read-only, with its npm/pnpm/bun dependencies already installed (install scripts did not run); nothing can be installed or fetched.`,
			'Your scratch directory is the only writable place: cwd "scratch" starts there, and $HOME and $TMPDIR are inside it. Copy the checkout into scratch when a build must write beside the source.',
			"There is no network beyond loopback, so start any server the check needs inside the same command. Use dummy principals, data and secrets only.",
			`Limits: ${EXECUTOR_LIMITS.memoryBytes / 1024 / 1024} MiB memory, ${EXECUTOR_LIMITS.processes} processes, ${EXECUTOR_LIMITS.fileSizeBytes / 1024 / 1024} MiB per file, ${EXECUTOR_LIMITS.scratchBytes / 1024 / 1024} MiB scratch, ${EXECUTOR_LIMITS.maxTimeoutMs / 1000}s wall clock; output past ${EXECUTOR_LIMITS.outputBytes / 1024} KiB per stream is cut.`,
			"To keep evidence, write it to a file in scratch and list its path relative to scratch in promote (for example poc/out.txt, never a path under agents/): the parent copies it out after every process of the command has exited, and answers the exact artifacts path a local check must cite.",
		],
		" ",
	),
	parameters: Schema.Struct({
		command: Schema.String.annotate({ description: "The bash program to run" }),
		cwd: Schema.optional(Schema.Literals(["checkout", "scratch"])).annotate({
			description: 'Where it starts: "checkout" (default) or "scratch"',
		}),
		timeout_seconds: Schema.optional(Schema.Number).annotate({
			description: `Wall clock in seconds (default ${EXECUTOR_LIMITS.defaultTimeoutMs / 1000}, at most ${EXECUTOR_LIMITS.maxTimeoutMs / 1000})`,
		}),
		promote: Schema.optional(
			Schema.Array(
				Schema.Struct({
					path: Schema.String.annotate({ description: "Scratch-relative path of a regular file" }),
					max_bytes: Schema.optional(Schema.Number).annotate({
						description: `Largest size accepted (at most ${EXECUTOR_LIMITS.promotedFileBytes})`,
					}),
				}),
			),
		).annotate({ description: "Evidence files to keep once the command has exited" }),
	}),
	success: Schema.String,
	failure: ToolFailure,
	failureMode: "return",
})

export const EXECUTION_TOOLKIT = Toolkit.merge(AUDIT_TOOLKIT, Toolkit.make(runInSandboxTool))

/** How every prompt tells agents about execution when the run has it. */
export const EXECUTION_TOOL_GUIDANCE =
	"Hunters and verifiers also have run_in_sandbox, which runs commands against the audited commit in the parent-approved execution sandbox described in its own description; use it to reproduce a lead, never to reach anything outside the sandbox."

/** The ecosystems the execution sandbox installs and runs today. */
export const executableEcosystem = (ecosystem: Ecosystem): boolean => ecosystem === "node"

const installLine = (install: ExecutorInstall) =>
	`${install.dir === "." ? "the root" : install.dir} (${install.manager}, ${install.outcome}${install.outcome === "installed" ? "" : `: ${Str.slice(-200)(install.detail)}`})`

/** The run's policy once its executor prepared: the limits, where the checkout is, what installed. */
export const executionPolicy = (installs: ReadonlyArray<ExecutorInstall>): ExecutionPolicy => ({
	_tag: "Available",
	limits: `${executorLimitsText()}. The checkout is at ${EXECUTOR_CHECKOUT}. Lockfile installs: ${installs.length === 0 ? "none (no lockfile)" : Arr.join(Arr.map(installs, installLine), "; ")}.`,
})

const decodeScratchPath = Schema.decodeUnknownEffect(ExecutorScratchPath)

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(value)))

const stream = (name: string, text: string, bytes: number) =>
	text === "" && bytes === 0
		? []
		: [
				`--- ${name}${bytes > new TextEncoder().encode(text).length ? ` (${bytes} bytes, first ${EXECUTOR_LIMITS.outputBytes / 1024} KiB shown)` : ""} ---`,
				text,
			]

/** Where the run keeps an agent's promoted file, as a `local` check cites it. */
export const artifactPath = (agentId: string, path: string) => `agents/${agentId}/artifacts/${path}`

/** The command's answer as the model reads it. */
export const renderRun = (agentId: string, result: ExecutorRunExited): string =>
	Arr.join(
		[
			`exit ${result.exitCode}${result.timedOut ? " (killed at its wall clock)" : ""}, ${result.wallTimeMs} ms`,
			...stream("stdout", result.stdout, result.stdoutBytes),
			...stream("stderr", result.stderr, result.stderrBytes),
			...(result.promoted.length === 0
				? []
				: [
						"--- promoted ---",
						...Arr.map(
							result.promoted,
							(artifact) =>
								`${artifact.path}: ${artifact.bytes} bytes, sha256 ${artifact.sha256}; cite it in a local check as ${artifactPath(agentId, artifact.path)}\n${artifact.preview}`,
						),
					]),
			...(result.rejected.length === 0
				? []
				: [
						"--- not promoted ---",
						...Arr.map(result.rejected, (rejected) => `${rejected.path}: ${rejected.reason}`),
					]),
		],
		"\n",
	)

/**
 * The read tools plus `run_in_sandbox` for one agent. `onCall` counts every tool call, as for
 * the read-only toolkit; `onPromoted` receives each file the parent promoted, as a check cites it.
 */
export const executionToolHandlers = (
	source: SourceReaderApi,
	execution: AuditExecutionApi,
	agentId: string,
	onCall: Effect.Effect<void> = Effect.void,
	onPromoted: (paths: ReadonlyArray<string>) => Effect.Effect<void> = () => Effect.void,
) => {
	// One command at a time per agent: parallel tool calls would only queue in the executor's slots.
	const oneAtATime = Semaphore.makeUnsafe(1)
	return toolHandlersWithContent(
		EXECUTION_TOOLKIT,
		EXECUTION_TOOLKIT.of({
			...sourceHandlers(source, onCall),
			run_in_sandbox: ({ command, cwd, timeout_seconds, promote }) =>
				Effect.gen(function* () {
					yield* onCall
					const promotions = yield* Effect.forEach(promote ?? [], (entry) =>
						decodeScratchPath(entry.path).pipe(
							Effect.mapBoth({
								onSuccess: (path) =>
									new ExecutorPromotion({
										path,
										maxBytes: clamp(
											entry.max_bytes ?? EXECUTOR_LIMITS.promotedFileBytes,
											1,
											EXECUTOR_LIMITS.promotedFileBytes,
										),
									}),
								onFailure: (): ToolFailure => ({
									message: `promote path ${entry.path} must be scratch-relative, with no empty, "." or ".." part`,
								}),
							}),
						),
					)
					if (promotions.length > EXECUTOR_LIMITS.promotedFiles)
						return yield* Effect.fail<ToolFailure>({
							message: `promote at most ${EXECUTOR_LIMITS.promotedFiles} files per command`,
						})
					const result = yield* oneAtATime
						.withPermits(1)(
							execution.run(agentId, {
								command,
								cwd: cwd ?? "checkout",
								timeoutMs:
									clamp(
										timeout_seconds ?? EXECUTOR_LIMITS.defaultTimeoutMs / 1000,
										1,
										EXECUTOR_LIMITS.maxTimeoutMs / 1000,
									) * 1000,
								promote: promotions,
							}),
						)
						.pipe(Effect.mapError((error): ToolFailure => ({ message: error.message })))
					yield* onPromoted(
						Arr.map(result.promoted, (artifact) => artifactPath(agentId, artifact.path)),
					)
					return renderRun(agentId, result)
				}),
		}),
	)
}
