import { readFileSync } from "node:fs"
import { deserialize } from "node:v8"
import { PGlite } from "@electric-sql/pglite"
import { Effect, Layer } from "effect"
import { inject } from "vitest"

import { FixtureMemoryFS, type PgliteFixture } from "../../test/pglite-fixture"
import { Database } from "./DatabaseLive"
import { makeDatabaseFromInstance } from "./DatabasePgliteLive"

declare module "vitest" {
	interface ProvidedContext {
		pgliteSnapshot: string
	}
}

// The post-migration data directory, read once per worker process and shared by
// every instance it creates. The vitest globalSetup guarantees it exists before
// any worker starts; a missing file means this module was loaded outside the
// suite's own config, which is a wiring bug rather than something to paper over.
// SAFETY: globalSetup serializes this exact internal type into the engine/version-keyed fixture.
const SNAPSHOT = deserialize(readFileSync(inject("pgliteSnapshot"))) as PgliteFixture

/**
 * Per-test embedded Postgres. Each call creates a fresh in-memory PGlite
 * instance restored from the pre-migrated snapshot, so the schema is already
 * there and no migration or tar parsing runs per test. FixtureMemoryFS copies
 * each file into a new filesystem; no live database is reused. The same
 * instance backs the raw-SQL helpers below — PGlite is single-connection, so
 * there is no second connection to the DB.
 */
export interface TestDb {
	readonly pglite: PGlite
	readonly layer: Layer.Layer<Database>
	readonly close: () => Promise<void>
}

/**
 * Reject a bound `Date`.
 *
 * The postgres.js driver this suite used to model refused a `Date` param
 * outright, and a raw `sql` template binding one reached production and
 * stalled the error tick for 25 hours because PGlite serializes it happily.
 * node-postgres accepts a `Date` too, so the guard no longer mirrors a driver
 * difference; it enforces the convention that outlived it. There is no
 * legitimate `Date` param: every timestamptz column is `mode: "date"`, whose
 * `mapToDriverValue` already returns an ISO string. A `Date` surviving into the
 * param array therefore always means a raw `sql` fragment with no column type
 * behind it — use `msToSqlTimestamp` there.
 */
const assertNoDateParams = (sql: string, params: unknown[] | undefined): void => {
	const index = params?.findIndex((param) => param instanceof Date) ?? -1
	if (index === -1) return
	throw new Error(
		`Bound a Date as param $${index + 1}: raw \`sql\` fragments have no column type to serialize it. ` +
			`Interpolate an ISO string (msToSqlTimestamp) into raw \`sql\` templates instead.\n${sql}`,
	)
}

/**
 * PGlite with the guard applied to `query`. `@effect/sql-pglite` sends every
 * statement through it, BEGIN and COMMIT included, so transactions are covered
 * without wrapping `pglite.transaction`, which it never calls.
 */
const withDateParamGuard = <T extends object>(client: T): T =>
	new Proxy(client, {
		get(target, property) {
			// SAFETY: a Proxy get trap receives a key for its target; indexed access preserves
			// the target's own property type while the runtime branch below validates callability.
			const value = target[property as keyof T]
			if (typeof value !== "function") return value
			if (property === "query") {
				return (sql: string, params?: unknown[], ...rest: unknown[]) => {
					assertNoDateParams(sql, params)
					return value.call(target, sql, params, ...rest)
				}
			}
			return value.bind(target)
		},
	})

export const createTestDb = (track?: TestDb[]): TestDb => {
	const pglite = new PGlite({ fs: new FixtureMemoryFS(SNAPSHOT) })
	// Building the layer twice over the same DB is legitimate (tests that provide
	// makeLayer twice to simulate concurrent service instances). Restoring the
	// snapshot is the constructor's job and happens once, so both builds just wait
	// on the same readiness promise — there is no longer a non-idempotent `exec`
	// to memoize around.
	const layer = Layer.effect(
		Database,
		Effect.gen(function* () {
			yield* Effect.promise(() => pglite.waitReady)
			// The raw instance stays on `TestDb.pglite` for executeSql/queryFirstRow —
			// those are test fixtures writing their own SQL, not the app's write path.
			// A database that cannot be built over a ready PGlite is a harness defect.
			return yield* makeDatabaseFromInstance(withDateParamGuard(pglite)).pipe(Effect.orDie)
		}),
	)
	const db: TestDb = {
		pglite,
		layer,
		close: () => pglite.close(),
	}
	track?.push(db)
	return db
}

export const cleanupTestDbs = async (dbs: TestDb[]): Promise<void> => {
	for (const db of dbs.splice(0, dbs.length)) {
		await db.close().catch(() => {})
	}
}

/** Raw SQL against the test instance. Placeholders are Postgres-style ($1, $2, …). */
export const executeSql = async (db: TestDb, sql: string, params: unknown[] = []): Promise<void> => {
	await db.pglite.query(sql, params)
}

export const queryFirstRow = async <T>(
	db: TestDb,
	sql: string,
	params: unknown[] = [],
): Promise<T | undefined> => {
	const result = await db.pglite.query<T>(sql, params)
	return result.rows[0]
}
