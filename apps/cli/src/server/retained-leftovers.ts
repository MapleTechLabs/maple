// Everything Maple moves aside instead of deleting: stores replaced by a
// restore, interrupted restores, migration rollback sources and abandoned
// targets, and checkpoint quarantine. None of it is ever removed on its own;
// `maple schema gc` lists it and removes it only with `--apply`.

import { existsSync } from "node:fs"
import { lstat, readdir, readFile, rm } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { Option, Schema } from "effect"
import {
	checkpointQuarantineRoot,
	listPreservedCheckpointPins,
	resetTransactionPath,
	restoreTransactionPath,
	resolveCheckpointInRegistry,
	withMaintenanceLock,
	type CheckpointId,
	type CheckpointValidation,
} from "./checkpoints"
import { syncDirectory } from "./durable-files"
import {
	migrationJournalPath,
	migrationRootPath,
	readMigrationJournalStructure,
} from "./local-store-migrations"

export type RetainedLeftoverKind =
	| "restore-replaced-store"
	| "restore-interrupted"
	| "restore-transaction"
	| "maintenance-lock"
	| "migration-source"
	| "migration-abandoned-target"
	| "migration-abandoned-journal"
	| "checkpoint-quarantine"

export interface RetainedLeftover {
	readonly kind: RetainedLeftoverKind
	readonly path: string
	readonly bytes: number
	readonly modifiedAt: string
	readonly entry: "directory" | "file"
}

export interface PreservedCheckpoint {
	readonly checkpointId: CheckpointId
	readonly pins: number
	readonly bytes: number
	readonly createdAt: string | null
	readonly validation: CheckpointValidation | null
}

export interface RetainedInventory {
	readonly dataDir: string
	readonly leftovers: ReadonlyArray<RetainedLeftover>
	readonly preserved: ReadonlyArray<PreservedCheckpoint>
	/** Why `--apply` would refuse right now, or null. */
	readonly blocker: string | null
	readonly notes: ReadonlyArray<string>
}

export class RetainedLeftoverError extends Schema.TaggedError<RetainedLeftoverError>()(
	"@maple/cli/RetainedLeftoverError",
	{ dataDir: Schema.String, message: Schema.String },
) {}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
const MIGRATION_ID = "[A-Za-z0-9._-]+"

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Only the provenance a leftover needs to be attributed to one data dir. */
const JournalProvenance = Schema.Struct({ sourceDataDir: Schema.String })
const decodeJournalProvenance = Schema.decodeUnknownOption(Schema.fromJsonString(JournalProvenance))

const belongsTo = async (journalPath: string, dataDir: string): Promise<boolean> => {
	if (!existsSync(journalPath)) return false
	const info = await lstat(journalPath)
	if (info.isSymbolicLink() || !info.isFile()) return false
	const provenance = decodeJournalProvenance(await readFile(journalPath, "utf8"))
	return Option.isSome(provenance) && resolve(provenance.value.sourceDataDir) === dataDir
}

/** Bytes on disk without following links; a chDB store holds internal symlinks. */
const treeBytes = async (path: string): Promise<number> => {
	const info = await lstat(path)
	if (info.isSymbolicLink()) return 0
	if (!info.isDirectory()) return info.size
	let total = 0
	for (const entry of await readdir(path)) total += await treeBytes(join(path, entry))
	return total
}

const leftover = async (kind: RetainedLeftoverKind, path: string): Promise<RetainedLeftover | null> => {
	const info = await lstat(path)
	if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) return null
	return {
		kind,
		path,
		bytes: await treeBytes(path),
		modifiedAt: info.mtime.toISOString(),
		entry: info.isDirectory() ? "directory" : "file",
	}
}

const siblingLeftovers = async (dataDir: string): Promise<ReadonlyArray<RetainedLeftover>> => {
	const parent = dirname(dataDir)
	if (!existsSync(parent)) return []
	const base = escapeRegExp(basename(dataDir))
	const patterns: ReadonlyArray<readonly [RetainedLeftoverKind, RegExp]> = [
		["restore-replaced-store", new RegExp(`^${base}\\.quarantine-${UUID}-${UUID}$`, "i")],
		["restore-interrupted", new RegExp(`^${base}\\.restore-${UUID}\\.quarantine-${UUID}$`, "i")],
		[
			"restore-transaction",
			new RegExp(`^${base}\\.restore-transaction\\.json\\.quarantine-${UUID}$`, "i"),
		],
		["maintenance-lock", new RegExp(`^${base}\\.maple-maintenance-lock\\.quarantine-${UUID}$`, "i")],
	]
	const found: RetainedLeftover[] = []
	for (const name of (await readdir(parent)).sort()) {
		const match = patterns.find(([, pattern]) => pattern.test(name))
		if (match === undefined) continue
		const item = await leftover(match[0], join(parent, name))
		if (item !== null) found.push(item)
	}
	return found
}

