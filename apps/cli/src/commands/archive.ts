import { Effect, Option } from "effect"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import * as Argument from "effect/unstable/cli/Argument"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { createArchiveGeneration, runArchiveReconciliation } from "../server/archives/generation"
import {
	listActiveGenerations,
	activeParquetPaths,
	rebuildCatalogWithMaintenanceLock,
	verifyActiveGenerations,
} from "../server/archives/listing"
import { runArchiveGc } from "../server/archives/gc"
import { resolveArchiveTuning, tuningRecord } from "../server/archives/config"
import { ARCHIVE_SIGNALS, isArchiveSignalName, type ArchiveSignalName } from "../server/archives/signals"
import { expireArchiveDay, readRetiredDayLedger, retireLiveDay } from "../server/archives/retention"
import { validateRangeDate } from "../server/archives/paths"
import { maintenanceOperation } from "../server/checkpoints"
import { amber, bold, dim, green, red } from "../lib/style"
import { ArchiveError } from "../server/archives/errors"
import { debugLog } from "../lib/debug"
import { jsonFormatRequested, writeJson } from "./json-output"

const defaultDataDir = (): string => join(homedir(), ".maple", "data")
const defaultArchiveDir = (): string => join(homedir(), ".maple", "archive")
const defaultScratchRoot = (): string => join(homedir(), ".maple", "scratch")

const prettyPath = (p: string): string => {
	const home = homedir()
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p
}

const dataDirFlag = Flag.optional(
	Flag.String("data-dir").pipe(
		Flag.withDescription("Embedded ClickHouse data directory (default: ~/.maple/data)"),
	),
)

const archiveDirFlag = Flag.optional(
	Flag.String("archive-dir").pipe(
		Flag.withDescription("Archive root directory for Parquet generations (default: ~/.maple/archive)"),
	),
)

const scratchRootFlag = Flag.optional(
	Flag.String("scratch-root").pipe(
		Flag.withDescription("Root for restored-checkpoint scratch instances (default: ~/.maple/scratch)"),
	),
)

const checkpointIdFlag = Flag.optional(
	Flag.String("checkpoint-id").pipe(
		Flag.withDescription("Archive from one immutable checkpoint ID instead of the selected current"),
	),
)

const dryRunFlag = Flag.Boolean("dry-run").pipe(
	Flag.withDescription("Report the exact planned actions without modifying any archive state"),
	Flag.withDefault(false),
)

const allowShrinkFlag = Flag.Boolean("allow-shrink").pipe(
	Flag.withDescription(
		"Let a generation with fewer rows than the active one supersede it (refused by default)",
	),
	Flag.withDefault(false),
)

const gcApplyFlag = Flag.Boolean("apply").pipe(
	Flag.withDescription("Delete the planned generations (without this flag gc is a dry run)"),
	Flag.withDefault(false),
)

const applyFlag = Flag.Boolean("apply").pipe(
	Flag.withDescription("Apply the destructive operation (omitting this flag is a non-mutating refusal)"),
	Flag.withDefault(false),
)

const localPortFlag = Flag.Int("port").pipe(
	Flag.withDescription("Private Maple local-query port"),
	Flag.withDefault(4318),
)

const sealingLagHoursFlag = Flag.Int("sealing-lag-hours").pipe(
	Flag.withDescription("Hours after UTC midnight before a completed day may be retired"),
	Flag.withDefault(24),
)

const keepFlag = Flag.Int("keep").pipe(
	Flag.withDescription(
		"Newest superseded generations to retain per signal/range (default 1; 0 reclaims all superseded)",
	),
	Flag.withDefault(1),
)

const configFlag = Flag.optional(
	Flag.String("config").pipe(
		Flag.withDescription("Ignored: archive tuning is fixed. Accepted so older scripts keep working"),
	),
)

const rangeDateArgument = Argument.String("range-date").pipe(
	Argument.withDescription("UTC day to seal as YYYY-MM-DD"),
)

const signalArgument = Argument.String("signal").pipe(
	Argument.withDescription(`One of: ${ARCHIVE_SIGNALS.map((s) => s.name).join(", ")}`),
)

const outputFlag = Flag.Literals("output", ["summary", "paths", "json"]).pipe(
	Flag.withDescription(
		"summary (default) or paths (active Parquet paths for DuckDB); json is a deprecated alias of the global --format json",
	),
	Flag.withDefault("summary" as const),
)

