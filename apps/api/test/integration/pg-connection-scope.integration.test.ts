import { assert, describe, it } from "@effect/vitest"
import { makeMaplePgClient } from "@maple/db/client"
import { sql } from "drizzle-orm"
import { Effect, Tracer } from "effect"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import { forkRequestScoped } from "@maple/backend/platform/fork-request-scoped"
import {
	makePgConnectionScope,
	MAX_CONNECTIONS,
	PgConnectionScope,
	withPgConnectionScopeOf,
} from "@maple/backend/platform/pg-connection-scope"
import { isPostgresConnectionError, postgresErrorType } from "@maple/backend/platform/postgres-errors"
import { rawRows } from "@maple/backend/platform/raw-rows"

/**
 * These assertions are the reason this suite exists. The unit tests replace the
 * client with a fake, so they can only prove the scope calls `openClient` once —
 * not that one real TCP connection serves the whole request. Here the proof
 * comes from the server: a separate admin connection counts backends in
 * `pg_stat_activity`.
 */
const PG_URL = process.env.MAPLE_TEST_PG_URL

/** Admin connection targets `postgres`, so its own backend never pollutes the count. */
const adminUrlFor = (url: string): { admin: string; database: string } => {
	const parsed = new URL(url)
	const database = parsed.pathname.replace(/^\//, "")
	parsed.pathname = "/postgres"
	return { admin: parsed.toString(), database }
}

const makeRecordingTracer = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	return { spans, tracer }
}

const dbSpans = (spans: ReadonlyArray<Tracer.NativeSpan>) =>
	spans.filter((span) => span.attributes.get("db.system.name") === "postgresql")

/**
 * `describe.skipIf` still evaluates the body, so the setup below needs a URL it
 * can parse even when the suite is skipped. Nothing below dials until a test
 * runs, so the placeholder never reaches the network.
 */
const PLACEHOLDER_URL = "postgres://skipped:skipped@127.0.0.1:1/skipped"

