import * as Argument from "effect/cli/Argument"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import { Array as Arr, Console, Effect, Option, Redacted, Stream, String as Str } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { MapleConfig } from "../core/config"
import { injectDirectory, type InjectResult } from "../core/sourcemaps"
import { uploadDirectory, type UploadOutcome } from "../core/sourcemaps-upload"
import { ApiResponseError, ApiTransportError } from "./api"
import { CliUsageError } from "../lib/errors"

const dirArg = Argument.Directory("dir", { mustExist: true }).pipe(
	Argument.withDescription("Build output directory, e.g. dist"),
)

const inject = Command.make("inject", {
	dir: dirArg,
	dryRun: Flag.Boolean("dry-run").pipe(
		Flag.withDescription("Report what would change without writing any file"),
		Flag.withDefault(false),
	),
}).pipe(
	Command.withDescription(
		"Add a debug id to every built JS file that has a source map, and to its map. Run after the build, before deploying and uploading; re-running changes nothing",
	),
	Command.withHandler(({ dir, dryRun }) =>
		Effect.gen(function* () {
			const results = yield* injectDirectory(dir, { dryRun })
			const verb = dryRun ? "would inject" : "injected"
			const mapOf = (r: InjectResult) => Option.getOrElse(r.mapPath, () => "")
			yield* Effect.forEach(results, (r) => {
				switch (r.status) {
					case "invalid_map":
						return Console.error(
							`warning: skipped ${r.file}: its source map ${mapOf(r)} is not a version 3 JSON object`,
						)
					case "unsafe_map":
						return Console.error(
							`warning: skipped ${r.file}: its source map ${mapOf(r)} is outside ${dir}`,
						)
					case "injected":
						return Console.log(`${verb} ${r.file} (${Option.getOrElse(r.debugId, () => "")})`)
					default:
						return Effect.void
				}
			})
			const count = (status: string) => Arr.filter(results, (r) => r.status === status).length
			yield* Console.log(
				`${dryRun ? "Would inject" : "Injected"} ${count("injected")} file(s); skipped ${count("already_injected")} already injected, ${count("no_map")} without a source map` +
					(count("invalid_map") > 0 ? `, ${count("invalid_map")} with an unreadable map` : "") +
					(count("unsafe_map") > 0 ? `, ${count("unsafe_map")} with a map outside ${dir}` : ""),
			)
		}),
	),
)

/** The commit checked out where `dir` is, when it is inside a git work tree. */
export const gitHead = (dir: string) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner
		const handle = yield* spawner.spawn(
			ChildProcess.make("git", ["rev-parse", "HEAD"], {
				cwd: dir,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
			}),
		)
		const [exitCode, stdout] = yield* Effect.all(
			[handle.exitCode, Stream.mkString(Stream.decodeText(handle.stdout))],
			{ concurrency: "unbounded" },
		)
		const sha = Str.trim(stdout)
		return exitCode === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? Option.some(sha) : Option.none<string>()
	}).pipe(
		Effect.scoped,
		Effect.orElseSucceed(() => Option.none<string>()),
	)

const remoteTarget = Effect.gen(function* () {
	const config = yield* MapleConfig
	const target = Option.all({ apiUrl: config.apiUrl, token: config.token })
	if (Option.isNone(target))
		return yield* new CliUsageError({
			message: "not logged in to a Maple workspace",
			hint: "run `maple login`, or set MAPLE_API_URL and MAPLE_API_TOKEN",
		})
	return { apiUrl: target.value.apiUrl, token: Redacted.value(target.value.token) }
})