/** Resolve the archive and scratch roots from flags, falling back to defaults. */
const resolveRoots = (
	dataDirOpt: Option.Option<string>,
	archiveDirOpt: Option.Option<string>,
	scratchRootOpt: Option.Option<string>,
): { dataDir: string; archiveDir: string; scratchRoot: string } => ({
	dataDir: resolve(Option.getOrUndefined(dataDirOpt) ?? defaultDataDir()),
	archiveDir: resolve(Option.getOrUndefined(archiveDirOpt) ?? defaultArchiveDir()),
	scratchRoot: resolve(Option.getOrUndefined(scratchRootOpt) ?? defaultScratchRoot()),
})

export const archiveCreate = Command.make("create", {
	dataDir: dataDirFlag,
	archiveDir: archiveDirFlag,
	scratchRoot: scratchRootFlag,
	checkpointId: checkpointIdFlag,
	config: configFlag,
	allowShrink: allowShrinkFlag,
	rangeDate: rangeDateArgument,
	signal: signalArgument,
}).pipe(
	Command.withDescription(
		"Seal one UTC day of one signal into a validated Parquet archive generation from a checkpoint",
	),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			if (!isArchiveSignalName(a.signal)) {
				return yield* new ArchiveError({
					message: `unknown signal '${a.signal}'; expected one of ${ARCHIVE_SIGNALS.map((s) => s.name).join(", ")}`,
				})
			}
			const rangeDate = yield* Effect.try({
				try: () => validateRangeDate(a.rangeDate),
				catch: (error) =>
					new ArchiveError({
						message: error instanceof Error ? error.message : String(error),
					}),
			})
			const { dataDir, archiveDir, scratchRoot } = resolveRoots(a.dataDir, a.archiveDir, a.scratchRoot)
			if (readRetiredDayLedger(dataDir).retiredDays.some((day) => day.rangeDate === rangeDate)) {
				return yield* new ArchiveError({
					message: `refusing archive create: UTC day ${rangeDate} is permanently retired`,
				})
			}
			const checkpointId = Option.getOrUndefined(a.checkpointId)
			// Tuning is fixed. A calibration config from an older release is never read.
			const ignoredConfig = Option.getOrUndefined(a.config)
			if (ignoredConfig !== undefined) {
				yield* Effect.sync(() =>
					debugLog(`archive create: ignoring --config ${ignoredConfig}; archive tuning is fixed`),
				)
			}
			const tuning = yield* Effect.try({
				try: () => resolveArchiveTuning({ archiveDir, scratchRoot }),
				catch: (error) =>
					new ArchiveError({
						message: error instanceof Error ? error.message : String(error),
					}),
			})
			yield* Effect.sync(() =>
				process.stderr.write(
					`${amber("⟳")} archiving ${bold(a.signal)} for ${bold(rangeDate)} ` +
						`from ${prettyPath(dataDir)}\n`,
				),
			)
			const result = yield* maintenanceOperation({
				operation: "archive.create",
				try: () =>
					createArchiveGeneration(
						dataDir,
						archiveDir,
						a.signal,
						rangeDate,
						tuning,
						checkpointId ?? "current",
						{},
						{ allowShrink: a.allowShrink },
					),
				catch: (error) =>
					new ArchiveError({ message: error instanceof Error ? error.message : String(error) }),
			})
			const effective =
				`t=${tuning.writerThreads} rg=${tuning.rowGroupRows} ` +
				`msr=${tuning.maxShardRows} msb=${tuning.maxShardBytes} ` +
				`tc=${tuning.targetChunkBytes} reserve=${tuning.minFreeSpaceReserve}`
			debugLog("archive create effective tuning", effective)
			if (jsonFormatRequested()) {
				return yield* writeJson({
					...result,
					archiveDir,
					scratchRoot,
					tuning: tuningRecord(tuning),
				})
			}
			yield* Effect.sync(() =>
				process.stdout.write(
					`${green("✓")} archive generation sealed\n` +
						`  ${dim("signal")}       ${result.signal}\n` +
						`  ${dim("range")}        ${result.rangeStart}\n` +
						`  ${dim("generation")}   ${result.generationId}\n` +
						`  ${dim("shards")}       ${result.shardCount}\n` +
						`  ${dim("rows")}         ${result.archivedRowCount}\n` +
						`  ${dim("archive-dir")}  ${prettyPath(archiveDir)}\n` +
						`  ${dim("scratch-root")} ${prettyPath(scratchRoot)}\n` +
						(result.superseded ? `  ${dim("superseded")} ${result.superseded}\n` : ""),
				),
			)
		}),
	),
)

const signalFlag = Flag.optional(
	Flag.String("signal").pipe(
		Flag.withDescription(`One of: ${ARCHIVE_SIGNALS.map((s) => s.name).join(", ")}`),
	),
)

