/**
 * What the agents' sandbox tools call: grep, list, read and run, each phrased
 * as one bounded `SandboxRequest` over a repository mount and drained through
 * effect-agent's `Sandbox` port. The service knows the commands; the port
 * knows the container.
 */
import type { OrgId } from "@maple/domain/http"
import {
	Sandbox,
	SandboxEnvironment,
	SandboxLimits,
	SandboxRequest,
	type SandboxError,
	type SandboxEvent,
} from "@effect-agent/sandbox/Sandbox"
import { Context, Duration, Effect, Layer, Stream } from "effect"
import { NETWORK_DISABLED, REPO_MOUNT_TARGET, REPO_SANDBOX_RUNTIME, repoMount } from "./repo-mount"

/** Under the tool-output cap (50 KiB), so a full answer is never truncated a second time downstream. */
export const SANDBOX_MAX_OUTPUT_BYTES = 48 * 1024
export const SANDBOX_DEFAULT_TIMEOUT_SECONDS = 30
export const SANDBOX_MAX_TIMEOUT_SECONDS = 120
/** Matches `rg` refuses to read past; a bundled artifact is never the file an investigation wants. */
const MAX_SEARCHED_FILE = "4M"

export interface SandboxCommandResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
	readonly wallTimeMs: number
}

export interface RepositoryTarget {
	readonly repository: string
	readonly ref?: string | undefined
}

export interface GrepOptions {
	readonly pattern: string
	readonly path?: string | undefined
	readonly glob?: string | undefined
	readonly caseSensitive?: boolean | undefined
	readonly contextLines?: number | undefined
	/** Matches per file; the total is capped by the output bound. */
	readonly maxPerFile: number
}

export interface ReadFileOptions {
	readonly path: string
	readonly startLine: number
	readonly endLine: number
}

export interface ExecOptions {
	readonly command: string
	readonly args: ReadonlyArray<string>
	readonly cwd?: string | undefined
	readonly timeoutSeconds?: number | undefined
}

export interface RepoSandboxServiceApi {
	readonly grep: (
		orgId: OrgId,
		target: RepositoryTarget,
		options: GrepOptions,
	) => Effect.Effect<SandboxCommandResult, SandboxError>
	readonly listFiles: (
		orgId: OrgId,
		target: RepositoryTarget,
		options: { readonly path?: string | undefined; readonly glob?: string | undefined },
	) => Effect.Effect<SandboxCommandResult, SandboxError>
	readonly readFile: (
		orgId: OrgId,
		target: RepositoryTarget,
		options: ReadFileOptions,
	) => Effect.Effect<SandboxCommandResult, SandboxError>
	readonly exec: (
		orgId: OrgId,
		target: RepositoryTarget,
		options: ExecOptions,
	) => Effect.Effect<SandboxCommandResult, SandboxError>
}

const limits = (timeoutSeconds: number) =>
	new SandboxLimits({
		maxOutputBytes: SANDBOX_MAX_OUTPUT_BYTES,
		maxWallTime: Duration.seconds(timeoutSeconds),
	})

const environment = new SandboxEnvironment({ allow: ["PATH", "HOME", "LANG"] })

/** A workspace-relative path as the contract's absolute cwd/argument. */
const inWorkspace = (relative: string | undefined): string =>
	relative === undefined || relative === "" || relative === "."
		? REPO_MOUNT_TARGET
		: `${REPO_MOUNT_TARGET}/${relative.replace(/^\/+/, "")}`

/** Fold the event stream into what a tool renders. Non-zero exits are results, not failures: `rg` exits 1 on no match. */
const drain = (
	events: Stream.Stream<SandboxEvent, SandboxError>,
): Effect.Effect<SandboxCommandResult, SandboxError> =>
	Stream.runFold(
		events,
		(): SandboxCommandResult => ({ exitCode: 0, stdout: "", stderr: "", wallTimeMs: 0 }),
		(result, event): SandboxCommandResult => {
			switch (event._tag) {
				case "SandboxStarted":
					return result
				case "SandboxOutput":
					return event.stream === "stdout"
						? { ...result, stdout: result.stdout + event.text }
						: { ...result, stderr: result.stderr + event.text }
				case "SandboxExited":
					return {
						...result,
						exitCode: event.exitCode,
						wallTimeMs: Duration.toMillis(event.resourceUse.wallTime),
					}
			}
		},
	)

