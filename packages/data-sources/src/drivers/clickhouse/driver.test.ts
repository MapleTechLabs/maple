import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Duration, Effect, Exit, Fiber, Option, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { DataSourceRateLimitedError, type SourceCatalog } from "@maple/domain/data-sources"
import { DEFAULT_LIMITS } from "../../limits"
import type { QueryRequest } from "../../port"
import { chError, connection, fakeFetch, rows } from "./fake-fetch"
import { prepareClickHouse } from "./run"
import { PLAIN_HTTP, READ_ONLY_PROFILE, testClickHouse } from "./test-connection"

const catalog: SourceCatalog = {
	entries: [
		{
			name: "shop.payments",
			kind: "table",
			fields: [
				{ name: "amount", type: "number" },
				{ name: "email", type: "string", pii: true },
			],
		},
	],
	examples: [],
	truncated: false,
}
const request: QueryRequest = {
	window: { startMs: Date.UTC(2026, 10, 1), endMs: Date.UTC(2026, 10, 2), granularitySeconds: 3600 },
	limits: { ...DEFAULT_LIMITS.interactive, maxRows: 2 },
	workload: "interactive",
	redactPii: true,
	hiddenEntries: [],
}
const run = (sql: string) =>
	Effect.flatMap(prepareClickHouse(connection, { _tag: "sql", sql }, request, catalog), (prepared) =>
		prepared.run({ spend: () => Effect.void }),
	)
const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
	Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "succeeded"