export const archiveList = Command.make("list", {
	archiveDir: archiveDirFlag,
	output: outputFlag,
	signal: signalFlag,
}).pipe(
	Command.withDescription(
		"List active archive metadata and Parquet shard paths without hashing shard contents",
	),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const archiveDir = Option.getOrUndefined(a.archiveDir) ?? defaultArchiveDir()
			const json = a.output === "json" || (a.output === "summary" && jsonFormatRequested())
			if (a.output === "paths") {
				const signalOpt = Option.getOrUndefined(a.signal)
				if (!signalOpt || !isArchiveSignalName(signalOpt)) {
					return yield* new ArchiveError({
						message: `--output paths requires a signal argument; expected one of ${ARCHIVE_SIGNALS.map((s) => s.name).join(", ")}`,
					})
				}
				const paths = yield* Effect.try({
					try: () => activeParquetPaths(archiveDir, signalOpt),
					catch: (error) =>
						new ArchiveError({
							operation: "list paths",
							message: error instanceof Error ? error.message : String(error),
							cause: error instanceof Error ? error.stack : undefined,
						}),
				})
				yield* Effect.sync(() => process.stdout.write(`${paths.map((p) => `"${p}"`).join(",")}\n`))
				return
			}
			const listing = yield* Effect.try({
				try: () => listActiveGenerations(archiveDir),
				catch: (error) =>
					new ArchiveError({
						operation: "list",
						message: error instanceof Error ? error.message : String(error),
						cause: error instanceof Error ? error.stack : undefined,
					}),
			})
			if (json) return yield* writeJson(listing)
			if (listing.errors.length > 0) {
				const detail = listing.errors
					.map((error) => `${error.signal}/${error.rangeStart || "(root)"}: ${error.error}`)
					.join("; ")
				return yield* new ArchiveError({
					operation: "list summary",
					message: `refusing archive summary because ${listing.errors.length} malformed range(s) were found: ${detail}`,
				})
			}
			if (listing.active.length === 0) {
				yield* Effect.sync(() =>
					process.stderr.write(`No active archive generations in ${prettyPath(archiveDir)}\n`),
				)
				return
			}
			const lines = listing.active.map(
				(summary) =>
					`  ${dim(summary.signal.padEnd(34))} ${summary.rangeStart}  ` +
					`${summary.archivedRowCount.toString().padStart(10)} rows  ` +
					`${summary.shardCount} shards  ${summary.generationId.slice(0, 8)}`,
			)
			yield* Effect.sync(() =>
				process.stdout.write(
					`${green("✓")} ${listing.active.length} active generation(s) in ${prettyPath(archiveDir)} ` +
						`(metadata only; run 'maple archive verify' for SHA-256)\n${lines.join("\n")}\n`,
				),
			)
		}),
	),
)

export const archiveVerify = Command.make("verify", {
	archiveDir: archiveDirFlag,
	signal: signalFlag,
}).pipe(
	Command.withDescription("Stream and SHA-256 verify active archive shards with bounded memory"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const archiveDir = Option.getOrUndefined(a.archiveDir) ?? defaultArchiveDir()
			const signalOpt = Option.getOrUndefined(a.signal)
			if (signalOpt !== undefined && !isArchiveSignalName(signalOpt)) {
				return yield* new ArchiveError({
					message: `unknown signal '${signalOpt}'; expected one of ${ARCHIVE_SIGNALS.map((s) => s.name).join(", ")}`,
				})
			}
			const result = yield* Effect.tryPromise({
				try: () => verifyActiveGenerations(archiveDir, signalOpt),
				catch: (error) =>
					new ArchiveError({ message: error instanceof Error ? error.message : String(error) }),
			})
			if (jsonFormatRequested()) return yield* writeJson(result)
			yield* Effect.sync(() =>
				process.stdout.write(
					`${green("✓")} verified ${result.shardCount} active shard(s) across ` +
						`${result.generationCount} generation(s) (${formatBytes(result.verifiedBytes)})\n`,
				),
			)
		}),
	),
)

