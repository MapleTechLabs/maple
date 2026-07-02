import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { cp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve, sep } from "node:path"
import { Effect, Schema } from "effect"
import { Chdb } from "./chdb"
import { SCHEMA_FINGERPRINT } from "./serve"
import schemaSql from "./schema/local-schema.sql" with { type: "text" }
import { markStoreClosed, storeMarkerJson, storeMarkerPath } from "./store-version"
import { CHDB_VERSION, MAPLE_VERSION } from "../version"

export class CheckpointError extends Schema.TaggedErrorClass<CheckpointError>()(
	"@maple/cli/CheckpointError",
	{ message: Schema.String },
) {}

export interface CheckpointOptions {
	readonly dataDir: string
	readonly port: number
}

export const checkpointRoot = (dataDir: string): string => join(dataDir, "backups")
export const buildingDir = (dataDir: string): string => join(checkpointRoot(dataDir), "building")
export const currentDir = (dataDir: string): string => join(checkpointRoot(dataDir), "current")
export const previousDir = (dataDir: string): string => join(checkpointRoot(dataDir), "previous")
const restoreBuildingDir = (dataDir: string): string => `${dataDir}.restore-building`
const quarantineDir = (dataDir: string): string =>
	`${dataDir}.quarantine-${new Date().toISOString().replace(/[:.]/g, "-")}`

const backupSqlPath = (name: string): string => `backups/${name}/backup`

const xmlEscape = (value: string): string =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;")

const dataDirWithSlash = (dataDir: string): string => {
	const abs = resolve(dataDir)
	return abs.endsWith(sep) ? abs : `${abs}${sep}`
}

export const writeBackupConfig = (path: string, sourceDataDir?: string): void => {
	const sourceDisk = sourceDataDir
		? `
  <storage_configuration>
    <disks>
      <src>
        <path>${xmlEscape(dataDirWithSlash(sourceDataDir))}</path>
      </src>
    </disks>
  </storage_configuration>`
		: ""
	writeFileSync(
		path,
		`<clickhouse>
  <backups>
    <allowed_disk>${sourceDataDir ? "src" : "default"}</allowed_disk>
    <allowed_path>backups</allowed_path>
  </backups>${sourceDisk}
</clickhouse>
`,
	)
}