describe("ClickHouse driver over HTTP", () => {
	it.effect("returns columns in SELECT order, safe numbers, truncation, and drops PII columns", () => {
		const fake = fakeFetch((sql) =>
			Str.startsWith("DESCRIBE")(sql)
				? rows(
						{ name: "big", type: "UInt64" },
						{ name: "n", type: "UInt64" },
						{ name: "email", type: "String" },
					)
				: rows(
						{ big: "18446744073709551615", n: "1", email: "a@x" },
						{ big: "1", n: "2", email: "b@x" },
						{ big: "2", n: "3", email: "c@x" },
					),
		)
		return (
			fake
				// The SQL names no PII field; the server still returns one, which the second layer drops.
				.provide(run("SELECT big, n, contact FROM shop.payments WHERE $__timeFilter(created_at)"))
				.pipe(
					Effect.map((table) => {
						expect(table.columns).toEqual([
							{ name: "big", type: "number" },
							{ name: "n", type: "number" },
						])
						expect(table.rows).toEqual([
							{ big: "18446744073709551615", n: 1 },
							{ big: 1, n: 2 },
						])
						expect(table.truncated).toBe(true)
						const params = fake.sent[0]?.url.searchParams
						expect(params?.get("readonly")).toBe("1")
						expect(params?.get("max_result_rows")).toBe("3")
						expect(params?.get("max_execution_time")).toBe("30")
						expect(fake.sent[0]?.sql).toContain(
							"created_at >= toDateTime64('2026-11-01 00:00:00.000', 3, 'UTC')",
						)
					}),
				)
		)
	})

	it.effect("refuses SQL that could return personal data, however it is spelled", () =>
		Effect.gen(function* () {
			const fake = fakeFetch(() => rows({ n: "1" }))
			const refused = [
				"SELECT email FROM shop.payments",
				"SELECT upper(email) AS e FROM shop.payments",
				"SELECT count() FROM shop.payments WHERE email = 'a@x'",
				"SELECT `EMAIL` FROM shop.payments",
				"SELECT * FROM shop.payments",
				"SELECT p.* FROM shop.payments AS p",
				"SELECT COLUMNS('.*') FROM shop.payments",
			]
			const failures = yield* Effect.forEach(refused, (sql) => Effect.exit(fake.provide(run(sql))))
			expect(Arr.map(failures, (exit) => Str.includes("personal data")(failureOf(exit)))).toEqual(
				Arr.replicate(true, refused.length),
			)
			expect(fake.sent).toHaveLength(0)
			yield* fake.provide(run("SELECT count(*) AS n, sum(amount) AS total FROM shop.payments"))
			expect(fake.sent.length).toBeGreaterThan(0)
		}),
	)

	it.effect("refuses an escaped spelling of a personal data field", () =>
		Effect.gen(function* () {
			const fake = fakeFetch(() => rows({ n: "1" }))
			const exit = yield* Effect.exit(fake.provide(run("SELECT `e\\x6dail` FROM shop.payments")))
			expect(failureOf(exit)).toContain("Backslashes are not supported")
			expect(fake.sent).toHaveLength(0)
		}),
	)

	it.effect(
		"refuses an agent's query on a hidden table or the system database, and runs one on a visible table",
		() =>
			Effect.gen(function* () {
				const fake = fakeFetch(() => rows({ n: "1" }))
				const asAgent = (sql: string) =>
					Effect.flatMap(
						prepareClickHouse(
							connection,
							{ _tag: "sql", sql },
							{ ...request, redactPii: false, hiddenEntries: ["shop.refunds"] },
							catalog,
						),
						(prepared) => prepared.run({ spend: () => Effect.void }),
					)
				const refused = [
					"SELECT count() AS n FROM shop.refunds",
					"SELECT count() AS n FROM `refunds`",
					"SELECT name FROM system.tables",
					"SELECT count() AS n FROM shop.`ref\\x75nds`",
					"SELECT count() AS n FROM 'refunds'",
					"SELECT * FROM (EXPLAIN SELECT * FROM shop.payments)",
					// Both pass the general gate: the walk of the FROM list ends at the alias.
					"SELECT n FROM numbers(1) select, 'refunds'",
					"SELECT n FROM numbers(1) `limit`, 'ref\\x75nds'",
				]
				const failures = yield* Effect.forEach(refused, (sql) =>
					Effect.exit(fake.provide(asAgent(sql))),
				)
				expect(Arr.map(failures, (exit) => Exit.isFailure(exit))).toEqual(
					Arr.replicate(true, refused.length),
				)
				expect(fake.sent).toHaveLength(0)
				const table = yield* fake.provide(asAgent("SELECT count() AS n FROM shop.payments"))
				expect(table.rows).toEqual([{ n: "1" }])
			}),
	)

	it.effect("checks the names in the SQL as it is sent, after macros expand", () =>
		Effect.gen(function* () {
			const fake = fakeFetch(() => rows({ n: "1" }))
			// The window buckets by 3600 s, so the macro spells the hidden table `shop.3600`.
			const prepared = prepareClickHouse(
				connection,
				{ _tag: "sql", sql: "SELECT count() AS n FROM shop.$__interval_s" },
				{ ...request, redactPii: false, hiddenEntries: ["shop.3600"] },
				catalog,
			)
			const error = yield* Effect.flip(prepared)
			expect(error.message).toContain("`shop.3600` names a table")
			const personal = yield* Effect.flip(
				prepareClickHouse(
					connection,
					{ _tag: "sql", sql: "SELECT count() AS n FROM shop.payments WHERE $__timeFilter(email)" },
					request,
					catalog,
				),
			)
			expect(personal.message).toContain("personal data")
			expect(fake.sent).toHaveLength(0)
		}),
	)

	it.effect("takes one unit of the source's budget per query, and sends nothing when it is refused", () =>
		Effect.gen(function* () {
			const fake = fakeFetch(() => rows({ n: "1" }))
			const spent: Array<number> = []
			const prepared = yield* prepareClickHouse(
				connection,
				{ _tag: "sql", sql: "SELECT count() AS n FROM shop.payments" },
				request,
				catalog,
			)
			yield* fake.provide(prepared.run({ spend: (calls) => Effect.sync(() => void spent.push(calls)) }))
			expect(spent).toEqual([1])
			const sentBefore = fake.sent.length
			const refusal = new DataSourceRateLimitedError({ message: "slow down", retryAfterSeconds: 60 })
			const exit = yield* Effect.exit(fake.provide(prepared.run({ spend: () => Effect.fail(refusal) })))
			expect(failureOf(exit)).toContain("slow down")
			expect(fake.sent).toHaveLength(sentBefore)
		}),
	)

	it.effect("refuses a write before anything reaches the server", () => {
		const fake = fakeFetch(() => rows())
		return Effect.exit(fake.provide(run("INSERT INTO shop.payments VALUES (1)"))).pipe(
			Effect.map((exit) => {
				expect(failureOf(exit)).toContain("@maple/data-sources/Validation")
				expect(fake.sent).toHaveLength(0)
			}),
		)
	})

	const profile = (readonly: string) =>
		fakeFetch((sql, url) =>
			url.searchParams.has("readonly")
				? chError(500, 164, "Cannot modify 'readonly' setting in readonly mode. (READONLY)")
				: Str.includes("getSetting('readonly')")(sql)
					? rows({ readonly })
					: rows({ n: 1 }),
		)

	it.effect("retries without settings only once the server confirms a read-only profile", () => {
		const fake = profile("1")
		return fake
			.provide(run("SELECT 1 AS n"))
			.pipe(Effect.map((table) => expect(table.rows).toEqual([{ n: 1 }])))
	})

	it.effect("stops a settings-free retry at Maple's own deadline", () =>
		Effect.gen(function* () {
			// readonly=1: the retry runs without max_execution_time, and this server never answers it.
			const fake = fakeFetch((sql, url) =>
				url.searchParams.has("readonly")
					? chError(500, 164, "Cannot modify 'readonly' setting in readonly mode. (READONLY)")
					: Str.includes("getSetting('readonly')")(sql)
						? rows({ readonly: "1" })
						: new Promise<Response>(() => {}),
			)
			const fiber = yield* Effect.forkChild(Effect.exit(fake.provide(run("SELECT 1 AS n"))))
			yield* TestClock.adjust(Duration.millis(request.limits.timeoutMs + 5_000))
			const exit = yield* Fiber.join(fiber)
			expect(failureOf(exit)).toContain("@maple/data-sources/Timeout")
			expect(failureOf(exit)).toContain(`did not answer within ${request.limits.timeoutMs / 1000}s`)
		}),
	)

	it.effect("keeps the refusal when a writable user provoked it, so readonly cannot be shed", () => {
		const fake = profile("0")
		return Effect.exit(fake.provide(run("SELECT 1 AS n"))).pipe(
			Effect.map((exit) => {
				expect(failureOf(exit)).toContain("Cannot modify 'readonly'")
				expect(
					Arr.filter(
						fake.sent,
						(sent) =>
							!sent.url.searchParams.has("readonly") && !Str.includes("getSetting")(sent.sql),
					),
				).toEqual([])
			}),
		)
	})

	it.effect.each([
		[
			chError(
				500,
				47,
				"Unknown expression identifier `amout` in scope SELECT amout. (UNKNOWN_IDENTIFIER)",
			),
			"@maple/data-sources/Query",
			"Did you mean `amount`?",
		],
		[
			chError(500, 159, "Timeout exceeded: elapsed 31 seconds. (TIMEOUT_EXCEEDED)"),
			"@maple/data-sources/Timeout",
			"Timeout exceeded",
		],
		[
			chError(500, 241, "Memory limit exceeded. (MEMORY_LIMIT_EXCEEDED)"),
			"@maple/data-sources/Limit",
			"Memory limit",
		],
		[
			chError(500, 164, "reader: Cannot execute query in readonly mode. (READONLY)"),
			"@maple/data-sources/Query",
			"readonly mode",
		],
	] as const)("maps ClickHouse code to %#", ([response, tag, text]) => {
		const fake = fakeFetch(() => response.clone())
		return Effect.exit(fake.provide(run("SELECT amout FROM shop.payments"))).pipe(
			Effect.map((exit) => {
				expect(failureOf(exit)).toContain(tag)
				expect(failureOf(exit)).toContain(text)
				expect(failureOf(exit)).not.toContain("(version")
			}),
		)
	})

	it.effect("never puts the password in an error, even when the transport failure carries it", () =>
		Effect.gen(function* () {
			// A runtime can echo the request (headers, a user:pw@ URL) in its error and cause.
			const leaky = fakeFetch(() =>
				Promise.reject(
					new TypeError("fetch failed for https://reader:s3cret-pw@ch.example.com:8443", {
						cause: {
							code: "ECONNRESET",
							authorization: "Basic cmVhZGVyOnMzY3JldC1wdw==",
							password: "s3cret-pw",
						},
					}),
				),
			)
			const exit = failureOf(yield* Effect.exit(leaky.provide(testClickHouse(connection))))
			expect(exit).not.toBe("succeeded")
			expect(exit).not.toContain("s3cret-pw")
			expect(exit).not.toContain("cmVhZGVyOnMzY3JldC1wdw==")
		}),
	)

	it.effect("refuses an alert query that does not bound its reads, before any request", () =>
		Effect.gen(function* () {
			const fake = fakeFetch(() => rows({ n: "1" }))
			const alert: QueryRequest = { ...request, workload: "alert" }
			const runAlert = (sql: string) =>
				Effect.flatMap(
					prepareClickHouse(connection, { _tag: "sql", sql }, alert, catalog),
					(prepared) => prepared.run({ spend: () => Effect.void }),
				)
			const unbounded = yield* Effect.exit(
				fake.provide(runAlert("SELECT count() AS n FROM shop.payments")),
			)
			expect(failureOf(unbounded)).toContain("$__timeFilter")
			expect(fake.sent).toHaveLength(0)
			yield* fake.provide(
				runAlert("SELECT count() AS n FROM shop.payments WHERE $__timeFilter(created_at)"),
			)
			expect(fake.sent.length).toBeGreaterThan(0)
		}),
	)

	it.effect("reports auth and network failures without the password or URL", () =>
		Effect.gen(function* () {
			const auth = fakeFetch(() =>
				chError(
					401,
					516,
					"reader: Authentication failed: password is incorrect. (AUTHENTICATION_FAILED)",
				),
			)
			const authExit = failureOf(yield* Effect.exit(auth.provide(testClickHouse(connection))))
			expect(authExit).toContain('"reason":"auth"')
			const refused = fakeFetch(() =>
				Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })),
			)
			const refusedExit = failureOf(yield* Effect.exit(refused.provide(testClickHouse(connection))))
			expect(refusedExit).toContain('"reason":"refused"')
			expect(refusedExit).toContain("ch.example.com:8443 refused the connection")
			for (const text of [authExit, refusedExit]) expect(text).not.toContain("s3cret-pw")
		}),
	)

	it.effect("warns when the user can write and not when it is read-only", () =>
		Effect.gen(function* () {
			const answer = (readonly: string) => (sql: string) =>
				Str.includes("getSetting")(sql)
					? rows({ readonly })
					: Str.startsWith("SHOW GRANTS")(sql)
						? rows({ g: "GRANT SELECT, INSERT ON shop.* TO writer" })
						: rows({ "1": 1 })
			const writer = yield* fakeFetch(answer("0")).provide(testClickHouse(connection))
			expect(writer.warnings).toEqual([
				"This user can write (INSERT on shop.*). Maple only reads, but a read-only user is safer.",
			])
			const readOnlyProfile = yield* fakeFetch(answer("1")).provide(testClickHouse(connection))
			expect(readOnlyProfile.warnings).toEqual([READ_ONLY_PROFILE])
			const reader = yield* fakeFetch((sql) =>
				Str.startsWith("SHOW GRANTS")(sql)
					? rows({ g: "GRANT SELECT ON shop.* TO reader" })
					: answer("0")(sql),
			).provide(testClickHouse(connection))
			expect(reader.warnings).toEqual([])
		}),
	)

	it.effect("keeps Maple's limits for a readonly=2 profile and does not warn about it", () =>
		Effect.gen(function* () {
			// readonly=2 refuses only a change to `readonly` itself, like ClickHouse does.
			const fake = fakeFetch((sql, url) =>
				url.searchParams.has("readonly")
					? chError(
							500,
							164,
							"Code: 164. DB::Exception: Cannot modify 'readonly' setting in readonly mode. (READONLY)",
						)
					: Str.includes("getSetting")(sql)
						? rows({ readonly: "2" })
						: rows({ n: "1" }),
			)
			yield* fake.provide(run("SELECT count() AS n FROM shop.payments WHERE $__timeFilter(created_at)"))
			const retried = Arr.findLast(fake.sent, (sent) => !Str.includes("getSetting")(sent.sql))
			const params = Option.map(retried, (sent) => sent.url.searchParams)
			expect(Option.map(params, (p) => [p.has("readonly"), p.get("max_execution_time")])).toEqual(
				Option.some([false, "30"]),
			)
			const test = yield* fake.provide(testClickHouse(connection))
			expect(test.warnings).toEqual([])
		}),
	)

	it.effect("warns that a plain http URL sends the password unencrypted", () =>
		Effect.gen(function* () {
			const plain = {
				...connection,
				config: { ...connection.config, url: "http://ch.example.com:8123" },
			}
			const result = yield* fakeFetch((sql) =>
				Str.includes("getSetting")(sql)
					? rows({ readonly: "0" })
					: Str.startsWith("SHOW GRANTS")(sql)
						? rows({ g: "GRANT SELECT ON shop.* TO reader" })
						: rows({ "1": 1 }),
			).provide(testClickHouse(plain))
			expect(result.warnings).toEqual([PLAIN_HTTP])
		}),
	)
})