const migrationLeftovers = async (
	dataDir: string,
	activeMigrationId: string | null,
): Promise<ReadonlyArray<RetainedLeftover>> => {
	const found: RetainedLeftover[] = []
	const migrationsRoot = dirname(migrationRootPath(dataDir, "retained"))
	if (existsSync(migrationsRoot) && (await lstat(migrationsRoot)).isDirectory()) {
		const completed = new RegExp(`^${MIGRATION_ID}$`)
		const abandoned = new RegExp(`^${MIGRATION_ID}\\.abandoned-${UUID}$`, "i")
		for (const name of (await readdir(migrationsRoot)).sort()) {
			const root = join(migrationsRoot, name)
			if (abandoned.test(name)) {
				if (!(await belongsTo(join(root, "journal.json"), dataDir))) continue
				const item = await leftover("migration-abandoned-target", root)
				if (item !== null) found.push(item)
				continue
			}
			// The unfinished migration's root is live state, never a leftover.
			if (!completed.test(name) || name === activeMigrationId) continue
			const source = join(root, "source")
			if (!existsSync(source) || !(await belongsTo(join(root, "journal.json"), dataDir))) continue
			const item = await leftover("migration-source", source)
			if (item !== null) found.push(item)
		}
	}
	const journalParent = dirname(migrationJournalPath(dataDir))
	if (existsSync(journalParent)) {
		const abandonedJournal = new RegExp(`^maple-store-migration-abandoned-${MIGRATION_ID}\\.json$`)
		for (const name of (await readdir(journalParent)).sort()) {
			if (!abandonedJournal.test(name)) continue
			const path = join(journalParent, name)
			if (!(await belongsTo(path, dataDir))) continue
			const item = await leftover("migration-abandoned-journal", path)
			if (item !== null) found.push(item)
		}
	}
	return found
}

const checkpointQuarantineLeftovers = async (dataDir: string): Promise<ReadonlyArray<RetainedLeftover>> => {
	const root = checkpointQuarantineRoot(dataDir)
	if (!existsSync(root)) return []
	const info = await lstat(root)
	if (info.isSymbolicLink() || !info.isDirectory()) return []
	const found: RetainedLeftover[] = []
	for (const name of (await readdir(root)).sort()) {
		const item = await leftover("checkpoint-quarantine", join(root, name))
		if (item !== null) found.push(item)
	}
	return found
}

const preservedCheckpoints = async (dataDir: string): Promise<ReadonlyArray<PreservedCheckpoint>> => {
	const pins = await listPreservedCheckpointPins(dataDir)
	const byCheckpoint = new Map<CheckpointId, number>()
	for (const pin of pins) byCheckpoint.set(pin.checkpointId, (byCheckpoint.get(pin.checkpointId) ?? 0) + 1)
	const preserved: PreservedCheckpoint[] = []
	for (const [checkpointId, count] of byCheckpoint) {
		const snapshot = join(resolve(dataDir), "backups", "snapshots", checkpointId)
		const resolved = existsSync(join(snapshot, "manifest.json"))
			? await resolveCheckpointInRegistry(dataDir, checkpointId).then(
					(value) => Option.some(value),
					() => Option.none(),
				)
			: Option.none()
		preserved.push({
			checkpointId,
			pins: count,
			bytes: existsSync(snapshot) ? await treeBytes(snapshot) : 0,
			createdAt: Option.isSome(resolved) ? resolved.value.manifest.createdAt : null,
			validation: Option.isSome(resolved) ? resolved.value.manifest.validation : null,
		})
	}
	return preserved
}

const pendingBlocker = (dataDir: string): string | null =>
	existsSync(restoreTransactionPath(dataDir)) || existsSync(resetTransactionPath(dataDir))
		? "a checkpoint restore or reset is unfinished; run `maple start` once to reconcile it first"
		: null

/** List everything retained for `dataDir`. Read-only. */
export const listRetainedLeftovers = async (dataDirInput: string): Promise<RetainedInventory> => {
	const dataDir = resolve(dataDirInput)
	const notes: string[] = []
	const journal = await readMigrationJournalStructure(dataDir).then(
		(value) => Option.some(value),
		() => Option.none(),
	)
	if (Option.isNone(journal))
		notes.push("the migration journal is unreadable, so migration leftovers are not listed")
	const leftovers = [
		...(await siblingLeftovers(dataDir)),
		...(Option.isSome(journal)
			? await migrationLeftovers(dataDir, journal.value?.migrationId ?? null)
			: []),
		...(await checkpointQuarantineLeftovers(dataDir)),
	]
	return {
		dataDir,
		leftovers,
		preserved: await preservedCheckpoints(dataDir),
		blocker: pendingBlocker(dataDir),
		notes,
	}
}

/**
 * Remove every listed leftover under the maintenance lock, re-listing inside
 * it so nothing a concurrent operation just created is taken. Preserved
 * checkpoints are not touched here (see `releasePreservedCheckpoints`).
 */
export const pruneRetainedLeftovers = async (
	dataDirInput: string,
	operationId: string,
): Promise<ReadonlyArray<RetainedLeftover>> => {
	const dataDir = resolve(dataDirInput)
	return withMaintenanceLock(dataDir, operationId, async () => {
		const inventory = await listRetainedLeftovers(dataDir)
		if (inventory.blocker !== null) {
			throw new RetainedLeftoverError({ dataDir, message: inventory.blocker })
		}
		for (const item of inventory.leftovers) {
			const info = await lstat(item.path)
			if (info.isSymbolicLink()) {
				throw new RetainedLeftoverError({
					dataDir,
					message: `refusing symlinked leftover: ${item.path}`,
				})
			}
			await rm(item.path, { recursive: item.entry === "directory" })
			await syncDirectory(dirname(item.path))
		}
		return inventory.leftovers
	})
}