export class RepoSandboxService extends Context.Service<RepoSandboxService, RepoSandboxServiceApi>()(
	"@maple/api/services/sandbox/RepoSandboxService",
	{
		make: Effect.gen(function* () {
			const sandbox = yield* Sandbox

			const run = (
				orgId: OrgId,
				target: RepositoryTarget,
				command: string,
				args: ReadonlyArray<string>,
				cwd: string | undefined,
				timeoutSeconds: number,
			) =>
				drain(
					sandbox.execute(
						new SandboxRequest({
							runtime: REPO_SANDBOX_RUNTIME,
							command,
							args,
							cwd: inWorkspace(cwd),
							environment,
							mounts: [repoMount({ orgId, repository: target.repository, ref: target.ref })],
							network: NETWORK_DISABLED,
							limits: limits(timeoutSeconds),
							secretHandles: [],
							artifactRules: [],
						}),
					),
				)

			const grep: RepoSandboxServiceApi["grep"] = Effect.fn("RepoSandboxService.grep")(
				function* (orgId, target, options) {
					const args = [
						"--line-number",
						"--no-heading",
						"--color",
						"never",
						"--no-messages",
						"--max-columns",
						"240",
						"--max-columns-preview",
						"--max-filesize",
						MAX_SEARCHED_FILE,
						"--max-count",
						String(options.maxPerFile),
						options.caseSensitive === false ? "--ignore-case" : "--case-sensitive",
						...(options.contextLines ? ["--context", String(options.contextLines)] : []),
						...(options.glob ? ["--glob", options.glob] : []),
						"--regexp",
						options.pattern,
						// No positional without a path: `.` would prefix every hit with `./`.
						...(options.path ? ["--", options.path] : []),
					]
					return yield* run(orgId, target, "rg", args, undefined, SANDBOX_DEFAULT_TIMEOUT_SECONDS)
				},
			)

			const listFiles: RepoSandboxServiceApi["listFiles"] = Effect.fn("RepoSandboxService.listFiles")(
				function* (orgId, target, options) {
					const args = [
						"--files",
						"--color",
						"never",
						"--no-messages",
						...(options.glob ? ["--glob", options.glob] : []),
						...(options.path ? ["--", options.path] : []),
					]
					return yield* run(orgId, target, "rg", args, undefined, SANDBOX_DEFAULT_TIMEOUT_SECONDS)
				},
			)

			const readFile: RepoSandboxServiceApi["readFile"] = Effect.fn("RepoSandboxService.readFile")(
				function* (orgId, target, options) {
					// One pass numbers the requested lines and reports the total, so a truncated read can say how far it is from the end.
					const program = `NR>=s && NR<=e { printf "%d: %s\\n", NR, $0 } END { printf "__MAPLE_TOTAL_LINES__ %d\\n", NR }`
					const args = [
						"-v",
						`s=${options.startLine}`,
						"-v",
						`e=${options.endLine}`,
						program,
						// mawk reads `--` as a file name; anchoring the path keeps a leading `-` from parsing as an option.
						`./${options.path}`,
					]
					return yield* run(orgId, target, "awk", args, undefined, SANDBOX_DEFAULT_TIMEOUT_SECONDS)
				},
			)

			const exec: RepoSandboxServiceApi["exec"] = Effect.fn("RepoSandboxService.exec")(
				function* (orgId, target, options) {
					const timeout = Math.min(
						SANDBOX_MAX_TIMEOUT_SECONDS,
						Math.max(1, options.timeoutSeconds ?? SANDBOX_DEFAULT_TIMEOUT_SECONDS),
					)
					return yield* run(orgId, target, options.command, options.args, options.cwd, timeout)
				},
			)

			return { grep, listFiles, readFile, exec } satisfies RepoSandboxServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
