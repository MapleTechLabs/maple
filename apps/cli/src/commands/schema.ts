import { Effect, Option, Schema } from "effect"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { bold, dim, green, amber } from "../lib/style"
import {
	formatMigrationPlan,
	identityFromMarker,
	abandonLocalStoreMigrationPreservingSource,
	migrationStatus,
	planMigration,
	runLocalStoreMigration,
	type MigrationPlan,
} from "../server/local-store-migrations"
import { maintenanceOperation, releasePreservedCheckpoints } from "../server/checkpoints"
import {
	listRetainedLeftovers,
	pruneRetainedLeftovers,
	type RetainedInventory,
	type RetainedLeftover,
} from "../server/retained-leftovers"
import { isStoreDirty, readMarker } from "../server/store-version"
import { jsonFormatRequested, writeJson } from "./json-output"
import { commandScope, mapleCommand } from "./server-args"

class SchemaCommandError extends Schema.TaggedError<SchemaCommandError>()("@maple/cli/SchemaCommandError", {
	message: Schema.String,
}) {}

const commandError = (error: unknown): SchemaCommandError =>
	new SchemaCommandError({ message: error instanceof Error ? error.message : String(error) })

const defaultDataDir = (): string => join(homedir(), ".maple", "data")

const dataDirFlag = Flag.optional(
	Flag.String("data-dir").pipe(
		Flag.withDescription("Embedded ClickHouse data directory (default: ~/.maple/data)"),
	),
)

const yesFlag = Flag.Boolean("yes").pipe(
	Flag.withAlias("y"),
	Flag.withDescription("Confirm the migration and its stated preservation envelope"),
	Flag.withDefault(false),
)

const abandonYesFlag = Flag.Boolean("yes").pipe(
	Flag.withAlias("y"),
	Flag.withDescription("Confirm quarantining the staged target while preserving the active source"),
	Flag.withDefault(false),
)

const dryRunFlag = Flag.Boolean("dry-run").pipe(
	Flag.withDescription("Print the migration plan without creating a target or changing the source"),
	Flag.withDefault(false),
)

const gcApplyFlag = Flag.Boolean("apply").pipe(
	Flag.withDescription("Delete the listed leftovers (without this flag gc only lists them)"),
	Flag.withDefault(false),
)

const releasePreservedFlag = Flag.Boolean("release-preserved").pipe(
	Flag.withDescription(
		"With --apply, also release the checkpoints a reset or wipe preserved so they can be retired",
	),
	Flag.withDefault(false),
)

const resolvedDataDir = (value: Option.Option<string>): string =>
	Option.getOrUndefined(value) ?? defaultDataDir()

const markerIdentity = (dataDir: string) => {
	const marker = readMarker(dataDir)
	if (!marker) throw new Error("no readable local-store marker was found")
	const identity = identityFromMarker(marker)
	if (!identity) throw new Error(`the store fingerprint ${marker.schema || "<none>"} is not registered`)
	return { marker, identity }
}

/** The plan without its executable modules, for `--format json`. */
const planJson = (plan: MigrationPlan) => ({
	upToDate: plan.chain.length === 0,
	source: plan.source,
	target: plan.target,
	requiresQuiescence: plan.requiresQuiescence,
	chain: plan.chain.map((migration) => ({
		id: migration.id,
		description: migration.description,
		from: migration.from,
		to: migration.to,
	})),
	operations: plan.operations,
	dispositions: plan.dispositions,
	checkpointDisposition: plan.checkpointDisposition,
	rollbackBoundary: plan.rollbackBoundary,
})

