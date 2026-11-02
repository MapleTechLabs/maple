/** The git queries changesets makes (`@changesets/git`), over `effect/process`. */
import { Context, Effect, FileSystem, Layer, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { GitError } from "./errors.ts"

export interface GitResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
}

export interface GitApi {
	/** Runs `git <args>` in `cwd`; a non-zero exit is a result, not a failure. */
	readonly run: (args: ReadonlyArray<string>, cwd: string) => Effect.Effect<GitResult, GitError>
	/** For each path, the commit that added it (extending a shallow clone as needed), if any. */
	readonly commitsThatAddFiles: (
		paths: ReadonlyArray<string>,
		cwd: string,
	) => Effect.Effect<ReadonlyArray<string | undefined>, GitError>
	/** Absolute paths of files changed between the merge base of `ref` and HEAD. */
	readonly changedFilesSince: (ref: string, cwd: string) => Effect.Effect<ReadonlyArray<string>, GitError>
	/** Changeset files (`.changeset/*.md`, `.changeset/pre/*.md`) added or changed since `ref`. */
	readonly changedChangesetFilesSince: (
		ref: string,
		cwd: string,
	) => Effect.Effect<ReadonlyArray<string>, GitError>
}

export class Git extends Context.Service<Git, GitApi>()("@maple/changesets/Git", {
	make: Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path

		const run = (args: ReadonlyArray<string>, cwd: string) =>
			Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* spawner.spawn(ChildProcess.make("git", [...args], { cwd }))
					const [stdout, stderr, exitCode] = yield* Effect.all(
						[
							Stream.mkString(Stream.decodeText(handle.stdout)),
							Stream.mkString(Stream.decodeText(handle.stderr)),
							handle.exitCode,
						],
						{ concurrency: "unbounded" },
					)
					return { exitCode: Number(exitCode), stdout, stderr } satisfies GitResult
				}),
			).pipe(
				Effect.mapError(
					(cause) =>
						new GitError({
							message: `Could not run git: ${cause.message}`,
							args: [...args],
							stderr: "",
						}),
				),
			)

		const runOk = (args: ReadonlyArray<string>, cwd: string, message: string) =>
			Effect.flatMap(run(args, cwd), (result) =>
				result.exitCode === 0
					? Effect.succeed(result.stdout)
					: Effect.fail(new GitError({ message, args: [...args], stderr: result.stderr })),
			)

		const isShallow = Effect.fn("Git.isShallow")(function* (cwd: string) {
			const output = (yield* run(["rev-parse", "--is-shallow-repository"], cwd)).stdout.trim()
			if (output !== "--is-shallow-repository") return output === "true"
			// Git before 2.15 echoes the flag back; fall back to looking for `.git/shallow`.
			const gitDir = (yield* run(["rev-parse", "--git-dir"], cwd)).stdout.trim()
			return yield* fs
				.exists(path.join(path.resolve(cwd, gitDir), "shallow"))
				.pipe(Effect.orElseSucceed(() => false))
		})

		const lookup = (paths: ReadonlyArray<string>, cwd: string, found: ReadonlyMap<string, string>) =>
			Effect.gen(function* (): Effect.fn.Return<ReadonlyMap<string, string>, GitError> {
				const infos = yield* Effect.forEach(
					paths,
					(gitPath) =>
						Effect.map(
							run(
								[
									"log",
									"--diff-filter=AC",
									"--follow",
									"--max-count=1",
									"--pretty=format:%H:%p",
									gitPath,
								],
								cwd,
							),
							({ stdout }) => {
								const [commitSha = "", parentSha = ""] = stdout.split(":")
								return { gitPath, commitSha, parentSha }
							},
						),
					{ concurrency: 8 },
				)
				const resolved = new Map(found)
				infos.forEach((info) => {
					if (info.commitSha && info.parentSha) resolved.set(info.gitPath, info.commitSha)
				})
				const missingParents = infos.filter((info) => info.commitSha && !info.parentSha)
				if (missingParents.length === 0) return resolved
				if (yield* isShallow(cwd)) {
					yield* runOk(["fetch", "--deepen=50"], cwd, "Could not deepen the shallow clone")
					return yield* lookup(
						missingParents.map((info) => info.gitPath),
						cwd,
						resolved,
					)
				}
				missingParents.forEach((info) => resolved.set(info.gitPath, info.commitSha))
				return resolved
			})

		const commitsThatAddFiles = Effect.fn("Git.commitsThatAddFiles")(function* (
			paths: ReadonlyArray<string>,
			cwd: string,
		) {
			const commits = yield* lookup(paths, cwd, new Map())
			return paths.map((gitPath) => commits.get(gitPath))
		})

		const divergedCommit = (ref: string, cwd: string) =>
			Effect.map(
				runOk(
					["merge-base", ref, "HEAD"],
					cwd,
					`Failed to find where HEAD diverged from "${ref}". Does "${ref}" exist and it's synced with remote?`,
				),
				(stdout) => stdout.trim(),
			)

		const changedFilesSince = Effect.fn("Git.changedFilesSince")(function* (ref: string, cwd: string) {
			const diverged = yield* divergedCommit(ref, cwd)
			const files = (yield* runOk(
				["diff", "--name-only", "--no-relative", diverged],
				cwd,
				`Failed to diff against ${diverged}. Is ${diverged} a valid ref?`,
			))
				.trim()
				.split("\n")
				.filter((file) => file)
			const cdup = (yield* runOk(
				["rev-parse", "--show-cdup"],
				cwd,
				"Could not find the git root",
			)).trim()
			const repoRoot = path.resolve(cwd, cdup.replace(/\n|\r/g, ""))
			return files.map((file) => path.resolve(repoRoot, file))
		})

		const changedChangesetFilesSince = Effect.fn("Git.changedChangesetFilesSince")(function* (
			ref: string,
			cwd: string,
		) {
			const diverged = yield* divergedCommit(ref, cwd)
			const output = yield* runOk(
				["diff", "--name-only", "--diff-filter=d", "--no-relative", diverged],
				cwd,
				`Failed to diff against ${diverged}`,
			)
			return output
				.trim()
				.split("\n")
				.filter(
					(file) =>
						/\.changeset\/[^/]+\.md$/.test(file) || /\.changeset\/pre\/[^/]+\.md$/.test(file),
				)
		})

		return { run, commitsThatAddFiles, changedFilesSince, changedChangesetFilesSince } satisfies GitApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
