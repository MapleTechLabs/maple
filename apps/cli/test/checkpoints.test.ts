import { describe, it } from "@effect/vitest"
import { ok, rejects, strictEqual } from "node:assert"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	buildingDir,
	currentDir,
	previousDir,
	promoteBuilding,
	readCheckpointManifest,
	writeBackupConfig,
} from "../src/server/checkpoints"
import { SCHEMA_FINGERPRINT } from "../src/server/serve"
import { CHDB_VERSION, MAPLE_VERSION } from "../src/version"

const withDataDir = async (run: (dataDir: string) => Promise<void> | void): Promise<void> => {
	const parent = mkdtempSync(join(tmpdir(), "maple-checkpoint-test-"))
	const dataDir = join(parent, "data")
	mkdirSync(dataDir, { recursive: true })
	try {
		await run(dataDir)
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}

const writeMarker = (path: string, value: string): void => {
	mkdirSync(path, { recursive: true })
	writeFileSync(join(path, "marker.txt"), value)
}

const readMarker = (path: string): string => readFileSync(join(path, "marker.txt"), "utf8")

const manifest = (overrides: Record<string, unknown> = {}): string =>
	`${JSON.stringify(
		{
			mapleVersion: MAPLE_VERSION,
			chdbVersion: CHDB_VERSION,
			schemaFingerprint: SCHEMA_FINGERPRINT,
			createdAt: "2026-01-01T00:00:00.000Z",
			sourceDataDir: "/tmp/maple-data",
			backupPath: "backups/current/backup",
			backupBytes: 123,
			validation: {
				validatedAt: "2026-01-01T00:00:01.000Z",
				traces: 1,
				logs: 2,
				metricsSum: 3,
				materializedViews: 33,
			},
			...overrides,
		},
		null,
		2,
	)}\n`

describe("writeBackupConfig", () => {
	it("writes the runtime backup config for the default disk", async () => {
		await withDataDir((dataDir) => {
			const configPath = join(dataDir, "config.xml")
			writeBackupConfig(configPath)

			const xml = readFileSync(configPath, "utf8")
			ok(xml.includes("<allowed_disk>default</allowed_disk>"))
			ok(xml.includes("<allowed_path>backups</allowed_path>"))
			ok(!xml.includes("<storage_configuration>"))
		})
	})

	it("writes a restore config with an escaped source disk path", async () => {
		await withDataDir((dataDir) => {
			const configPath = join(dataDir, "config.xml")
			const sourceDataDir = join(dataDir, "source & <store>")
			writeBackupConfig(configPath, sourceDataDir)

			const xml = readFileSync(configPath, "utf8")
			ok(xml.includes("<allowed_disk>src</allowed_disk>"))
			ok(xml.includes("<allowed_path>backups</allowed_path>"))
			ok(xml.includes("<storage_configuration>"))
			ok(xml.includes("source &amp; &lt;store&gt;"))
			ok(xml.includes("</path>"))
		})
	})
})

describe("promoteBuilding", () => {
	it("promotes building to current when no current checkpoint exists", async () => {
		await withDataDir(async (dataDir) => {
			writeMarker(buildingDir(dataDir), "new")

			await promoteBuilding(dataDir)

			ok(!existsSync(buildingDir(dataDir)))
			strictEqual(readMarker(currentDir(dataDir)), "new")
			ok(!existsSync(previousDir(dataDir)))
		})
	})

	it("moves current to previous and replaces any older previous checkpoint", async () => {
		await withDataDir(async (dataDir) => {
			writeMarker(previousDir(dataDir), "old-previous")
			writeMarker(currentDir(dataDir), "old-current")
			writeMarker(buildingDir(dataDir), "new-current")

			await promoteBuilding(dataDir)

			ok(!existsSync(buildingDir(dataDir)))
			strictEqual(readMarker(currentDir(dataDir)), "new-current")
			strictEqual(readMarker(previousDir(dataDir)), "old-current")
		})
	})
})

describe("readCheckpointManifest", () => {
	it("round-trips a compatible checkpoint manifest", async () => {
		await withDataDir(async (dataDir) => {
			mkdirSync(currentDir(dataDir), { recursive: true })
			writeFileSync(join(currentDir(dataDir), "manifest.json"), manifest())

			const parsed = await readCheckpointManifest(dataDir)

			strictEqual(parsed.chdbVersion, CHDB_VERSION)
			strictEqual(parsed.schemaFingerprint, SCHEMA_FINGERPRINT)
			strictEqual(parsed.validation.materializedViews, 33)
		})
	})

	it("rejects a manifest from a different chDB or schema", async () => {
		await withDataDir(async (dataDir) => {
			mkdirSync(currentDir(dataDir), { recursive: true })
			writeFileSync(join(currentDir(dataDir), "manifest.json"), manifest({ chdbVersion: "v0.0.0" }))

			await rejects(readCheckpointManifest(dataDir), /checkpoint chDB version mismatch/)

			writeFileSync(
				join(currentDir(dataDir), "manifest.json"),
				manifest({ schemaFingerprint: "old-schema" }),
			)
			await rejects(readCheckpointManifest(dataDir), /checkpoint schema mismatch/)
		})
	})
})