export const schemaStatus = Command.make("status", { dataDir: dataDirFlag }).pipe(
	Command.withDescription("Show local-store schema identity and migration journal state"),
	Command.withHandler(
		Effect.fnUntraced(function* (args) {
			const dataDir = resolvedDataDir(args.dataDir)
			const status = yield* Effect.tryPromise({
				try: () => migrationStatus(dataDir),
				catch: commandError,
			})
			if (jsonFormatRequested()) {
				return yield* writeJson({
					dataDir,
					marker: status.marker,
					journal:
						status.journal === null
							? null
							: { migrationId: status.journal.migrationId, phase: status.journal.phase },
					physicalCheck: status.physicalCheck,
				})
			}
			if (status.marker === null) {
				yield* Effect.sync(() => process.stdout.write(`${dim("no local-store marker")}\n`))
				return
			}
			const marker = status.marker
			const lines = [
				`data: ${dataDir}`,
				`marker format: ${marker.formatVersion}`,
				`chDB: ${marker.chdb}`,
				`schema fingerprint: ${marker.schema || "<none>"}`,
				...(marker.formatVersion === 2
					? [
							`schema version: ${marker.schemaVersion}`,
							`schema digest: ${marker.schemaDigest}`,
							`store id: ${marker.storeId}`,
							`activation: ${marker.activation}`,
							`created: ${marker.createdAt} by ${marker.createdByMaple}`,
						]
					: [`created: ${marker.createdAt} by ${marker.maple}`]),
				`migration journal: ${status.journal?.phase ?? "none"}`,
				`physical check: ${status.physicalCheck}`,
			]
			yield* Effect.sync(() => process.stdout.write(`${lines.join("\n")}\n`))
		}),
	),
)

export const schemaPlan = Command.make("plan", { dataDir: dataDirFlag }).pipe(
	Command.withDescription("Show the deterministic local-store migration plan"),
	Command.withHandler(
		Effect.fnUntraced(function* (args) {
			const dataDir = resolvedDataDir(args.dataDir)
			const { identity } = yield* Effect.try({
				try: () => markerIdentity(dataDir),
				catch: commandError,
			})
			const plan = yield* Effect.try({
				try: () => planMigration(identity),
				catch: commandError,
			})
			if (jsonFormatRequested()) return yield* writeJson(planJson(plan))
			yield* Effect.sync(() => process.stdout.write(formatMigrationPlan(plan)))
		}),
	),
)

const planSummary = (plan: MigrationPlan): string =>
	`${plan.chain.map((migration) => migration.id).join(" -> ")}\n` +
	`This migration requires a stopped source and retains the original store as a pre-cutover rollback point.\n` +
	`Existing checkpoints remain with that source and are not restorable by the current schema.\n`

export const schemaMigrate = Command.make("migrate", {
	dataDir: dataDirFlag,
	yes: yesFlag,
	dryRun: dryRunFlag,
}).pipe(
	Command.withDescription("Migrate a supported populated local store into a staged current-schema store"),
	Command.withHandler(
		Effect.fnUntraced(function* (args) {
			const dataDir = resolvedDataDir(args.dataDir)
			const json = jsonFormatRequested()
			const preview = yield* maintenanceOperation({
				operation: "schema.migrate_preview",
				try: () => runLocalStoreMigration({ dataDir, dryRun: true }),
				catch: commandError,
			})
			if (preview instanceof Object && "chain" in preview) {
				const plan = preview
				if (args.dryRun || plan.chain.length === 0) {
					if (json) return yield* writeJson(planJson(plan))
					yield* Effect.sync(() => process.stdout.write(formatMigrationPlan(plan)))
					return
				}
				if (!args.yes) {
					if (json) return yield* writeJson({ started: false, plan: planJson(plan) })
					yield* Effect.sync(() =>
						process.stderr.write(
							`${amber("Migration not started.")}\n${planSummary(plan)}Re-run with ${bold(mapleCommand("schema migrate --yes", commandScope({ dataDir })))} to confirm.\n`,
						),
					)
					return
				}
			}
			const result = yield* maintenanceOperation({
				operation: "schema.migrate_apply",
				try: () =>
					runLocalStoreMigration({
						dataDir,
						onProgress: (message) => process.stderr.write(`${dim("·")} ${message}\n`),
					}),
				catch: commandError,
			})
			if ("migrationId" in result) {
				if (json) return yield* writeJson({ started: true, ...result })
				yield* Effect.sync(() =>
					process.stdout.write(
						`${green("✓")} local store migrated\n` +
							`  ${dim("migration")} ${result.migrationId}\n` +
							`  ${dim("cutoff")}   ${result.cutoffAt}\n` +
							`  ${dim("rollback")} ${result.sourceRollbackDir}\n` +
							`  ${dim("active")}   ${result.targetDataDir}\n` +
							`  ${dim("guarantee")} raw telemetry exact within each table's retention horizon; older aggregate-only history remains with the retained legacy source\n` +
							`  ${dim("next")}     create a new checkpoint before resuming long-lived retention\n` +
							`  ${dim("reclaim")}  ${bold(mapleCommand("schema gc", commandScope({ dataDir })))} lists the rollback source once you no longer need it\n`,
					),
				)
			}
		}),
	),
)

