import { Clock, Duration, Effect, Option, Predicate, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import { dirname } from "node:path"
import { annotateOutcome, EXIT_START_REFUSED, markFailedExit } from "../core/outcomes"
import { describeFailure, formatFailure } from "../lib/failure"
import { dim } from "../lib/style"
import { dataDirSidecarPath } from "../server/store-version"

/**
 * Deterministic `maple start` refusals under a supervisor (launchd KeepAlive,
 * systemd, a shell loop) restarted the CLI about once a second for weeks, and
 * every restart billed one error event. A small record beside the data dir
 * lets a repeat of the same failure back off and stay out of telemetry.
 */

/** Failures that fail the same way on every retry until a human acts. */
const DETERMINISTIC_START_TAGS: ReadonlySet<string> = new Set([
	"@maple/cli/ChdbError",
	// The store refusals: each names a command a person has to run first.
	"@maple/cli/LocalStoreDirtyError",
	"@maple/cli/LocalStoreIncompatibleError",
	"@maple/cli/LocalStoreSchemaStaleError",
	"@maple/cli/LocalStoreFromNewerMapleError",
	"@maple/cli/LocalStoreMigrationError",
	"@maple/cli/ServerStateError",
	// A module that fails to load or register fails identically until it is replaced.
	"@maple/cli/ProjectorModuleError",
])

/** Deduped and backed off like the rest, but a supervisor should keep retrying:
 *  a port held by a server that is still stopping frees itself. */
const TRANSIENT_START_TAGS: ReadonlySet<string> = new Set(["@maple/cli/ServerBindError"])

/** A `start -d` child that exited with the refusal status already decided it is final. */
const isRefusedChildExit = (error: unknown): boolean =>
	describeFailure(error).tag === "@maple/cli/BackgroundServerExitedError" &&
	Predicate.hasProperty(error, "exitCode") &&
	error.exitCode === EXIT_START_REFUSED

/** Exits 78, so a supervisor configured for it stops restarting. */
export const isNonRestartableStartFailure = (error: unknown): boolean =>
	DETERMINISTIC_START_TAGS.has(describeFailure(error).tag) || isRefusedChildExit(error)

export const isGuardedStartFailure = (error: unknown): boolean =>
	isNonRestartableStartFailure(error) || TRANSIENT_START_TAGS.has(describeFailure(error).tag)

const StartFailureRecord = Schema.Struct({
	fingerprint: Schema.String,
	consecutive: Schema.Number,
	lastAtMs: Schema.Number,
	lastReportedAtMs: Schema.Number,
})
export type StartFailureRecord = typeof StartFailureRecord.Type

/** One error event per distinct failure per hour. */
export const REPORT_INTERVAL_MS = 60 * 60 * 1000
/** Failures further apart than this are not a restart loop. */
export const STREAK_WINDOW_MS = 10 * 60 * 1000
export const MAX_BACKOFF_MS = 60 * 1000

/** Tag plus message with numbers masked, so a changing PID or port is one failure. */
export const startFailureFingerprint = (error: unknown): string => {
	const report = describeFailure(error)
	return `${report.tag}:${report.message.replace(/\d+/g, "#")}`
}

export interface StartFailureDecision {
	readonly report: boolean
	readonly backoffMs: number
	readonly record: StartFailureRecord
}

/** Whether to report this failure and how long to wait before exiting. Interactive
 *  runs never wait: a person retrying by hand is not a restart loop. */
export const decideStartFailure = (
	previous: Option.Option<StartFailureRecord>,
	fingerprint: string,
	nowMs: number,
	interactive: boolean,
): StartFailureDecision => {
	const streak = Option.filter(
		previous,
		(record) => record.fingerprint === fingerprint && nowMs - record.lastAtMs < STREAK_WINDOW_MS,
	)
	const consecutive = Option.match(streak, { onNone: () => 1, onSome: (record) => record.consecutive + 1 })
	const report = Option.match(streak, {
		onNone: () => true,
		onSome: (record) => nowMs - record.lastReportedAtMs >= REPORT_INTERVAL_MS,
	})
	const lastReportedAtMs = Option.match(
		Option.filter(streak, () => !report),
		{
			onNone: () => nowMs,
			onSome: (record) => record.lastReportedAtMs,
		},
	)
	const backoffMs =
		interactive || consecutive < 3 ? 0 : Math.min(1000 * 2 ** (consecutive - 3), MAX_BACKOFF_MS)
	return {
		report,
		backoffMs,
		record: { fingerprint, consecutive, lastAtMs: nowMs, lastReportedAtMs },
	}
}

const RECORD_NAME = "start-failures.json"
/** A `start -d` child keeps its own streak; sharing one would reset both on every run. */
const CHILD_RECORD_NAME = "start-failures-child.json"

export const startFailuresPath = (dataDir: string, name: string = RECORD_NAME): string =>
	dataDirSidecarPath(dataDir, name)

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(StartFailureRecord))

