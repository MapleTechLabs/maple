import { describe, it } from "@effect/vitest"
import { ok, strictEqual } from "node:assert"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
	acquireCheckpointPin,
	checkpointRoot,
	checkpointSnapshotDir,
	checkpointStatePath,
} from "../src/server/checkpoints"
import { runArchiveReconciliation } from "../src/server/archives/generation"
import { retireLegacyCalibration } from "../src/server/archives/legacy-calibration"
import { SCHEMA_FINGERPRINT } from "../src/server/schema-identity"
import { CHDB_VERSION, MAPLE_VERSION } from "../src/version"

// Calibration was removed; what an interrupted older run left must not wedge
// anything and must be retired by the ordinary reconcile path.

interface Roots {
	readonly dataDir: string
	readonly archiveDir: string
	readonly scratchRoot: string
	readonly parent: string
}

const withRoots = async (run: (roots: Roots) => Promise<void>): Promise<void> => {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "maple-archive-legacy-cal-")))
	const roots = {
		parent,
		dataDir: join(parent, "data"),
		archiveDir: join(parent, "archive"),
		scratchRoot: join(parent, "scratch"),
	}
	for (const dir of [roots.dataDir, roots.archiveDir, roots.scratchRoot])
		mkdirSync(dir, { recursive: true })
	await run(roots).finally(() => rmSync(parent, { recursive: true, force: true }))
}

const seedCheckpoint = (dataDir: string): string => {
	const checkpointId = randomUUID()
	const createdAt = "2026-01-01T00:00:00.000Z"
	const snapshot = checkpointSnapshotDir(dataDir, checkpointId)
	mkdirSync(join(snapshot, "backup"), { recursive: true })
	writeFileSync(join(snapshot, "backup", "data.bin"), "backup")
	writeFileSync(
		join(snapshot, "manifest.json"),
		`${JSON.stringify({
			formatVersion: 1,
			checkpointId,
			operationId: randomUUID(),
			mapleVersion: MAPLE_VERSION,
			chdbVersion: CHDB_VERSION,
			schemaFingerprint: SCHEMA_FINGERPRINT,
			createdAt,
			sourceDataDir: dataDir,
			backupRelativePath: `snapshots/${checkpointId}/backup`,
			backupBytes: 6,
			validation: {
				validatedAt: createdAt,
				traces: 0,
				logs: 0,
				metricsSum: 0,
				metricsGauge: 0,
				metricsHistogram: 0,
				metricsExponentialHistogram: 0,
				materializedViews: 0,
			},
		})}\n`,
	)
	mkdirSync(checkpointRoot(dataDir), { recursive: true })
	writeFileSync(
		checkpointStatePath(dataDir),
		`${JSON.stringify({
			formatVersion: 1,
			revision: randomUUID(),
			current: checkpointId,
			previous: null,
			committedAt: createdAt,
		})}\n`,
	)
	return checkpointId
}

/** The on-disk shape an interrupted older `archive calibrate` left behind. */
const seedInterruptedCalibration = async (roots: Roots, checkpointId: string) => {
	const operationId = randomUUID()
	const pinPath = await acquireCheckpointPin(
		roots.dataDir,
		checkpointId,
		`archive-calibrate:${operationId}`,
		randomUUID(),
	)
	const scratch = join(roots.scratchRoot, `calibrate-${operationId}`)
	mkdirSync(join(scratch, "store"), { recursive: true })
	const samples = join(roots.archiveDir, "calibration", "samples", operationId)
	mkdirSync(samples, { recursive: true })
	writeFileSync(join(samples, "00-0000.parquet"), "sample")
	writeFileSync(join(roots.archiveDir, "calibration", "recovery.json"), '{"formatVersion":1}\n')
	return { pinPath, scratch }
}

describe("legacy archive calibration state", () => {
	it("reconcile releases calibration pins and removes calibration dirs, keeping other pins", async () => {
		await withRoots(async (roots) => {
			const checkpointId = seedCheckpoint(roots.dataDir)
			const { pinPath, scratch } = await seedInterruptedCalibration(roots, checkpointId)
			const archivePin = await acquireCheckpointPin(
				roots.dataDir,
				checkpointId,
				`archive:${randomUUID()}`,
			)
			const unrelatedScratch = join(roots.scratchRoot, `archive-${randomUUID()}`)
			mkdirSync(unrelatedScratch)
			const decision = await runArchiveReconciliation(
				roots.dataDir,
				roots.archiveDir,
				roots.scratchRoot,
			)
			strictEqual(decision.kind, "NoOp")
			ok(!existsSync(pinPath), "calibration pin released")
			ok(!existsSync(scratch), "calibration scratch removed")
			ok(!existsSync(join(roots.archiveDir, "calibration")), "calibration tree removed")
			ok(existsSync(archivePin), "unrelated archive pin kept")
			ok(existsSync(unrelatedScratch), "unrelated scratch kept")
		})
	})

	it("a dry-run reconcile leaves the legacy state untouched", async () => {
		await withRoots(async (roots) => {
			const checkpointId = seedCheckpoint(roots.dataDir)
			const { pinPath, scratch } = await seedInterruptedCalibration(roots, checkpointId)
			const decision = await runArchiveReconciliation(
				roots.dataDir,
				roots.archiveDir,
				roots.scratchRoot,
				{
					dryRun: true,
				},
			)
			strictEqual(decision.kind, "NoOp")
			ok(existsSync(pinPath))
			ok(existsSync(scratch))
			ok(existsSync(join(roots.archiveDir, "calibration", "recovery.json")))
		})
	})

	it("never fails on state it cannot prove owned, and leaves it in place", async () => {
		await withRoots(async (roots) => {
			const checkpointId = seedCheckpoint(roots.dataDir)
			const outside = join(roots.parent, "outside")
			mkdirSync(outside)
			writeFileSync(join(outside, "keep.txt"), "keep")
			symlinkSync(outside, join(roots.archiveDir, "calibration"))
			const operationId = randomUUID()
			const pinPath = await acquireCheckpointPin(
				roots.dataDir,
				checkpointId,
				`archive-calibrate:${operationId}`,
			)
			const result = await Effect.runPromise(
				retireLegacyCalibration(roots.dataDir, roots.archiveDir, roots.scratchRoot),
			)
			strictEqual(result.releasedPins, 1)
			ok(!existsSync(pinPath))
			strictEqual(result.failures.length, 1, "symlinked calibration tree is reported, not followed")
			ok(existsSync(join(outside, "keep.txt")), "symlink target untouched")
			const decision = await runArchiveReconciliation(
				roots.dataDir,
				roots.archiveDir,
				roots.scratchRoot,
			)
			strictEqual(decision.kind, "NoOp")
		})
	})
})