export const schemaAbandon = Command.make("abandon", {
	dataDir: dataDirFlag,
	yes: abandonYesFlag,
}).pipe(
	Command.withDescription("Quarantine an unfinished staged target while preserving the active source"),
	Command.withHandler(
		Effect.fnUntraced(function* (args) {
			const dataDir = resolvedDataDir(args.dataDir)
			if (!args.yes) {
				yield* Effect.sync(() =>
					process.stderr.write(
						`${amber("Target not abandoned.")} This moves only the journal-owned staged target into a recoverable quarantine and preserves the active source, checkpoints, and rollback data. Re-run with ${bold(mapleCommand("schema abandon --yes", commandScope({ dataDir })))} to confirm.\n`,
					),
				)
				return
			}
			const quarantine = yield* maintenanceOperation({
				operation: "schema.abandon",
				try: () => abandonLocalStoreMigrationPreservingSource(dataDir),
				catch: commandError,
			})
			// A migration killed with the source open leaves it dirty; abandoning
			// hands it to the ordinary dirty-store recovery.
			const sourceDirty = isStoreDirty(dataDir)
			if (jsonFormatRequested()) return yield* writeJson({ quarantine, source: dataDir, sourceDirty })
			yield* Effect.sync(() =>
				process.stdout.write(
					(quarantine === null
						? `${dim("No unfinished staged migration was found.")}\n`
						: `${green("✓")} staged target quarantined\n  ${dim("quarantine")} ${quarantine}\n  ${dim("source")}    ${dataDir}\n`) +
						(sourceDirty
							? `${amber("!")} the source was not cleanly closed. Recover it with ${bold(mapleCommand("restore --yes", commandScope({ dataDir })))} if it has a checkpoint, otherwise ${bold(mapleCommand("start --reset", commandScope({ dataDir })))} (this discards its live telemetry).\n`
							: ""),
				),
			)
		}),
	),
)

