/**
 * What runs inside the sandbox container: bounded command execution over a
 * checkout, plus the archive restore that puts the checkout there. Written over
 * `ChildProcessSpawner` and `FileSystem` only, so the same code runs under the
 * container's Bun services and under vitest on a developer machine.
 */
import { Clock, Duration, Effect, Schema, Stream } from "effect"
import type { FileSystem } from "effect/FileSystem"
import type { PlatformError } from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle, ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import {
	SAFE_ENVIRONMENT,
	type SandboxExecInput,
	type SandboxExecOutput,
	type SandboxWorkspace,
} from "../protocol"

export interface SandboxRuntimeDeps {
	readonly spawner: ChildProcessSpawner["Service"]
	readonly fs: FileSystem
	/** Directory holding one checkout per SHA. */
	readonly root: string
	/** Run commands as this user (via `runuser`); absent under tests, where the tree is not root-owned. */
	readonly runAs?: string
	/** The container's own environment, the only source a command's variables are copied from. */
	readonly environment: Readonly<Record<string, string | undefined>>
}

export interface SandboxRuntime {
	readonly listWorkspaces: () => Effect.Effect<ReadonlyArray<SandboxWorkspace>>
	readonly removeWorkspace: (sha: string) => Effect.Effect<void>
	readonly exec: (input: SandboxExecInput) => Effect.Effect<SandboxExecOutput>
	/** Extract a gzipped tarball (GitHub's archive shape, one top-level directory) into a fresh workspace. */
	readonly restoreArchive: <E>(
		sha: string,
		archive: Stream.Stream<Uint8Array, E>,
	) => Effect.Effect<{ readonly bytes: number }, RestoreError>
}

export class RestoreError extends Schema.TaggedError<RestoreError>()("@maple/api/sandbox/RestoreError", {
	message: Schema.String,
}) {}

const SHA_PATTERN = /^[0-9a-f]{40}$/

export const isCommitSha = (value: string): boolean => SHA_PATTERN.test(value)

/** A workspace-relative path that stays inside the workspace, or `undefined`. */
export const resolveWorkspacePath = (workspace: string, relative: string): string | undefined => {
	const segments: string[] = []
	for (const segment of relative.split("/")) {
		if (segment === "" || segment === ".") continue
		if (segment === "..") {
			if (segments.length === 0) return undefined
			segments.pop()
			continue
		}
		segments.push(segment)
	}
	return segments.length === 0 ? workspace : `${workspace}/${segments.join("/")}`
}

/** The subset of the container environment a command may see. */
export const commandEnvironment = (
	ambient: Readonly<Record<string, string | undefined>>,
	allow: ReadonlyArray<string>,
): Record<string, string> => {
	const env: Record<string, string> = {}
	for (const name of SAFE_ENVIRONMENT) {
		const value = ambient[name]
		if (allow.includes(name) && value !== undefined) env[name] = value
	}
	return env
}

const OUTPUT_LIMIT = Symbol.for("@maple/api/sandbox/output-limit")

interface Collected {
	readonly text: string
	readonly bytes: number
	readonly exceeded: boolean
}

/** Drain one output stream up to `limit` bytes; past it, stop reading and run `onExceed`. */
const collect = (
	stream: Stream.Stream<Uint8Array, PlatformError>,
	limit: number,
	onExceed: Effect.Effect<void, PlatformError>,
): Effect.Effect<Collected, PlatformError> =>
	Effect.gen(function* () {
		const chunks: Uint8Array[] = []
		let bytes = 0
		const exceeded = yield* stream.pipe(
			Stream.runForEach((chunk) => {
				bytes += chunk.length
				chunks.push(chunk)
				return bytes > limit ? Effect.fail(OUTPUT_LIMIT) : Effect.void
			}),
			Effect.as(false),
			Effect.catch((error) =>
				error === OUTPUT_LIMIT ? onExceed.pipe(Effect.as(true)) : Effect.fail(error),
			),
		)
		const joined = new Uint8Array(bytes)
		let offset = 0
		for (const chunk of chunks) {
			joined.set(chunk, offset)
			offset += chunk.length
		}
		return { text: new TextDecoder().decode(joined.subarray(0, Math.min(bytes, limit))), bytes, exceeded }
	})

