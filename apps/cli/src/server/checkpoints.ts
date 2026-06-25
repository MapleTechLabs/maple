import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve, sep } from "node:path"
import { Effect, Schema } from "effect"
import { Chdb } from "./chdb"
import { SCHEMA_FINGERPRINT } from "./serve"
import schemaSql from "./schema/local-schema.sql" with { type: "text" }
import { CHDB_VERSION, MAPLE_VERSION } from "../version"

export class CheckpointError extends Schema.TaggedErrorClass<CheckpointError>()(
	"@maple/cli/CheckpointError",
	{ message: Schema.String },
) {}

export interface CheckpointOptions {
	readonly dataDir: string
	readonly port: number
}

const checkpointRoot = (dataDir: string): string => join(dataDir, "backups")
const buildingDir = (dataDir: string): string => join(checkpointRoot(dataDir), "building")
const currentDir = (dataDir: string): string => join(checkpointRoot(dataDir), "current")
const previousDir = (dataDir: string): string => join(checkpointRoot(dataDir), "previous")

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

const writeBackupConfig = (path: string, sourceDataDir?: string): void => {
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
		throw new Error(`local query failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`)
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

const promoteBuilding = async (dataDir: string): Promise<void> => {
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

			await postLocalQuery(
				options.port,
				`BACKUP DATABASE default TO Disk('default', '${backupSqlPath("building")}')`,
			)

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
			return { path: join(root, "current"), manifest: { ...manifest, backupPath: backupSqlPath("current") } }
		},
		catch: (error) =>
			new CheckpointError({ message: error instanceof Error ? error.message : String(error) }),
	})