describe.skipIf(PG_URL === undefined)("PgConnectionScope against a real Postgres", () => {
	const url = PG_URL ?? PLACEHOLDER_URL
	const { admin: adminUrl, database } = adminUrlFor(url)
	/**
	 * Backends currently open against the test database, excluding the admin's own.
	 *
	 * One admin connection per count, opened and closed around the query: it
	 * targets the `postgres` database, so it is never one of the backends being
	 * counted, and holding it open across the suite would be a second long-lived
	 * connection to reason about in a suite about connection lifetime.
	 */
	const backends = async (): Promise<number> => {
		const rows = await Effect.runPromise(
			Effect.scoped(
				Effect.flatMap(
					makeMaplePgClient(adminUrl, { maxConnections: 1, connectTimeoutSeconds: 10 }),
					(client) =>
						client.unsafe<{ n: number }>(
							"select count(*)::int as n from pg_stat_activity where datname = $1",
							[database],
						),
				),
			).pipe(Effect.provide(Reactivity.layer)),
		)
		return rows[0]?.n ?? 0
	}

	/**
	 * Every assertion here is a DELTA against a baseline sampled at the start of
	 * the test, never an absolute count. The docker Postgres these run against is
	 * shared — a dev server or a previous run can hold tens of backends on the
	 * same database — and an absolute count turns that into a spurious failure
	 * about connection scoping.
	 */
	const settle = async (): Promise<number> => {
		let previous = await backends()
		for (let attempt = 0; attempt < 30; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100))
			const n = await backends()
			if (n === previous) return n
			previous = n
		}
		return previous
	}

	/** Wait for the scope's own backends to reach `expected`, ignoring ambient ones. */
	const waitForDelta = async (baseline: number, expected: number): Promise<number> => {
		for (let attempt = 0; attempt < 50; attempt++) {
			const delta = (await backends()) - baseline
			if (delta === expected) return delta
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
		return (await backends()) - baseline
	}

	it("serves many sequential executes from a single backend, and releases it on close", async () => {
		const baseline = await settle()
		const scope = makePgConnectionScope(url)

		// Sampled AFTER each execute, not inside it: the pool is lazy, so before
		// the first statement runs there is legitimately no connection yet.
		const observed: Array<number> = []
		try {
			for (let i = 0; i < 5; i++) {
				await Effect.runPromise(scope.run((db) => db.execute(sql`select 1 as one`)))
				observed.push((await backends()) - baseline)
			}
		} finally {
			await Effect.runPromise(scope.close)
		}

		// The claim this rests on: five SEQUENTIAL executes, one connection. Each of
		// these used to be its own handshake and its own outbound slot. Raising the
		// pool ceiling does not change this — node-postgres opens a second socket
		// only when a second statement is actually in flight.
		assert.deepStrictEqual(observed, [1, 1, 1, 1, 1])
		assert.strictEqual(await waitForDelta(baseline, 0), 0)
	})

	it("bounds concurrent executes by the pool ceiling and does not cross-attribute their SQL", async () => {
		const baseline = await settle()
		const scope = makePgConnectionScope(url)
		const { spans, tracer } = makeRecordingTracer()

		await Effect.runPromise(
			Effect.all(
				[
					scope.run((db) => db.execute(sql`select 'alpha_marker' as tag`)),
					scope.run((db) => db.execute(sql`select 'beta_marker' as tag`)),
				],
				{ concurrency: 2 },
			).pipe(Effect.withTracer(tracer)),
		)

		const backendsDuring = (await backends()) - baseline

		// The real test of the per-call statement collector. Drizzle fixes its
		// logger at construction, so the logger reads the collector off the calling
		// fiber; a single shared collector would put both statements on whichever
		// span looked last. The unit suite can only assert the calls see different
		// collectors; this asserts the consequence that actually matters.
		const texts = dbSpans(spans).map((span) => String(span.attributes.get("db.query.text") ?? ""))
		assert.strictEqual(texts.length, 2)
		const alpha = texts.filter((text) => text.includes("alpha_marker"))
		const beta = texts.filter((text) => text.includes("beta_marker"))
		assert.strictEqual(alpha.length, 1)
		assert.strictEqual(beta.length, 1)
		assert.notInclude(alpha[0], "beta_marker")
		assert.notInclude(beta[0], "alpha_marker")

		// This asserted exactly 1 while the pool was capped at 1, which is the cap
		// that serialized cron ticks behind a single connection. The contract now is
		// a CEILING, not serialization: concurrent statements may open up to
		// `MAX_CONNECTIONS` and no more. How many of the two land together is a race
		// between them, so the lower bound is 1, not 2.
		assert.isAtLeast(backendsDuring, 1)
		assert.isAtMost(backendsDuring, MAX_CONNECTIONS)

		await Effect.runPromise(scope.close)
		assert.strictEqual(await waitForDelta(baseline, 0), 0)
	})

	it("overlaps concurrent statements instead of serializing them", async () => {
		// The regression this whole change exists for. With the pool capped at 1,
		// four 300ms statements queue head-to-tail and take ~1.2s; a cron tick issuing
		// thousands is what took `SELECT actors` from p50 928ms to 5687ms in
		// production. `pg_sleep` makes the serialization observable in wall time,
		// which no fake pool can do.
		const baseline = await settle()
		const scope = makePgConnectionScope(url)
		const sleepSeconds = 0.3
		const concurrency = 4

		const startedAt = Date.now()
		await Effect.runPromise(
			Effect.all(
				Array.from({ length: concurrency }, () =>
					scope.run((db) => db.execute(sql`select pg_sleep(${sleepSeconds})`)),
				),
				{ concurrency },
			),
		)
		const elapsedMs = Date.now() - startedAt

		// Serialized would be >= 1200ms. Overlapped is one sleep plus scheduling.
		// The midpoint is a wide margin either way, so this is not timing-flaky.
		assert.isBelow(elapsedMs, sleepSeconds * 1000 * concurrency * 0.6)
		assert.isAtMost((await backends()) - baseline, MAX_CONNECTIONS)

		await Effect.runPromise(scope.close)
		assert.strictEqual(await waitForDelta(baseline, 0), 0)
	})

	it("runs a transaction and lets queued executes through beside it", async () => {
		const baseline = await settle()
		const scope = makePgConnectionScope(url)
		const table = `scope_txn_${Date.now()}`

		await Effect.runPromise(
			scope.run((db) => db.execute(sql.raw(`create table ${table} (id int primary key)`))),
		)

		// A transaction pins whichever connection it runs on for its whole duration.
		// Anything issued alongside it must still complete rather than deadlock —
		// the risk originally flagged when the pool was fixed at one, and still worth
		// holding now that the ceiling lets the sibling take its own connection.
		const [, queued] = await Effect.runPromise(
			Effect.all(
				[
					scope.run((db) =>
						db.transaction((tx) =>
							Effect.gen(function* () {
								yield* tx.execute(sql.raw(`insert into ${table} (id) values (1)`))
								yield* tx.execute(sql.raw(`insert into ${table} (id) values (2)`))
							}),
						),
					),
					scope.run((db) => db.execute(sql`select 'queued' as tag`)),
				],
				{ concurrency: 2 },
			),
		)

		assert.isDefined(queued)
		const rows = rawRows(
			await Effect.runPromise(
				scope.run((db) =>
					db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`), "objects"),
				),
			),
		)
		assert.strictEqual(rows[0]?.n, 2)
		assert.isAtMost((await backends()) - baseline, MAX_CONNECTIONS)

		await Effect.runPromise(scope.run((db) => db.execute(sql.raw(`drop table ${table}`))))
		await Effect.runPromise(scope.close)
		assert.strictEqual(await waitForDelta(baseline, 0), 0)
	})

	it("lets a statement wait for a busy pool longer than the dial bound", async () => {
		// A pool-level connect bound would fail a fan-out wider than the pool as
		// "timeout exceeded when trying to connect" against a healthy server. The
		// driver bounds each connection's dial instead; the queue waits.
		const dialBoundSeconds = 0.3
		const scope = makePgConnectionScope(url, undefined, {
			openClient: (options) =>
				makeMaplePgClient(url, {
					...options,
					maxConnections: 1,
					connectTimeoutSeconds: dialBoundSeconds,
				}),
		})

		const results = await Effect.runPromise(
			Effect.all(
				[
					scope.run((db) => db.execute(sql`select pg_sleep(0.8)`)),
					scope.run((db) => db.execute(sql`select 'waited' as tag`)),
				],
				{ concurrency: 2 },
			).pipe(Effect.exit),
		)

		await Effect.runPromise(scope.close)
		assert.isTrue(results._tag === "Success", "the queued statement timed out waiting for the pool")
	})

	it("reports a COMMIT the server rejects as a DatabaseError, not a defect", async () => {
		// `@effect/sql` runs COMMIT under `orDie`. A deferred foreign key is checked
		// only there, so every statement succeeds and the commit fails.
		const scope = makePgConnectionScope(url)
		const parent = `scope_commit_parent_${Date.now()}`
		const child = `scope_commit_child_${Date.now()}`
		const { spans, tracer } = makeRecordingTracer()
		try {
			await Effect.runPromise(
				scope.run((db) => db.execute(sql.raw(`create table ${parent} (id int primary key)`))),
			)
			await Effect.runPromise(
				scope.run((db) =>
					db.execute(
						sql.raw(
							`create table ${child} (parent_id int references ${parent} (id) deferrable initially deferred)`,
						),
					),
				),
			)

			const error = await Effect.runPromise(
				scope
					.run((db) =>
						db.transaction((tx) =>
							tx.execute(sql.raw(`insert into ${child} (parent_id) values (1)`)),
						),
					)
					.pipe(Effect.flip, Effect.withTracer(tracer)),
			)

			assert.strictEqual(error._tag, "@maple/api/lib/DatabaseError")
			assert.strictEqual(postgresErrorType(error), "23503")
			assert.isFalse(isPostgresConnectionError(error))
			assert.strictEqual(dbSpans(spans).at(-1)?.attributes.get("error.type"), "23503")
		} finally {
			await Effect.runPromise(
				scope.run((db) => db.execute(sql.raw(`drop table if exists ${child}; `))).pipe(Effect.ignore),
			)
			await Effect.runPromise(
				scope.run((db) => db.execute(sql.raw(`drop table if exists ${parent}`))).pipe(Effect.ignore),
			)
			await Effect.runPromise(scope.close)
		}
	})

	it("lands a DB write forked just before the response", async () => {
		// The API worker's nesting: the request Scope closes inside the connection
		// scope. node-postgres checks a client out on a later tick, so without
		// draining, the forked statement was still queued when the request Scope
		// interrupted it and never ran — with or without a warm connection.
		const setup = makePgConnectionScope(url)
		const table = `scope_fork_${Date.now()}`
		await Effect.runPromise(setup.run((db) => db.execute(sql.raw(`create table ${table} (tag text)`))))
		try {
			for (const warm of [false, true]) {
				const tag = warm ? "warm" : "cold"
				const scope = makePgConnectionScope(url)
				const write = Effect.gen(function* () {
					const current = yield* PgConnectionScope
					yield* current!.run((db) => db.execute(sql.raw(`insert into ${table} values ('${tag}')`)))
				})
				await Effect.runPromise(
					withPgConnectionScopeOf(
						scope,
						Effect.scoped(
							Effect.gen(function* () {
								if (warm) {
									const current = yield* PgConnectionScope
									yield* current!.run((db) => db.execute(sql`select 1`))
								}
								yield* forkRequestScoped(write)
								return "response"
							}),
						),
					),
				)
				const rows = rawRows(
					await Effect.runPromise(
						setup.run((db) =>
							db.execute<{ n: number }>(
								sql.raw(`select count(*)::int as n from ${table} where tag = '${tag}'`),
								"objects",
							),
						),
					),
				)
				assert.strictEqual(rows[0]?.n, 1, `${tag} fork did not land`)
			}
		} finally {
			await Effect.runPromise(setup.run((db) => db.execute(sql.raw(`drop table ${table}`))))
			await Effect.runPromise(setup.close)
		}
	})

	it("classifies a refused connection as a connection error on a real socket", async () => {
		// Port 1 is refused immediately. This closes the loop on postgres-errors.ts,
		// which the unit suite only exercises against hand-built error objects, and
		// is the diagnostic that replaced the connect/query duration split.
		const scope = makePgConnectionScope("postgres://maple:maple@127.0.0.1:1/never")
		const { spans, tracer } = makeRecordingTracer()

		// `flip` makes the expected failure the success channel, typed as the
		// `DatabaseError` the scope absorbs the driver's refusal into.
		const error = await Effect.runPromise(
			scope.run((db) => db.execute(sql`select 1`)).pipe(Effect.flip, Effect.withTracer(tracer)),
		)

		assert.isDefined(postgresErrorType(error))
		assert.isTrue(isPostgresConnectionError(error))
		const [span] = dbSpans(spans)
		assert.isDefined(span)
		assert.strictEqual(span.attributes.get("db.connect.failed"), true)
		assert.isDefined(span.attributes.get("error.type"))

		await Effect.runPromise(scope.close)
	})

	it("opens one connection for a whole fan-out against an unreachable origin", async () => {
		// The production shape this exists for: a request whose branches all miss
		// the org-config memo, against an origin that cannot be reached. Each branch
		// must reuse the scope's one pool rather than creating its own — an
		// unreachable origin should cost one connection attempt's worth of outbound
		// slot, not N.
		//
		// Real clients, counted: `openClient` wraps the production constructor rather
		// than replacing it, so this measures the same code path the unit test fakes.
		let creations = 0
		const scope = makePgConnectionScope("postgres://maple:maple@127.0.0.1:1/never", undefined, {
			// The seam forwards the production options rather than inventing its own,
			// so this measures the same client the request path builds.
			openClient: (options) => {
				creations += 1
				return makeMaplePgClient("postgres://maple:maple@127.0.0.1:1/never", options)
			},
		})

		// Sequential on purpose: a concurrent version would pass trivially. The case
		// that matters is the branch arriving after the previous failure resolved,
		// which must not decide to start over with a new pool.
		const results: Array<"ok" | "rejected"> = []
		for (let i = 0; i < 10; i++) {
			results.push(
				await Effect.runPromise(scope.run((db) => db.execute(sql`select 1`)))
					.then(() => "ok" as const)
					.catch(() => "rejected" as const),
			)
		}

		assert.deepStrictEqual(
			results,
			Array.from({ length: 10 }, () => "rejected" as const),
		)
		assert.strictEqual(creations, 1)

		await Effect.runPromise(scope.close)
	})
})