const formatBytes = (n: number): string =>
	n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MiB` : `${(n / 1024).toFixed(1)} KiB`

const reportOutcome = (outcome: UploadOutcome): Effect.Effect<void> => {
	switch (outcome._tag) {
		case "uploaded":
			return Console.log(
				`uploaded ${outcome.minifiedPath} (${formatBytes(outcome.sizeBytes)}${Option.match(outcome.debugId, { onNone: () => "", onSome: (id) => `, ${id}` })})`,
			)
		case "skipped":
			return Console.error(`warning: skipped ${outcome.minifiedPath}: ${outcome.reason}`)
		case "failed":
			return Console.error(`failed ${outcome.minifiedPath}: ${outcome.error.message}`)
	}
}

/** Fails the command when nothing was uploaded or an upload failed, so CI stops there. */
export const checkUploadOutcomes = (
	dir: string,
	outcomes: ReadonlyArray<UploadOutcome>,
): Effect.Effect<void, CliUsageError | ApiResponseError | ApiTransportError> =>
	Effect.gen(function* () {
		const count = (tag: UploadOutcome["_tag"]) => Arr.filter(outcomes, (o) => o._tag === tag).length
		if (outcomes.length === 0)
			return yield* new CliUsageError({
				message: `no source maps with a matching JS file found under ${dir}`,
				hint: "build with source maps enabled, then run `maple sourcemaps inject` on the output",
			})
		if (count("skipped") === outcomes.length)
			return yield* new CliUsageError({
				message: "no source maps were uploaded; every matching map was skipped",
				hint: "check the skip warnings above",
			})
		const firstFailure = Arr.findFirst(outcomes, (o) => o._tag === "failed")
		if (Option.isSome(firstFailure) && firstFailure.value._tag === "failed") {
			// Reported as the raw API errors so a 4xx reads as the request to fix, not a CLI fault.
			const failed = firstFailure.value.error
			const message = `${count("failed")} source map upload(s) failed; first: ${failed.minifiedPath}: ${failed.message}`
			if (failed.status === undefined) return yield* new ApiTransportError({ message })
			return yield* failed.status === 401
				? new ApiResponseError({ status: 401, message, hint: "run `maple login` again" })
				: new ApiResponseError({ status: failed.status, message })
		}
	})

const upload = Command.make("upload", {
	dir: dirArg,
	service: Flag.optional(
		Flag.String("service").pipe(
			Flag.withDescription("Service name the maps belong to (OTel service.name)"),
		),
	),
	release: Flag.optional(
		Flag.String("release").pipe(
			Flag.withDescription(
				"Release the maps belong to (OTel service.version); defaults to `git rev-parse HEAD` when --service is set",
			),
		),
	),
	urlPrefix: Flag.optional(
		Flag.String("url-prefix").pipe(
			Flag.withDescription(
				"Path the files are served under, prepended to each file path, e.g. assets/",
			),
		),
	),
}).pipe(
	Command.withDescription(
		"Upload every source map in a build directory to the logged-in workspace so error stack traces show original source",
	),
	Command.withHandler(({ dir, service, release, urlPrefix }) =>
		Effect.gen(function* () {
			const { apiUrl, token } = yield* remoteTarget
			const version = Option.isSome(release) || Option.isNone(service) ? release : yield* gitHead(dir)
			const outcomes = yield* uploadDirectory(
				dir,
				{ apiUrl, token, service, version, urlPrefix, concurrency: 4 },
				reportOutcome,
			)
			const count = (tag: UploadOutcome["_tag"]) => Arr.filter(outcomes, (o) => o._tag === tag).length
			const bytes = Arr.reduce(outcomes, 0, (sum, o) =>
				o._tag === "uploaded" ? sum + o.sizeBytes : sum,
			)
			yield* Console.log(
				`Uploaded ${count("uploaded")} source map(s) (${formatBytes(bytes)}); ${count("skipped")} skipped, ${count("failed")} failed`,
			)
			return yield* checkUploadOutcomes(dir, outcomes)
		}),
	),
)

export const sourcemaps = Command.make("sourcemaps").pipe(
	Command.withDescription("Prepare and upload JavaScript source maps for readable error stack traces"),
	Command.withSubcommands([inject, upload]),
)
