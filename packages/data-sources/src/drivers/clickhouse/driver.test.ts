import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Effect, Exit, String as Str } from "effect"
import type { SourceCatalog } from "@maple/domain/data-sources"
import { DEFAULT_LIMITS } from "../../limits"
import type { QueryRequest } from "../../port"
import { chError, connection, fakeFetch, rows } from "./fake-fetch"
import { prepareClickHouse } from "./run"
import { testClickHouse } from "./test-connection"

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
}
const run = (sql: string) =>
	Effect.flatMap(prepareClickHouse(connection, { _tag: "sql", sql }, request, catalog), (prepared) =>
		prepared.run({ spend: () => Effect.void }),
	)
const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
	Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "succeeded"

describe("ClickHouse driver over HTTP", () => {
	it.effect("returns columns in SELECT order, safe numbers, truncation and PII redaction", () => {
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
		return fake
			.provide(run("SELECT big, n, email FROM shop.payments WHERE $__timeFilter(created_at)"))
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
	})

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
			const reader = yield* fakeFetch(answer("1")).provide(testClickHouse(connection))
			expect(reader.warnings).toEqual([])
		}),
	)
})
