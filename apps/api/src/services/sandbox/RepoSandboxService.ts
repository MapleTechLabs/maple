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
/**
 * Cloudflare's sandbox image ships git but not ripgrep, and the checkout is a
 * real clone — so `git grep` and `git ls-files` are both what is available and
 * what already understands the repository: tracked files only, no `.git`
 * internals, and none of the build output `.gitignore` excludes.
 */
const GIT_COMMON = ["--no-optional-locks", "-c", "core.quotePath=false"]

/**
 * One pathspec from a directory and a glob.
 *
 * Git ORs multiple pathspecs, so passing a directory and a glob separately
 * *widens* the search: it returns every file the glob matches anywhere in the
 * repository, plus everything under the directory. The tools present the two as
 * filters, so they are combined into a single pattern instead.
 */
export const gitPathspec = (path: string | undefined, glob: string | undefined): ReadonlyArray<string> => {
	const dir = path?.replace(/\/+$/, "")
	if (glob === undefined) return dir === undefined ? [] : [dir]
	return [`:(glob)${dir === undefined ? glob : `${dir}/${glob}`}`]
}

export interface SandboxCommandResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
	readonly wallTimeMs: number
	/** The container cut the stream at the output bound; this is its prefix. */
	readonly truncated: boolean
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
const utf8 = new TextEncoder()

const drain = (
	events: Stream.Stream<SandboxEvent, SandboxError>,
): Effect.Effect<SandboxCommandResult, SandboxError> =>
	Stream.runFold(
		events,
		(): SandboxCommandResult => ({
			exitCode: 0,
			stdout: "",
			stderr: "",
			wallTimeMs: 0,
			truncated: false,
		}),
		(result, event): SandboxCommandResult => {
			switch (event._tag) {
				case "SandboxStarted":
					return result
				case "SandboxOutput": {
					// `bytes` is the stream's real size; more of it than arrived means the
					// container cut it at the bound.
					const truncated = result.truncated || event.bytes > utf8.encode(event.text).length
					return event.stream === "stdout"
						? { ...result, stdout: result.stdout + event.text, truncated }
						: { ...result, stderr: result.stderr + event.text, truncated }
				}
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
						...GIT_COMMON,
						"grep",
						"--line-number",
						"--no-color",
						// Binary hits are noise in a source search, and their bytes still
						// count against the output bound.
						// `git grep` gained --max-count after the version this image ships,
						// so per-file capping is not available; the output bound and the
						// tool's own line cap are what keep a result readable.
						"-I",
						...(options.caseSensitive === false ? ["--ignore-case"] : []),
						...(options.contextLines ? ["--context", String(options.contextLines)] : []),
						"-e",
						options.pattern,
						// Everything past `--` is a pathspec, so a pattern that starts with a
						// dash can never be read as an option.
						"--",
						...gitPathspec(options.path, options.glob),
					]
					return yield* run(orgId, target, "git", args, undefined, SANDBOX_DEFAULT_TIMEOUT_SECONDS)
				},
			)

			const listFiles: RepoSandboxServiceApi["listFiles"] = Effect.fn("RepoSandboxService.listFiles")(
				function* (orgId, target, options) {
					const args = [
						...GIT_COMMON,
						"ls-files",
						"--cached",
						"--",
						...gitPathspec(options.path, options.glob),
					]
					return yield* run(orgId, target, "git", args, undefined, SANDBOX_DEFAULT_TIMEOUT_SECONDS)
				},
			)

			const readFile: RepoSandboxServiceApi["readFile"] = Effect.fn("RepoSandboxService.readFile")(
				function* (orgId, target, options) {
					// `git ls-files --error-unmatch` first: `awk` would follow a symlink out
					// of the checkout, and only tracked files are readable through this tool.
					// One pass then numbers the requested lines and reports the total, so a
					// truncated read can say how far it is from the end.
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
					const tracked = yield* run(
						orgId,
						target,
						"git",
						[...GIT_COMMON, "ls-files", "--error-unmatch", "--", options.path],
						undefined,
						SANDBOX_DEFAULT_TIMEOUT_SECONDS,
					)
					if (tracked.exitCode !== 0) return tracked
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