export const readStartFailureRecord = (dataDir: string, name: string = RECORD_NAME) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem
		return yield* fs.readFileString(startFailuresPath(dataDir, name)).pipe(
			Effect.map(decodeRecord),
			Effect.orElseSucceed(() => Option.none<StartFailureRecord>()),
		)
	})

const writeRecord = (dataDir: string, name: string, record: StartFailureRecord) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem
		const path = startFailuresPath(dataDir, name)
		yield* fs.makeDirectory(dirname(path), { recursive: true })
		yield* fs.writeFileString(path, `${JSON.stringify(record)}\n`)
	}).pipe(Effect.ignore)

/** A server that came up ends any streak, its `start -d` parent's included. */
export const clearStartFailures = (dataDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem
		yield* fs.remove(startFailuresPath(dataDir, RECORD_NAME), { force: true })
		yield* fs.remove(startFailuresPath(dataDir, CHILD_RECORD_NAME), { force: true })
	}).pipe(Effect.ignore)

const handleStartFailure = <E>(
	dataDir: string,
	name: string,
	error: E,
	nowMs: number,
	interactive: boolean,
) =>
	Effect.gen(function* () {
		const previous = yield* readStartFailureRecord(dataDir, name)
		const decision = decideStartFailure(previous, startFailureFingerprint(error), nowMs, interactive)
		yield* writeRecord(dataDir, name, decision.record)
		if (isNonRestartableStartFailure(error)) {
			yield* Effect.sync(() => {
				process.exitCode = EXIT_START_REFUSED
			})
		}
		if (decision.backoffMs > 0) {
			yield* Effect.sync(() =>
				process.stderr.write(
					dim(
						`◌ maple start failed the same way ${decision.record.consecutive} times in a row; ` +
							`waiting ${Duration.format(Duration.millis(decision.backoffMs))} before exiting\n`,
					),
				),
			)
			yield* Effect.sleep(Duration.millis(decision.backoffMs))
		}
		if (decision.report) return yield* Effect.fail(error)
		// Already reported this hour: leave the root span `Ok`, but still exit
		// non-zero so `Restart=on-failure` and `SuccessfulExit=false` keep retrying.
		yield* annotateOutcome(`repeated:${describeFailure(error).tag}`)
		yield* Effect.sync(() => {
			process.stderr.write(formatFailure(describeFailure(error)))
			markFailedExit()
		})
	})

/** Back off and dedupe repeats of a start failure; non-restartable ones exit 78.
 *  `detachedChild`: a `start -d` child, which never waits since its parent is polling. */
export const guardStartFailures =
	(dataDir: string, options: { readonly detachedChild?: boolean } = {}) =>
	<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | void, E, R | FileSystem> =>
		self.pipe(
			Effect.catchIf(isGuardedStartFailure, (error) =>
				Effect.gen(function* () {
					const nowMs = yield* Clock.currentTimeMillis
					const interactive = yield* Effect.sync(
						() => options.detachedChild === true || process.stdin.isTTY === true,
					)
					const name = options.detachedChild === true ? CHILD_RECORD_NAME : RECORD_NAME
					return yield* handleStartFailure(dataDir, name, error, nowMs, interactive)
				}),
			),
		)