export const archiveRebuild = Command.make("rebuild", {
	dataDir: dataDirFlag,
	archiveDir: archiveDirFlag,
	signal: signalArgument,
}).pipe(
	Command.withDescription("Rebuild a signal's catalog.jsonl from authoritative generation manifests"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			if (!isArchiveSignalName(a.signal)) {
				return yield* new ArchiveError({
					message: `unknown signal '${a.signal}'; expected one of ${ARCHIVE_SIGNALS.map((s) => s.name).join(", ")}`,
				})
			}
			const dataDir = resolve(Option.getOrUndefined(a.dataDir) ?? defaultDataDir())
			const archiveDir = resolve(Option.getOrUndefined(a.archiveDir) ?? defaultArchiveDir())
			const signalName: ArchiveSignalName = a.signal
			const entries = yield* maintenanceOperation({
				operation: "archive.rebuild_catalog",
				try: () => rebuildCatalogWithMaintenanceLock(dataDir, archiveDir, signalName, randomUUID()),
				catch: (error) =>
					new ArchiveError({
						operation: "rebuild catalog",
						message: error instanceof Error ? error.message : String(error),
						cause: error instanceof Error ? error.stack : undefined,
					}),
			})
			if (jsonFormatRequested()) return yield* writeJson({ signal: a.signal, entries })
			yield* Effect.sync(() =>
				process.stdout.write(
					`${green("✓")} rebuilt ${a.signal} catalog with ${entries.length} generation(s)\n`,
				),
			)
		}),
	),
)

export const archiveReconcile = Command.make("reconcile", {
	dataDir: dataDirFlag,
	archiveDir: archiveDirFlag,
	scratchRoot: scratchRootFlag,
	dryRun: dryRunFlag,
}).pipe(
	Command.withDescription(
		"Reconcile an interrupted archive create or gc operation to its intended state without a fresh export",
	),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const { dataDir, archiveDir, scratchRoot } = resolveRoots(a.dataDir, a.archiveDir, a.scratchRoot)
			// Both dry-run and apply go through the locked runArchiveReconciliation
			// entry point (blocker 2): dry-run returns the plan without mutating;
			// apply acquires the maintenance lock, migrates any v2 intent, then
			// reconciles — never racing create/GC planning or pointer/catalog repair.
			const decision = yield* maintenanceOperation({
				operation: "archive.reconcile",
				try: () => runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: a.dryRun }),
				catch: (error) =>
					new ArchiveError({ message: error instanceof Error ? error.message : String(error) }),
			})
			const renderDecision = (d: typeof decision): string => {
				if (d.kind === "NoOp") return `${green("✓")} reconcile: no active operation\n`
				if (d.kind === "FailClosed") return `${red("!")} FAIL CLOSED: ${d.reason}\n`
				const id = "operationId" in d ? d.operationId : ""
				const mig = "migrationRequired" in d && d.migrationRequired ? " (migrate v2)" : ""
				return `${green("✓")} reconcile ${d.kind}: ${id}${mig}\n`
			}
			if (decision.kind !== "FailClosed" && jsonFormatRequested()) {
				return yield* writeJson({ dryRun: a.dryRun, archiveDir, decision })
			}
			if (a.dryRun) {
				if (decision.kind === "FailClosed") {
					return yield* new ArchiveError({ message: renderDecision(decision).trim() })
				}
				yield* Effect.sync(() =>
					process.stdout.write(
						`${amber("◌")} dry-run reconcile\n${renderDecision(decision)}  ${dim("archive")}   ${prettyPath(archiveDir)}\n  ${dim("note")}     no archive state is modified\n`,
					),
				)
				return
			}
			if (decision.kind === "FailClosed") {
				return yield* new ArchiveError({ message: renderDecision(decision).trim() })
			}
			yield* Effect.sync(() =>
				process.stderr.write(
					`${amber("⟳")} reconciling interrupted archive operation in ${prettyPath(archiveDir)}\n`,
				),
			)
			yield* Effect.sync(() => process.stdout.write(renderDecision(decision)))
		}),
	),
)

