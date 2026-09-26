// Archive calibration was removed. A run an older Maple interrupted can leave a
// checkpoint pin, restored scratch and sample output behind. Archive
// reconciliation retires them so a stale pin never over-retains a checkpoint.

import { type Dirent, readdirSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Option, Result } from "effect"
import { debugLog } from "../../lib/debug"
import { assertCheckpointPinIdentity, checkpointPinsRoot, releaseCheckpointPin } from "../checkpoints"
import { ArchiveError } from "./errors"
import { classifyArchivePathSync } from "./paths"

/** The pin purpose every calibration run used (`archive-calibrate:<operation-id>`). */
const PIN_PURPOSE_PREFIX = "archive-calibrate:"
/** Calibration's derived scratch subdir: `calibrate-<operation-id>`. */
const SCRATCH_SUBDIR = /^calibrate-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface LegacyCalibrationCleanup {
	readonly releasedPins: number
	readonly removedDirectories: number
	readonly failures: ReadonlyArray<string>
}

const archiveError = (error: unknown): ArchiveError =>
	new ArchiveError({ message: error instanceof Error ? error.message : String(error) })

/** Directory entries, or none when the directory is absent or unreadable. */
const entriesOf = (dir: string): Effect.Effect<ReadonlyArray<Dirent>> =>
	Effect.try({ try: () => readdirSync(dir, { withFileTypes: true }), catch: archiveError }).pipe(
		Effect.orElseSucceed((): ReadonlyArray<Dirent> => []),
	)

/** Remove `path` only when it is a real directory beneath `root` (no symlinks). */
const removeOwnedDirectory = (
	root: string,
	path: string,
	label: string,
): Effect.Effect<boolean, ArchiveError> =>
	Effect.try({ try: () => classifyArchivePathSync(root, path, label), catch: archiveError }).pipe(
		Effect.flatMap((topology) =>
			topology === "real-directory"
				? Effect.tryPromise({
						try: () => rm(path, { recursive: true, force: true }),
						catch: archiveError,
					}).pipe(Effect.as(true))
				: Effect.succeed(false),
		),
	)

/**
 * Release every calibration pin, remove calibration scratch and the archive's
 * `calibration/` tree. Must run under the maintenance lock. Never fails: a
 * leftover it cannot remove stays over-retained and is reported under --debug.
 */
export const retireLegacyCalibration = (
	dataDir: string,
	archiveDir: string,
	scratchRoot: string,
): Effect.Effect<LegacyCalibrationCleanup> =>
	Effect.gen(function* () {
		const failures: string[] = []
		let releasedPins = 0
		let removedDirectories = 0
		const pinsRoot = checkpointPinsRoot(dataDir)
		for (const checkpointDir of yield* entriesOf(pinsRoot)) {
			if (!checkpointDir.isDirectory()) continue
			const checkpointId = checkpointDir.name
			for (const file of yield* entriesOf(join(pinsRoot, checkpointId))) {
				if (!file.isFile() || !file.name.endsWith(".json")) continue
				const pinPath = join(pinsRoot, checkpointId, file.name)
				// A pin that does not validate is not provably calibration's; leave it.
				const pin = yield* Effect.tryPromise({
					try: () => assertCheckpointPinIdentity(dataDir, checkpointId, pinPath),
					catch: archiveError,
				}).pipe(Effect.option)
				if (Option.isNone(pin) || !pin.value.purpose.startsWith(PIN_PURPOSE_PREFIX)) continue
				const released = yield* Effect.tryPromise({
					try: () => releaseCheckpointPin(dataDir, checkpointId, pinPath, pin.value.purpose),
					catch: archiveError,
				}).pipe(Effect.result)
				if (Result.isSuccess(released)) releasedPins++
				else failures.push(`pin ${pinPath}: ${released.failure.message}`)
			}
		}
		for (const entry of yield* entriesOf(scratchRoot)) {
			if (!SCRATCH_SUBDIR.test(entry.name)) continue
			const removed = yield* removeOwnedDirectory(
				scratchRoot,
				join(scratchRoot, entry.name),
				"legacy calibration scratch",
			).pipe(Effect.result)
			if (Result.isFailure(removed)) failures.push(`scratch ${entry.name}: ${removed.failure.message}`)
			else if (removed.success) removedDirectories++
		}
		// The recovery record and samples go last, and only once every pin is gone.
		if (failures.length === 0) {
			const removed = yield* removeOwnedDirectory(
				archiveDir,
				join(archiveDir, "calibration"),
				"legacy calibration directory",
			).pipe(Effect.result)
			if (Result.isFailure(removed)) failures.push(`calibration dir: ${removed.failure.message}`)
			else if (removed.success) removedDirectories++
		}
		yield* Effect.sync(() => {
			if (releasedPins + removedDirectories > 0) {
				debugLog(
					"retired legacy archive calibration state",
					`${releasedPins} pin(s), ${removedDirectories} dir(s)`,
				)
			}
			for (const failure of failures) debugLog("legacy archive calibration cleanup skipped", failure)
		})
		return { releasedPins, removedDirectories, failures }
	})
