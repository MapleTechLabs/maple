/**
 * Fixture monorepos for the differential test. A fixture is `input/` plus an optional
 * `fixture.json`; it is copied to a temp dir and committed with a fixed author and date,
 * so the commit hashes the changelog quotes are the same for every run and every tool.
 */
import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export const FixtureSpec = Schema.Struct({
	/** Files committed in a second commit on a `feature` branch. */
	later: Schema.optionalKey(Schema.Array(Schema.String)),
	/** Files left uncommitted, so changesets finds no commit for them. */
	uncommitted: Schema.optionalKey(Schema.Array(Schema.String)),
})

export const Outcome = Schema.Struct({
	exitCode: Schema.Number,
	changed: Schema.Record(Schema.String, Schema.String),
	deleted: Schema.Array(Schema.String),
})
export type Outcome = typeof Outcome.Type

export const Expected = Schema.Struct({
	version: Outcome,
	status: Schema.Struct({ exitCode: Schema.Number, output: Schema.NullOr(Schema.String) }),
})
export type Expected = typeof Expected.Type

export class FixtureError extends Schema.TaggedError<FixtureError>()("@maple/changesets/FixtureError", {
	message: Schema.String,
}) {}

const gitEnv = {
	GIT_AUTHOR_NAME: "Fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.com",
	GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
	GIT_COMMITTER_NAME: "Fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.com",
	GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
}

export const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const handle = yield* spawner.spawn(
				ChildProcess.make(command, [...args], { cwd, env: gitEnv, extendEnv: true }),
			)
			const [stdout, stderr, exitCode] = yield* Effect.all(
				[
					Stream.mkString(Stream.decodeText(handle.stdout)),
					Stream.mkString(Stream.decodeText(handle.stderr)),
					handle.exitCode,
				],
				{ concurrency: "unbounded" },
			)
			return { stdout, stderr, exitCode: Number(exitCode) }
		}),
	)

const git = (args: ReadonlyArray<string>, cwd: string) =>
	Effect.flatMap(
		run("git", ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], cwd),
		(result) =>
			result.exitCode === 0
				? Effect.succeed(result.stdout)
				: Effect.fail(new FixtureError({ message: `git ${args.join(" ")}: ${result.stderr}` })),
	)

/** Every file under `dir` except `.git`, keyed by `/`-separated relative path. */
export const snapshotTree = Effect.fn("snapshotTree")(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const files = yield* fs.glob("**", { root: dir, dot: true, exclude: [".git"] })
	const entries = yield* Effect.forEach(files.toSorted(), (file) =>
		Effect.gen(function* () {
			const info = yield* fs.stat(path.join(dir, file))
			return info.type === "File"
				? [[file, yield* fs.readFileString(path.join(dir, file))] as const]
				: []
		}),
	)
	return new Map(entries.flat())
})

export const diffTrees = (
	before: ReadonlyMap<string, string>,
	after: ReadonlyMap<string, string>,
	exitCode: number,
): Outcome => ({
	exitCode,
	changed: Object.fromEntries([...after].filter(([file, contents]) => before.get(file) !== contents)),
	deleted: [...before.keys()].filter((file) => !after.has(file)),
})

/** Copies `fixtureDir/input` to `workDir` and commits it as a deterministic git repository. */
export const setupFixture = Effect.fn("setupFixture")(function* (fixtureDir: string, workDir: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const specFile = path.join(fixtureDir, "fixture.json")
	const spec = (yield* fs.exists(specFile))
		? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FixtureSpec))(
				yield* fs.readFileString(specFile),
			)
		: {}
	yield* fs.copy(path.join(fixtureDir, "input"), workDir)
	const held = [...(spec.later ?? []), ...(spec.uncommitted ?? [])]
	const contents = yield* Effect.forEach(held, (file) => fs.readFileString(path.join(workDir, file)))
	const restore = (files: ReadonlyArray<string>) =>
		Effect.forEach(
			files,
			(file) => fs.writeFileString(path.join(workDir, file), contents[held.indexOf(file)] ?? ""),
			{
				discard: true,
			},
		)
	yield* Effect.forEach(held, (file) => fs.remove(path.join(workDir, file)), { discard: true })
	yield* git(["init", "--quiet", "-b", "main"], workDir)
	yield* git(["add", "-A"], workDir)
	yield* git(["commit", "--quiet", "-m", "initial"], workDir)
	if ((spec.later ?? []).length > 0) {
		yield* restore(spec.later ?? [])
		yield* git(["checkout", "--quiet", "-b", "feature"], workDir)
		yield* git(["add", "-A"], workDir)
		yield* git(["commit", "--quiet", "-m", "later"], workDir)
	}
	yield* restore(spec.uncommitted ?? [])
})
