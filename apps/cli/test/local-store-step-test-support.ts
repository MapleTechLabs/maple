import { Option, Array as Arr } from "effect"
import { Chdb } from "@maple/local-server/chdb"
import type { MigrationDbOptions, MigrationModuleContext } from "../src/server/local-store-migration-module"
import { localStoreMigrations } from "../src/server/local-store-migrations"

/** Opens a store with no bootstrap unless asked, closing it after `fn`. */
export const openStore = async <A>(
	dataDir: string,
	fn: (db: Chdb) => A | Promise<A>,
	options: MigrationDbOptions = {},
) => {
	const db = Chdb.open({
		dataDir,
		schemaSql: options.schemaSql ?? "",
		bootstrapSchema: options.bootstrapSchema ?? false,
	})
	try {
		return await fn(db)
	} finally {
		db.close()
	}
}

/** The migration step `id` and a context that runs it from `sourceDataDir` into `targetDataDir`. */
export const migrationStep = (id: string, sourceDataDir: string, targetDataDir: string, nowMs: number) => {
	const found = Arr.findFirst(localStoreMigrations, (candidate) => candidate.id === id)
	if (Option.isNone(found)) throw new Error(`no local-store migration ${id}`)
	const migration = found.value
	const context: MigrationModuleContext = {
		dataDir: sourceDataDir,
		sourceDataDir,
		targetDataDir,
		source: migration.from,
		target: migration.to,
		cutoffAt: new Date(nowMs).toISOString(),
		step: { id, moduleVersion: 1, from: migration.from, to: migration.to, status: "running" },
		openSource: (fn, options) => openStore(sourceDataDir, fn, options),
		openTarget: (fn, options) => openStore(targetDataDir, fn, options),
		closeStores: async () => undefined,
		ensureCapacity: async () => undefined,
		saveStep: async () => undefined,
	}
	return { migration, context }
}
