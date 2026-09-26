import { describe, it } from "@effect/vitest"
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { checkpointQuarantineRoot, restoreTransactionPath } from "../src/server/checkpoints"
import { migrationJournalPath, migrationRootPath } from "../src/server/local-store-migrations"
import { listRetainedLeftovers, pruneRetainedLeftovers } from "../src/server/retained-leftovers"

const withParent = async (run: (dataDir: string) => Promise<void>): Promise<void> => {
	const parent = mkdtempSync(join(tmpdir(), "maple-retained-"))
	const dataDir = join(parent, "data")
	mkdirSync(join(dataDir, "store"), { recursive: true })
	try {
		await run(dataDir)
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}

const dir = (path: string, file = "payload"): string => {
	mkdirSync(path, { recursive: true })
	writeFileSync(join(path, file), "x".repeat(10))
	return path
}

const journal = (path: string, sourceDataDir: string): string => {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify({ migrationId: "m", sourceDataDir }))
	return path
}

describe("retained leftovers", () => {
	it("lists exactly what restores and migrations of this data dir moved aside, then prunes only that", async () => {
		await withParent(async (dataDir) => {
			const parent = dirname(dataDir)
			const expected = {
				replaced: dir(`${dataDir}.quarantine-${randomUUID()}-${randomUUID()}`),
				interrupted: dir(`${dataDir}.restore-${randomUUID()}.quarantine-${randomUUID()}`),
				lock: dir(`${dataDir}.maple-maintenance-lock.quarantine-${randomUUID()}`),
				source: dir(join(migrationRootPath(dataDir, "local-migration-a"), "source", "data")),
				abandoned: dir(
					`${migrationRootPath(dataDir, "local-migration-b")}.abandoned-${randomUUID()}`,
				),
				quarantine: dir(join(checkpointQuarantineRoot(dataDir), `operation-${randomUUID()}`)),
			}
			const record = `${dataDir}.restore-transaction.json.quarantine-${randomUUID()}`
			writeFileSync(record, "{}")
			journal(join(migrationRootPath(dataDir, "local-migration-a"), "journal.json"), dataDir)
			journal(join(expected.abandoned, "journal.json"), dataDir)
			const abandonedJournal = journal(
				join(
					dirname(migrationJournalPath(dataDir)),
					`maple-store-migration-abandoned-c-${randomUUID()}.json`,
				),
				dataDir,
			)
			// Another data dir's leftovers, lookalikes, and live state stay out of it.
			const kept = [
				dir(`${join(parent, "other")}.quarantine-${randomUUID()}-${randomUUID()}`),
				dir(`${dataDir}.quarantine-not-a-uuid`),
				dir(`${dataDir}.restore-${randomUUID()}`),
				dir(join(migrationRootPath(dataDir, "local-migration-d"), "source", "data")),
				join(dataDir, "store"),
			]
			journal(
				join(migrationRootPath(dataDir, "local-migration-d"), "journal.json"),
				join(parent, "other"),
			)

			const inventory = await listRetainedLeftovers(dataDir)

			deepStrictEqual(inventory.leftovers.map((item) => item.kind).sort(), [
				"checkpoint-quarantine",
				"maintenance-lock",
				"migration-abandoned-journal",
				"migration-abandoned-target",
				"migration-source",
				"restore-interrupted",
				"restore-replaced-store",
				"restore-transaction",
			])
			ok(inventory.leftovers.every((item) => item.bytes > 0))
			strictEqual(
				inventory.leftovers.find((item) => item.kind === "migration-source")?.path,
				dirname(expected.source),
			)
			strictEqual(inventory.blocker, null)

			const removed = await pruneRetainedLeftovers(dataDir, randomUUID())

			strictEqual(removed.length, 8)
			for (const path of [...Object.values(expected), record, abandonedJournal])
				ok(!existsSync(path), path)
			for (const path of kept) ok(existsSync(path), path)
			ok(existsSync(join(migrationRootPath(dataDir, "local-migration-a"), "journal.json")))
		})
	})

	it("refuses to prune while a restore is unfinished", async () => {
		await withParent(async (dataDir) => {
			const replaced = dir(`${dataDir}.quarantine-${randomUUID()}-${randomUUID()}`)
			writeFileSync(restoreTransactionPath(dataDir), "{}")

			const inventory = await listRetainedLeftovers(dataDir)
			ok(inventory.blocker !== null)
			await rejects(pruneRetainedLeftovers(dataDir, randomUUID()), /unfinished/)
			ok(existsSync(replaced))
		})
	})
})
