/**
 * The paths changed between the prior run's commit and the pinned one. One `git diff` answers a
 * small change; a diff cut at the sandbox's output bound is split by directory until every part
 * fits, so a large change is still read in full rather than counted as everything changed.
 */
import type { OrgId } from "@maple/domain/http"
import type { SandboxError } from "@maple/backend/sandbox/contract"
import type {
	RepoSandboxServiceApi,
	RepositoryTarget,
	SandboxCommandResult,
} from "@maple/backend/services/sandbox/RepoSandboxService"
import { EVERYTHING_CHANGED } from "@maple/security-audit"
import { Effect, Ref, Schema } from "effect"

export const MAX_CHANGED_PATHS = 20_000
/** Sandbox calls one diff may spend splitting itself; past it the change counts as everything. */
export const MAX_DIFF_CALLS = 400

class DiffUnreadError extends Schema.TaggedError<DiffUnreadError>()(
	"@maple/ai/security-audit/DiffUnreadError",
	{ message: Schema.String },
) {}

const GIT = ["--no-optional-locks", "-c", "core.quotePath=false"]

const lines = (result: SandboxCommandResult) => result.stdout.split("\n").filter(Boolean)

/** The files directly inside `dir`: glob `*` never crosses a `/`. */
const directFiles = (dir: string) =>
	dir === "" ? ":(glob)*" : `:(glob)${dir.replace(/[*?[\]\\]/g, "\\$&")}/*`

export const changedPaths = (
	sandbox: RepoSandboxServiceApi,
	orgId: OrgId,
	target: RepositoryTarget,
	priorRef: string,
): Effect.Effect<ReadonlyArray<string>, SandboxError> =>
	Effect.gen(function* () {
		const calls = yield* Ref.make(0)
		const found = yield* Ref.make(0)

		const git = (args: ReadonlyArray<string>) =>
			Effect.gen(function* () {
				if ((yield* Ref.updateAndGet(calls, (n) => n + 1)) > MAX_DIFF_CALLS)
					return yield* new DiffUnreadError({ message: "too many directories to split" })
				const result = yield* sandbox.exec(orgId, target, { command: "git", args: [...GIT, ...args] })
				// A failed diff (an unreachable prior commit) is evidence of nothing.
				if (result.exitCode !== 0)
					return yield* new DiffUnreadError({ message: result.stderr.trim().slice(0, 300) })
				return result
			})

		// A rename lists only its new path without --no-renames; the old path changed too.
		const diff = (pathspec: ReadonlyArray<string>) =>
			git(["diff", "--name-only", "--no-renames", priorRef, "HEAD", "--", ...pathspec])

		const complete = (result: SandboxCommandResult) =>
			result.truncated
				? Effect.fail(
						new DiffUnreadError({ message: "one directory's listing exceeds the output bound" }),
					)
				: Effect.succeed(lines(result))

		const counted = (paths: ReadonlyArray<string>) =>
			Ref.updateAndGet(found, (n) => n + paths.length).pipe(
				Effect.flatMap((n) =>
					n > MAX_CHANGED_PATHS
						? Effect.fail(new DiffUnreadError({ message: "more changed paths than the cap" }))
						: Effect.succeed(paths),
				),
			)

		// Subdirectories on either side, so a directory the change deleted is still walked.
		const subdirectories = (dir: string) =>
			Effect.forEach([priorRef, "HEAD"], (rev) =>
				git([
					"--literal-pathspecs",
					"ls-tree",
					"-d",
					"--name-only",
					rev,
					...(dir === "" ? [] : ["--", `${dir}/`]),
				]).pipe(Effect.flatMap(complete)),
			).pipe(Effect.map((sides) => [...new Set(sides.flat())].sort()))

		const walk = (dir: string): Effect.Effect<ReadonlyArray<string>, SandboxError | DiffUnreadError> =>
			Effect.gen(function* () {
				const whole = yield* diff(dir === "" ? [] : [`:(literal)${dir}`])
				if (!whole.truncated) return yield* counted(lines(whole))
				const own = yield* diff([directFiles(dir)]).pipe(
					Effect.flatMap(complete),
					Effect.flatMap(counted),
				)
				const nested = yield* Effect.forEach(yield* subdirectories(dir), walk)
				return [...own, ...nested.flat()]
			})

		return yield* walk("")
	}).pipe(
		Effect.catchTag("@maple/ai/security-audit/DiffUnreadError", () =>
			Effect.succeed([EVERYTHING_CHANGED]),
		),
	)
