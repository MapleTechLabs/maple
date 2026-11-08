import { beforeAll, describe, expect, it } from "@effect/vitest"
import { Array as Arr, Effect, Exit, Option, Redacted } from "effect"
import { Base64 } from "effect/encoding"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { DEFAULT_LIMITS } from "../../limits"
import { clickHouseDriver } from "./index"
import { connection as baseConnection } from "./fake-fetch"
import { openSession, readOnlySettings } from "./session"
import { PLAIN_HTTP, READ_ONLY_PROFILE } from "./test-connection"

// Opt-in: DATA_SOURCES_CH_LIVE=1 against a disposable server (see the driver PR for the docker
// command). Setup creates `shop.payments` and three users as the admin. The driver sees the public
// name `ch-live.example.com`; the fetch below dials the local server, so URL checks still run.
const enabled = process.env.DATA_SOURCES_CH_LIVE === "1"
const target = new URL(process.env.DATA_SOURCES_CH_URL ?? "http://127.0.0.1:18723")
const admin = {
	user: process.env.DATA_SOURCES_CH_ADMIN ?? "admin",
	password: process.env.DATA_SOURCES_CH_ADMIN_PASSWORD ?? "adminpw",
}

const dial: typeof globalThis.fetch = (input, init) => {
	const url = new URL(input instanceof Request ? input.url : input)
	url.protocol = target.protocol
	url.host = target.host
	return globalThis.fetch(url, init)
}
// Each test is its own entry point, so each provides the HTTP client.
const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	// @effect-diagnostics-next-line strictEffectProvide:off
	effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, dial))
const as = (user: string, password: string) => ({
	...baseConnection,
	config: { ...baseConnection.config, url: "http://ch-live.example.com/", user, database: "shop" },
	secret: Redacted.make(password),
})
const reader = as("reader", "readerpw")
const writer = as("writer", "writerpw")
const roProfile = as("roprofile", "ropw")
const now = Date.now()
const request = {
	window: { startMs: now - 86_400_000, endMs: now + 60_000, granularitySeconds: 3600 },
	limits: DEFAULT_LIMITS.interactive,
	workload: "interactive" as const,
	redactPii: false,
}
const context = { spend: () => Effect.void }

const SETUP = [
	"CREATE DATABASE IF NOT EXISTS shop",
	"DROP TABLE IF EXISTS shop.payments",
	"CREATE TABLE shop.payments (id UInt64 COMMENT 'payment id', created_at DateTime COMMENT 'when paid', status Enum8('pending' = 1, 'paid' = 2, 'refunded' = 3), amount Decimal(12, 2), customer_email String, big UInt64) ENGINE = MergeTree ORDER BY (status, created_at) COMMENT 'Card payments'",
	"INSERT INTO shop.payments SELECT number, now() - number * 600, (number % 3) + 1, number * 1.5, concat('u', toString(number), '@x.com'), 18446744073709551615 - number FROM numbers(500)",
	"CREATE USER IF NOT EXISTS reader IDENTIFIED BY 'readerpw'",
	"GRANT SELECT ON shop.* TO reader",
	"CREATE USER IF NOT EXISTS writer IDENTIFIED BY 'writerpw'",
	"GRANT SELECT, INSERT ON shop.* TO writer",
	"CREATE USER IF NOT EXISTS roprofile IDENTIFIED BY 'ropw' SETTINGS readonly = 1",
	"GRANT SELECT ON shop.* TO roprofile",
]