const postLocalQuery = async (port: number, sql: string): Promise<unknown> => {
	const response = await fetch(`http://127.0.0.1:${port}/local/query`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sql }),
	})
	if (!response.ok) {
		const detail = await response.text().catch(() => "")
		throw new Error(
			`local query failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
		)
	}
	return response.json()
}

const readJsonRows = (text: string): ReadonlyArray<Record<string, unknown>> =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)

const countFrom = (rows: ReadonlyArray<Record<string, unknown>>): number => {
	const row = rows[0]
	if (!row) return 0
	const value = row["count()"] ?? row.count
	return typeof value === "number" ? value : Number(value ?? 0)
}

const queryCount = (db: Chdb, sql: string): number => countFrom(readJsonRows(db.query(sql)))

const dirSize = async (path: string): Promise<number> => {
	let total = 0
	const entries = await readdir(path, { withFileTypes: true })
	for (const entry of entries) {
		const child = join(path, entry.name)
		if (entry.isDirectory()) {
			total += await dirSize(child)
		} else if (entry.isFile()) {
			total += (await stat(child)).size
		}
	}
	return total
}

interface CheckpointManifest {
	readonly mapleVersion: string
	readonly chdbVersion: string
	readonly schemaFingerprint: string
	readonly createdAt: string
	readonly sourceDataDir: string
	readonly backupPath: string
	readonly backupBytes: number
	readonly validation: {
		readonly validatedAt: string
		readonly traces: number
		readonly logs: number
		readonly metricsSum: number
		readonly materializedViews: number
	}
}

export const readCheckpointManifest = async (dataDir: string): Promise<CheckpointManifest> => {
	const path = join(currentDir(dataDir), "manifest.json")
	let raw: string
	try {
		raw = await readFile(path, "utf8")
	} catch {
		throw new Error(`checkpoint manifest not found at ${path}`)
	}
	const parsed = JSON.parse(raw) as Partial<CheckpointManifest>
	if (parsed.chdbVersion !== CHDB_VERSION) {
		throw new Error(
			`checkpoint chDB version mismatch (checkpoint: ${parsed.chdbVersion ?? "unknown"}; build: ${CHDB_VERSION})`,
		)
	}
	if (parsed.schemaFingerprint !== SCHEMA_FINGERPRINT) {
		throw new Error(
			`checkpoint schema mismatch (checkpoint: ${parsed.schemaFingerprint ?? "unknown"}; build: ${SCHEMA_FINGERPRINT})`,
		)
	}
	return parsed as CheckpointManifest
}

const validateBackup = async (dataDir: string): Promise<CheckpointManifest["validation"]> => {
	const scratchParent = mkdtempSync(join(tmpdir(), "maple-checkpoint-"))
	const scratchData = join(scratchParent, "data")
	const scratchConfig = join(scratchParent, "config.xml")
	writeBackupConfig(scratchConfig, dataDir)
	let db: Chdb | undefined
	try {
		db = Chdb.open({
			dataDir: scratchData,
			schemaSql,
			configFile: scratchConfig,
			bootstrapSchema: false,
		})
		db.exec("CREATE DATABASE IF NOT EXISTS default")
		db.exec(
			`RESTORE DATABASE default FROM Disk('src', '${backupSqlPath("building")}') ` +
				"SETTINGS allow_different_database_def=1",
		)
		return {
			validatedAt: new Date().toISOString(),
			traces: queryCount(db, "SELECT count() FROM traces"),
			logs: queryCount(db, "SELECT count() FROM logs"),
			metricsSum: queryCount(db, "SELECT count() FROM metrics_sum"),
			materializedViews: queryCount(
				db,
				"SELECT count() FROM system.tables WHERE database = 'default' AND engine = 'MaterializedView'",
			),
		}
	} finally {
		db?.close()
		rmSync(scratchParent, { recursive: true, force: true })
	}
}

const restoreIntoScratch = async (
	sourceDataDir: string,
	targetDataDir: string,
	checkpointName: "current" | "building",
): Promise<CheckpointManifest["validation"]> => {
	const scratchParent = mkdtempSync(join(tmpdir(), "maple-restore-"))
	const restoreConfig = join(scratchParent, "config.xml")
	writeBackupConfig(restoreConfig, sourceDataDir)
	let db: Chdb | undefined
	try {
		db = Chdb.open({
			dataDir: targetDataDir,
			schemaSql,
			configFile: restoreConfig,
			bootstrapSchema: false,
		})
		db.exec("CREATE DATABASE IF NOT EXISTS default")
		db.exec(
			`RESTORE DATABASE default FROM Disk('src', '${backupSqlPath(checkpointName)}') ` +
				"SETTINGS allow_different_database_def=1",
		)
		return {
			validatedAt: new Date().toISOString(),
			traces: queryCount(db, "SELECT count() FROM traces"),
			logs: queryCount(db, "SELECT count() FROM logs"),
			metricsSum: queryCount(db, "SELECT count() FROM metrics_sum"),
			materializedViews: queryCount(
				db,
				"SELECT count() FROM system.tables WHERE database = 'default' AND engine = 'MaterializedView'",
			),
		}
	} finally {
		db?.close()
		rmSync(scratchParent, { recursive: true, force: true })
	}
}

export const promoteBuilding = async (dataDir: string): Promise<void> => {
	await rm(previousDir(dataDir), { recursive: true, force: true })
	try {
		await rename(currentDir(dataDir), previousDir(dataDir))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	await rename(buildingDir(dataDir), currentDir(dataDir))
}

export const createCheckpoint = (
	options: CheckpointOptions,
): Effect.Effect<{ readonly path: string; readonly manifest: CheckpointManifest }, CheckpointError> =>
	Effect.tryPromise({
		try: async () => {
			const root = checkpointRoot(options.dataDir)
			const building = buildingDir(options.dataDir)
			const name = basename(building)
			if (name !== "building") throw new Error("internal checkpoint path error")
			await rm(building, { recursive: true, force: true })

			try {
				await postLocalQuery(
					options.port,
					`BACKUP DATABASE default TO Disk('default', '${backupSqlPath("building")}')`,
				)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				if (
					message.includes("backups.allowed_disk") ||
					message.includes("INVALID_CONFIG_PARAMETER")
				) {
					throw new Error(
						"checkpoints require the local server to be started with `--chdb-config-file` " +
							"pointing at a ClickHouse backups config",
					)
				}
				throw error
			}

			const validation = await validateBackup(options.dataDir)
			const manifest: CheckpointManifest = {
				mapleVersion: MAPLE_VERSION,
				chdbVersion: CHDB_VERSION,
				schemaFingerprint: SCHEMA_FINGERPRINT,
				createdAt: new Date().toISOString(),
				sourceDataDir: resolve(options.dataDir),
				backupPath: backupSqlPath("current"),
				backupBytes: await dirSize(join(building, "backup")),
				validation,
			}
			await writeFile(join(building, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
			await promoteBuilding(options.dataDir)
			return {
				path: join(root, "current"),
				manifest: { ...manifest, backupPath: backupSqlPath("current") },
			}
		},
		catch: (error) =>
			new CheckpointError({ message: error instanceof Error ? error.message : String(error) }),
	})

export const restoreCheckpoint = (
	dataDir: string,
): Effect.Effect<
	{ readonly quarantinePath: string; readonly validation: CheckpointManifest["validation"] },
	CheckpointError
> =>
	Effect.tryPromise({
		try: async () => {
			const sourceBackup = join(currentDir(dataDir), "backup")
			if (!existsSync(sourceBackup)) {
				throw new Error(`no checkpoint found at ${sourceBackup}`)
			}
			await readCheckpointManifest(dataDir)

			const restoreDir = restoreBuildingDir(dataDir)
			await rm(restoreDir, { recursive: true, force: true })
			const validation = await restoreIntoScratch(dataDir, restoreDir, "current")

			if (existsSync(join(dataDir, "backups"))) {
				await cp(join(dataDir, "backups"), join(restoreDir, "backups"), {
					recursive: true,
					force: true,
				})
			}

			const quarantinePath = quarantineDir(dataDir)
			await rename(dataDir, quarantinePath)
			await rename(restoreDir, dataDir)
			markStoreClosed(dataDir)
			writeFileSync(
				storeMarkerPath(dataDir),
				storeMarkerJson(MAPLE_VERSION, new Date().toISOString(), SCHEMA_FINGERPRINT),
			)
			return { quarantinePath, validation }
		},
		catch: (error) =>
			new CheckpointError({ message: error instanceof Error ? error.message : String(error) }),
	})