export const makeSandboxRuntime = (deps: SandboxRuntimeDeps): SandboxRuntime => {
	const { spawner, fs, root } = deps
	const lastUsed = new Map<string, number>()
	const workspaceDir = (sha: string) => `${root}/${sha}`

	const listWorkspaces = Effect.fn("SandboxRuntime.listWorkspaces")(function* () {
		const exists = yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false))
		if (!exists) return []
		const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))
		return entries.filter(isCommitSha).map((sha) => ({ sha, lastUsedAtMs: lastUsed.get(sha) ?? 0 }))
	})

	const run = (command: ChildProcess.Command) => spawner.exitCode(command).pipe(Effect.map(Number))

	const removeWorkspace = Effect.fn("SandboxRuntime.removeWorkspace")(function* (sha: string) {
		if (!isCommitSha(sha)) return
		lastUsed.delete(sha)
		// The tree was made read-only on restore; hand write access back before removing it.
		yield* run(ChildProcess.make("chmod", ["-R", "u+w", workspaceDir(sha)])).pipe(Effect.ignore)
		yield* fs.remove(workspaceDir(sha), { recursive: true, force: true }).pipe(Effect.ignore)
	})

	const restoreArchive: SandboxRuntime["restoreArchive"] = Effect.fn("SandboxRuntime.restoreArchive")(
		function* <E>(sha: string, archive: Stream.Stream<Uint8Array, E>) {
			if (!isCommitSha(sha)) return yield* new RestoreError({ message: "sha must be a 40-hex commit" })
			const target = workspaceDir(sha)
			const staging = `${target}.partial`
			const tarball = `${root}/${sha}.tgz`
			const failed = (message: string) => (cause: unknown) =>
				new RestoreError({
					message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
				})
			yield* fs.makeDirectory(staging, { recursive: true }).pipe(Effect.mapError(failed("mkdir")))
			yield* Stream.run(archive, fs.sink(tarball)).pipe(Effect.mapError(failed("download")))
			const size = yield* fs.stat(tarball).pipe(
				Effect.map((info) => Number(info.size)),
				Effect.mapError(failed("stat")),
			)
			const untar = yield* run(
				ChildProcess.make("tar", ["-xzf", tarball, "--strip-components=1", "-C", staging]),
			).pipe(Effect.mapError(failed("tar")))
			yield* fs.remove(tarball, { force: true }).pipe(Effect.ignore)
			if (untar !== 0) {
				yield* fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)
				return yield* new RestoreError({ message: `tar exited with ${untar}` })
			}
			// Read-only for everyone but root: what makes the mount's `read-only` honest.
			yield* run(ChildProcess.make("chmod", ["-R", "a-w", staging])).pipe(
				Effect.mapError(failed("chmod")),
			)
			yield* fs.rename(staging, target).pipe(Effect.mapError(failed("rename")))
			lastUsed.set(sha, yield* Clock.currentTimeMillis)
			return { bytes: size }
		},
	)

	const exec: SandboxRuntime["exec"] = Effect.fn("SandboxRuntime.exec")(function* (input) {
		if (!isCommitSha(input.sha)) return { _tag: "missing-workspace", sha: input.sha }
		const workspace = workspaceDir(input.sha)
		if (!(yield* fs.exists(workspace).pipe(Effect.orElseSucceed(() => false))))
			return { _tag: "missing-workspace", sha: input.sha }
		const cwd = resolveWorkspacePath(workspace, input.cwd)
		if (cwd === undefined) return { _tag: "spawn-failed", message: "cwd escapes the workspace" }
		lastUsed.set(input.sha, yield* Clock.currentTimeMillis)

		const argv =
			deps.runAs === undefined
				? [input.command, ...input.args]
				: ["runuser", "-u", deps.runAs, "--", input.command, ...input.args]
		const command = ChildProcess.make(argv[0]!, argv.slice(1), {
			cwd,
			env: commandEnvironment(deps.environment, input.envAllow),
			extendEnv: false,
		})
		const startedAt = yield* Clock.currentTimeMillis
		const elapsed = Effect.map(Clock.currentTimeMillis, (now) => now - startedAt)

		const attempt = Effect.gen(function* () {
			const handle: ChildProcessHandle = yield* spawner.spawn(command)
			// Once the bound is hit the process is killed, and whatever its streams and exit
			// code report after that is noise: the outcome is already "output-limit".
			let killed = false
			const kill = Effect.suspend(() => {
				killed = true
				return handle.kill().pipe(Effect.ignore)
			})
			const afterKill =
				<A>(fallback: A) =>
				(error: PlatformError) =>
					killed ? Effect.succeed(fallback) : Effect.fail(error)
			const [stdout, stderr, exitCode] = yield* Effect.all(
				[
					collect(handle.stdout, input.maxOutputBytes, kill).pipe(
						Effect.catch(afterKill<Collected>({ text: "", bytes: 0, exceeded: false })),
					),
					collect(handle.stderr, input.maxOutputBytes, kill).pipe(
						Effect.catch(afterKill<Collected>({ text: "", bytes: 0, exceeded: false })),
					),
					handle.exitCode.pipe(Effect.map(Number), Effect.catch(afterKill(-1))),
				],
				{ concurrency: "unbounded" },
			)
			const wallTimeMs = yield* elapsed
			if (stdout.exceeded)
				return {
					_tag: "output-limit",
					stream: "stdout",
					limit: input.maxOutputBytes,
					observed: stdout.bytes,
				} satisfies SandboxExecOutput
			if (stderr.exceeded)
				return {
					_tag: "output-limit",
					stream: "stderr",
					limit: input.maxOutputBytes,
					observed: stderr.bytes,
				} satisfies SandboxExecOutput
			return {
				_tag: "exited",
				exitCode,
				stdout: stdout.text,
				stderr: stderr.text,
				stdoutBytes: stdout.bytes,
				stderrBytes: stderr.bytes,
				wallTimeMs,
			} satisfies SandboxExecOutput
		}).pipe(
			// Closing the scope kills a process that is still running: the timeout below relies on it.
			Effect.scoped,
			Effect.timeoutOrElse({
				duration: Duration.millis(input.maxWallTimeMs),
				orElse: () =>
					Effect.map(
						elapsed,
						(wallTimeMs) => ({ _tag: "timed-out", wallTimeMs }) satisfies SandboxExecOutput,
					),
			}),
			Effect.catch((error) =>
				Effect.succeed({ _tag: "spawn-failed", message: error.message } satisfies SandboxExecOutput),
			),
		)
		return yield* attempt
	})

	return { listWorkspaces, removeWorkspace, exec, restoreArchive }
}