describe.skipIf(!enabled)("ClickHouse driver against a real server", () => {
	beforeAll(() =>
		Effect.runPromise(
			Effect.flatMap(Effect.service(HttpClient.HttpClient), (http) =>
				Effect.forEach(
					SETUP,
					(sql) =>
						http
							.execute(
								HttpClientRequest.post(target).pipe(
									HttpClientRequest.setHeader(
										"authorization",
										`Basic ${Base64.encode(`${admin.user}:${admin.password}`)}`,
									),
									HttpClientRequest.bodyText(sql),
								),
							)
							.pipe(
								Effect.flatMap((response) =>
									response.status === 200
										? Effect.void
										: Effect.flatMap(response.text, (text) => Effect.die(text)),
								),
							),
					{ discard: true },
				),
			).pipe(Effect.provide(FetchHttpClient.layer)),
		),
	)

	it.effect("test warns for the writer and not for the reader", () =>
		live(
			Effect.gen(function* () {
				expect((yield* clickHouseDriver.test(writer, context)).warnings).toEqual([
					PLAIN_HTTP,
					"This user can write (INSERT on shop.*). Maple only reads, but a read-only user is safer.",
				])
				expect((yield* clickHouseDriver.test(reader, context)).warnings).toEqual([PLAIN_HTTP])
				expect((yield* clickHouseDriver.test(roProfile, context)).warnings).toEqual([
					PLAIN_HTTP,
					READ_ONLY_PROFILE,
				])
			}),
		),
	)

	it.effect("catalog lists the table with its time field, enum samples and examples", () =>
		live(
			Effect.gen(function* () {
				const catalog = yield* clickHouseDriver.catalog(reader, context)
				const payments = Option.getOrUndefined(
					Arr.findFirst(catalog.entries, (entry) => entry.name === "shop.payments"),
				)
				expect(payments).toMatchObject({
					kind: "table",
					rowEstimate: 500,
					note: "Card payments",
					timeField: "created_at",
				})
				expect(
					Option.getOrUndefined(
						Arr.findFirst(payments?.fields ?? [], (field) => field.name === "status"),
					),
				).toEqual({
					name: "status",
					type: "string",
					nativeType: "Enum8('pending' = 1, 'paid' = 2, 'refunded' = 3)",
					sampleValues: ["pending", "paid", "refunded"],
				})
				expect(catalog.examples[0]?.query).toMatchObject({
					sql: expect.stringContaining("$__timeGroup(created_at)"),
				})
				yield* Effect.log(
					"catalog",
					JSON.stringify({ entries: catalog.entries, examples: catalog.examples }),
				)
			}),
		),
	)

	it.effect("a $__timeGroup count returns hourly buckets", () =>
		live(
			Effect.gen(function* () {
				const sql =
					"SELECT $__timeGroup(created_at) AS time, count() AS n, sum(big) AS big FROM shop.payments WHERE $__timeFilter(created_at) GROUP BY time ORDER BY time"
				const prepared = yield* clickHouseDriver.prepare(reader, { _tag: "sql", sql }, request, {
					entries: [],
					examples: [],
					truncated: false,
				})
				const table = yield* prepared.run(context)
				yield* Effect.log(
					"buckets",
					JSON.stringify({
						columns: table.columns,
						first: table.rows.slice(0, 3),
						count: table.rows.length,
					}),
				)
				expect(Arr.map(table.columns, (column) => column.name)).toEqual(["time", "n", "big"])
				expect(table.rows.length).toBeGreaterThanOrEqual(20)
				expect(typeof table.rows[0]?.n).toBe("number")
				// A read-only profile refuses our settings, so the query runs without them: same buckets,
				// but 64-bit values come back unquoted (and rounded) on such a server.
				const viaProfile = yield* Effect.flatMap(
					clickHouseDriver.prepare(roProfile, { _tag: "sql", sql }, request, {
						entries: [],
						examples: [],
						truncated: false,
					}),
					(p) => p.run(context),
				)
				const counts = (rows: typeof table.rows) => Arr.map(rows, (row) => [row["time"], row["n"]])
				expect(counts(viaProfile.rows)).toEqual(counts(table.rows))
			}),
		),
	)

	it.effect("keeps 64-bit integers exact: numbers when safe, strings when not", () =>
		live(
			Effect.gen(function* () {
				const sql =
					"SELECT toUInt64(18446744073709551615) AS huge, toUInt64(42) AS small, toDecimal64(12.5, 2) AS dec"
				const prepared = yield* clickHouseDriver.prepare(reader, { _tag: "sql", sql }, request, {
					entries: [],
					examples: [],
					truncated: false,
				})
				const table = yield* prepared.run(context)
				expect(table.rows).toEqual([{ huge: "18446744073709551615", small: 42, dec: 12.5 }])
			}),
		),
	)

	it.effect("refuses writes in the text check and, past it, on the server", () =>
		live(
			Effect.gen(function* () {
				const refused = yield* Effect.exit(
					clickHouseDriver.prepare(
						writer,
						{ _tag: "sql", sql: "INSERT INTO shop.payments (id) VALUES (1)" },
						request,
						{ entries: [], examples: [], truncated: false },
					),
				)
				expect(Exit.isFailure(refused) && JSON.stringify(refused.cause)).toContain(
					"'INSERT' is not allowed",
				)
				const session = yield* openSession(writer)
				const settings = readOnlySettings(DEFAULT_LIMITS.interactive)
				const insert = yield* Effect.flip(
					session.rows("INSERT INTO shop.payments (id) VALUES (1)", {
						take: 1,
						maxBytes: 1000,
						settings,
					}),
				)
				const override = yield* Effect.flip(
					session.rows("SELECT 1 SETTINGS readonly = 0", { take: 1, maxBytes: 1000, settings }),
				)
				yield* Effect.log("server refusals", insert.message, "|", override.message)
				expect(insert.message).toContain("Cannot execute query in readonly mode")
				expect(override.message).toContain("Cannot modify 'readonly' setting in readonly mode")
			}),
		),
	)

	it.effect("passes ClickHouse's own message with a did-you-mean from the catalog", () =>
		live(
			Effect.gen(function* () {
				const catalog = yield* clickHouseDriver.catalog(reader, context)
				const prepared = yield* clickHouseDriver.prepare(
					reader,
					{ _tag: "sql", sql: "SELECT amout FROM shop.payments" },
					request,
					catalog,
				)
				const error = yield* Effect.flip(prepared.run(context))
				yield* Effect.log("unknown column", error.message)
				expect(error.message).toContain("Did you mean `amount`?")
			}),
		),
	)
})