export const archiveGc = Command.make("gc", {
	dataDir: dataDirFlag,
	archiveDir: archiveDirFlag,
	scratchRoot: scratchRootFlag,
	keep: keepFlag,
	dryRun: dryRunFlag,
	apply: gcApplyFlag,
}).pipe(
	Command.withDescription(
		"Plan reclaiming superseded archive generations, keeping the newest N per signal/range (default 1); --apply deletes",
	),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			if (!Number.isSafeInteger(a.keep) || a.keep < 0) {
				return yield* new ArchiveError({
					message: `invalid --keep value: ${a.keep} (must be a non-negative integer)`,
				})
			}
			const { dataDir, archiveDir, scratchRoot } = resolveRoots(a.dataDir, a.archiveDir, a.scratchRoot)
			// Deleting published generations is destructive, so like expire and
			// retire-live it happens only with --apply; --dry-run always wins.
			const dryRun = a.dryRun || !a.apply
			const result = yield* maintenanceOperation({
				operation: "archive.gc",
				try: () => runArchiveGc({ dataDir, archiveDir, scratchRoot, keep: a.keep, dryRun }),
				catch: (error) =>
					new ArchiveError({ message: error instanceof Error ? error.message : String(error) }),
			})
			const { plan } = result
			if (jsonFormatRequested()) return yield* writeJson({ dryRun, ...result })
			if (dryRun) {
				yield* Effect.sync(() =>
					process.stdout.write(
						`${amber("◌")} dry-run gc: would delete ${plan.deleteSet.length} generation(s), ` +
							`reclaim ${formatBytes(plan.reclaimableBytes)}\n` +
							`  ${dim("keep")}        ${plan.keep} newest superseded per range\n` +
							(plan.deleteSet.length === 0
								? `  ${dim("note")}      nothing to reclaim\n`
								: plan.deleteSet
										.map(
											(c) =>
												`  ${dim("delete")}    ${c.signal}/${c.rangeStart}/${c.generationId} (${formatBytes(c.bytes)})`,
										)
										.join("\n") + "\n") +
							(plan.excludedSignals.length + plan.excludedRanges.length === 0
								? ""
								: `${red("!")} ${plan.excludedSignals.length + plan.excludedRanges.length} range(s)/signal(s) excluded (over-retained)\n`) +
							(plan.deleteSet.length === 0 || a.dryRun
								? ""
								: `  ${dim("next")}      re-run with ${bold("--apply")} to delete them\n`),
					),
				)
				return
			}
			yield* Effect.sync(() =>
				process.stdout.write(
					`${green("✓")} gc complete: deleted ${result.deleted.length} generation(s), ` +
						`reclaimed ${formatBytes(plan.reclaimableBytes)}\n` +
						`  ${dim("kept")}        ${plan.keep} newest superseded per range\n`,
				),
			)
		}),
	),
)

export const archiveExpire = Command.make("expire", {
	dataDir: dataDirFlag,
	archiveDir: archiveDirFlag,
	scratchRoot: scratchRootFlag,
	rangeDate: rangeDateArgument,
	apply: applyFlag,
}).pipe(
	Command.withDescription("Expire one complete active archived UTC day across all six signals"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			if (!a.apply)
				return yield* new ArchiveError({ message: "refusing archive expiration without --apply" })
			const roots = resolveRoots(a.dataDir, a.archiveDir, a.scratchRoot)
			yield* maintenanceOperation({
				operation: "archive.expire_day",
				try: () =>
					expireArchiveDay({
						dataDir: roots.dataDir,
						archiveDir: roots.archiveDir,
						scratchRoot: roots.scratchRoot,
						rangeDate: a.rangeDate,
					}),
				catch: (error) =>
					new ArchiveError({ message: error instanceof Error ? error.message : String(error) }),
			})
			if (jsonFormatRequested()) return yield* writeJson({ expired: a.rangeDate })
			yield* Effect.sync(() =>
				process.stdout.write(`${green("✓")} expired archive day ${a.rangeDate}\n`),
			)
		}),
	),
)

export const archiveRetireLive = Command.make("retire-live", {
	dataDir: dataDirFlag,
	archiveDir: archiveDirFlag,
	scratchRoot: scratchRootFlag,
	rangeDate: rangeDateArgument,
	port: localPortFlag,
	sealingLagHours: sealingLagHoursFlag,
	apply: applyFlag,
}).pipe(
	Command.withDescription("Remove one UTC day from live raw tables after complete archive verification"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			if (!a.apply)
				return yield* new ArchiveError({ message: "refusing live retirement without --apply" })
			const roots = resolveRoots(a.dataDir, a.archiveDir, a.scratchRoot)
			yield* maintenanceOperation({
				operation: "archive.retire_day",
				try: () =>
					retireLiveDay({
						dataDir: roots.dataDir,
						archiveDir: roots.archiveDir,
						scratchRoot: roots.scratchRoot,
						rangeDate: a.rangeDate,
						port: a.port,
						sealingLagHours: a.sealingLagHours,
					}),
				catch: (error) =>
					new ArchiveError({ message: error instanceof Error ? error.message : String(error) }),
			})
			if (jsonFormatRequested()) return yield* writeJson({ retired: a.rangeDate })
			yield* Effect.sync(() => process.stdout.write(`${green("✓")} retired live day ${a.rangeDate}\n`))
		}),
	),
)

const formatBytes = (bytes: number): string => {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

export const archive = Command.make("archive").pipe(
	Command.withDescription("Manage local Parquet telemetry archives exported from immutable checkpoints"),
	Command.withSubcommands([
		archiveCreate,
		archiveList,
		archiveVerify,
		archiveRebuild,
		archiveReconcile,
		archiveGc,
		archiveExpire,
		archiveRetireLive,
	]),
)