const formatBytes = (bytes: number): string => {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

const LEFTOVER_KINDS: ReadonlyArray<readonly [RetainedLeftover["kind"], string]> = [
	["restore-replaced-store", "store replaced by a restore"],
	["restore-interrupted", "interrupted restore"],
	["restore-transaction", "interrupted restore record"],
	["maintenance-lock", "stale maintenance lock"],
	["migration-source", "migration rollback source (with its checkpoints)"],
	["migration-abandoned-target", "abandoned migration target"],
	["migration-abandoned-journal", "abandoned migration journal"],
	["checkpoint-quarantine", "checkpoint quarantine"],
]

/** At most this many paths per kind; bookkeeping entries can number thousands. */
const PATHS_PER_KIND = 5

const renderInventory = (inventory: RetainedInventory): string => {
	const lines: string[] = []
	if (inventory.leftovers.length === 0) {
		lines.push(`${green("✓")} no retained leftovers for ${inventory.dataDir}`)
	} else {
		const total = inventory.leftovers.reduce((sum, item) => sum + item.bytes, 0)
		lines.push(
			`${inventory.leftovers.length} retained leftover(s) for ${inventory.dataDir} (${formatBytes(total)}):`,
		)
		for (const [kind, label] of LEFTOVER_KINDS) {
			const items = inventory.leftovers.filter((item) => item.kind === kind)
			if (items.length === 0) continue
			const bytes = items.reduce((sum, item) => sum + item.bytes, 0)
			lines.push(`  ${bold(label)}: ${items.length} (${formatBytes(bytes)})`)
			for (const item of items.slice(0, PATHS_PER_KIND)) {
				lines.push(
					`    ${dim(item.modifiedAt.slice(0, 19))}  ${formatBytes(item.bytes).padStart(10)}  ${item.path}`,
				)
			}
			if (items.length > PATHS_PER_KIND)
				lines.push(`    ${dim(`… and ${items.length - PATHS_PER_KIND} more`)}`)
		}
	}
	if (inventory.preserved.length > 0) {
		lines.push(
			`${inventory.preserved.length} checkpoint(s) preserved across a reset (kept until released; restore one with ${bold(mapleCommand("restore --checkpoint-id <id> --yes", commandScope({ dataDir: inventory.dataDir })))}):`,
		)
		for (const checkpoint of inventory.preserved) {
			const counts =
				checkpoint.validation === null
					? "unreadable manifest"
					: `traces ${checkpoint.validation.traces}, logs ${checkpoint.validation.logs}`
			lines.push(
				`  ${checkpoint.checkpointId}  ${checkpoint.createdAt ?? "?"}  ${counts}  ${formatBytes(checkpoint.bytes)}`,
			)
		}
	}
	for (const note of inventory.notes) lines.push(`${amber("!")} ${note}`)
	return `${lines.join("\n")}\n`
}

export const schemaGc = Command.make("gc", {
	dataDir: dataDirFlag,
	apply: gcApplyFlag,
	releasePreserved: releasePreservedFlag,
}).pipe(
	Command.withDescription(
		"List what restores, resets and migrations moved aside (stores, rollback sources, quarantines); --apply deletes it",
	),
	Command.withHandler(
		Effect.fnUntraced(function* (args) {
			const dataDir = resolvedDataDir(args.dataDir)
			const json = jsonFormatRequested()
			const inventory = yield* Effect.tryPromise({
				try: () => listRetainedLeftovers(dataDir),
				catch: commandError,
			})
			if (!args.apply) {
				if (json) return yield* writeJson({ applied: false, ...inventory })
				yield* Effect.sync(() =>
					process.stdout.write(
						renderInventory(inventory) +
							(inventory.leftovers.length === 0 && inventory.preserved.length === 0
								? ""
								: `${dim("dry run: nothing was removed.")} Re-run with ${bold(mapleCommand("schema gc --apply", commandScope({ dataDir })))} to delete the leftovers` +
									(inventory.preserved.length === 0
										? ".\n"
										: `, and add ${bold("--release-preserved")} to also release the preserved checkpoints.\n`)),
					),
				)
				return
			}
			if (inventory.blocker !== null)
				return yield* new SchemaCommandError({ message: inventory.blocker })
			const released = args.releasePreserved
				? yield* releasePreservedCheckpoints(dataDir).pipe(Effect.mapError(commandError))
				: { released: [], retired: [] }
			const removed = yield* maintenanceOperation({
				operation: "schema.gc_apply",
				try: () => pruneRetainedLeftovers(dataDir, randomUUID()),
				catch: commandError,
			})
			if (json) return yield* writeJson({ applied: true, removed, ...released })
			const reclaimed = removed.reduce((sum, item) => sum + item.bytes, 0)
			yield* Effect.sync(() =>
				process.stdout.write(
					`${green("✓")} removed ${removed.length} retained leftover(s), reclaimed ${formatBytes(reclaimed)}\n` +
						(args.releasePreserved
							? `  ${dim("released")} ${released.released.length} preserved checkpoint(s); retired ${released.retired.length} no longer current or previous\n`
							: ""),
				),
			)
		}),
	),
)

export const schema = Command.make("schema").pipe(
	Command.withDescription("Inspect and migrate the local chDB schema, and reclaim what it retains"),
	Command.withSubcommands([schemaStatus, schemaPlan, schemaMigrate, schemaAbandon, schemaGc]),
)
