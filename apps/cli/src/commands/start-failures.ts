import { Clock, Duration, Effect, Option, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import { dirname } from "node:path"
import { annotateOutcome, EXIT_START_REFUSED } from "../core/outcomes"
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
	"@maple/cli/ServerBindError",
	// The store refusals: each names a command a person has to run first.
	"@maple/cli/LocalStoreDirtyError",
	"@maple/cli/LocalStoreIncompatibleError",
	"@maple/cli/LocalStoreSchemaStaleError",
	"@maple/cli/LocalStoreFromNewerMapleError",
	"@maple/cli/LocalStoreMigrationError",
	"@maple/cli/ServerStateError",
])

export const isDeterministicStartFailure = (error: unknown): boolean =>
	DETERMINISTIC_START_TAGS.has(describeFailure(error).tag)

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

export const startFailuresPath = (dataDir: string): string =>
	dataDirSidecarPath(dataDir, "start-failures.json")

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(StartFailureRecord))

export const readStartFailureRecord = (dataDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem
		return yield* fs.readFileString(startFailuresPath(dataDir)).pipe(
			Effect.map(decodeRecord),
			Effect.orElseSucceed(() => Option.none<StartFailureRecord>()),
		)
	})

const writeRecord = (dataDir: string, record: StartFailureRecord) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem
		const path = startFailuresPath(dataDir)
		yield* fs.makeDirectory(dirname(path), { recursive: true })
		yield* fs.writeFileString(path, `${JSON.stringify(record)}\n`)
	}).pipe(Effect.ignore)

/** A server that came up ends any streak. */
export const clearStartFailures = (dataDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem
		yield* fs.remove(startFailuresPath(dataDir), { force: true })
	}).pipe(Effect.ignore)

const handleStartFailure = <E>(dataDir: string, error: E, nowMs: number, interactive: boolean) =>
	Effect.gen(function* () {
		const previous = yield* readStartFailureRecord(dataDir)
		const decision = decideStartFailure(previous, startFailureFingerprint(error), nowMs, interactive)
		yield* writeRecord(dataDir, decision.record)
		yield* Effect.sync(() => {
			process.exitCode = EXIT_START_REFUSED
		})
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
		// Already reported this hour: print it, but leave the root span `Ok`.
		yield* annotateOutcome(`repeated:${describeFailure(error).tag}`)
		yield* Effect.sync(() => process.stderr.write(formatFailure(describeFailure(error))))
	})

/** Back off and dedupe repeats of a deterministic start failure; exit code 78 either way. */
export const guardStartFailures =
	(dataDir: string, options: { readonly neverWait?: boolean } = {}) =>
	<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | void, E, R | FileSystem> =>
		self.pipe(
			Effect.catchIf(isDeterministicStartFailure, (error) =>
				Effect.gen(function* () {
					const nowMs = yield* Clock.currentTimeMillis
					const interactive = yield* Effect.sync(
						() => options.neverWait === true || process.stdin.isTTY === true,
					)
					return yield* handleStartFailure(dataDir, error, nowMs, interactive)
				}),
			),
		)
