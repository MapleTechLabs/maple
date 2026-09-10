import { assert, describe, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { make, ClickHouseServerError, ClickHouseLimitError } from "./index"

const enabled = process.env.CLICKHOUSE_HTTP_LIVE === "1"
const url = process.env.CLICKHOUSE_HTTP_URL ?? "http://127.0.0.1:8123"
const username = process.env.CLICKHOUSE_HTTP_USER ?? "maple"
const password = process.env.CLICKHOUSE_HTTP_PASSWORD ?? "maple"
const settings = { output_format_json_quote_64bit_integers: 0 } as const
const native = make({ url, username, password: Redacted.make(password), settings })
const run = <A, E>(f: (client: Effect.Success<typeof native>) => Effect.Effect<A, E>) =>
	Effect.flatMap(native, f).pipe(Effect.provide(FetchHttpClient.layer))

// Explicitly opt-in. No schemas, tables, or records are created or modified.
// Expected rows are the JSONEachRow wire shapes a real server produces with
// 64-bit integers unquoted: UInt64 as a JS number, Map as an object, Tuple as
// an array, Date as its ISO day. Literals rather than another client's output,
// so a drift in this decoder is caught even if a reference SDK drifted the same way.
describe.skipIf(!enabled)("real ClickHouse HTTP wire format", () => {
	const cases: ReadonlyArray<readonly [sql: string, expected: ReadonlyArray<Record<string, unknown>>]> = [
		["SELECT number FROM numbers(1000)", Array.from({ length: 1000 }, (_, number) => ({ number }))],
		[
			"SELECT 'héllo 🦊 東京' AS unicode, 'a\\nb' AS newline, [1,2,3] AS values, NULL AS nullable",
			[{ unicode: "héllo 🦊 東京", newline: "a\nb", values: [1, 2, 3], nullable: null }],
		],
		[
			"SELECT toString(toUInt64('18446744073709551615')) AS id, toUInt64(42) AS count",
			[{ id: "18446744073709551615", count: 42 }],
		],
		["SELECT number FROM numbers(0)", []],
		[
			"SELECT map('a',1,'b',2) AS m, tuple(1,'x') AS t, toDate('2026-01-01') AS d",
			[{ m: { a: 1, b: 2 }, t: [1, "x"], d: "2026-01-01" }],
		],
		["SELECT 1 AS n -- comment at EOF", [{ n: 1 }]],
	]
	for (const [sql, expected] of cases)
		it.effect(`decodes ${sql}`, () =>
			run((client) =>
				Effect.gen(function* () {
					const actual = yield* client.query({ sql })
					assert.deepStrictEqual(actual.data, expected)
					assert.isNotEmpty(actual.queryId)
				}),
			),
		)

	it.effect("preserves a real SQL error's identity", () =>
		run((client) =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(
					client.query({ sql: "SELECT missing_column FROM system.one" }),
				)
				assert.instanceOf(error, ClickHouseServerError)
				if (error instanceof ClickHouseServerError) {
					assert.strictEqual(error.code, "47")
					assert.strictEqual(error.type, "UNKNOWN_IDENTIFIER")
				}
			}),
		),
	)
	it.effect("handles an exception after streamed HTTP 200 rows", () =>
		run((client) =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(
					client.query({
						sql: "SELECT sleepEachRow(0.01), throwIf(number = 2) FROM numbers(5)",
						settings: {
							max_threads: 1,
							max_block_size: 1,
							http_response_buffer_size: 1,
							http_wait_end_of_query: 0,
						},
					}),
				)
				assert.instanceOf(error, ClickHouseServerError)
				if (error instanceof ClickHouseServerError) {
					assert.strictEqual(error.code, "395")
					assert.strictEqual(error.status, 200)
				}
			}),
		).pipe(
			Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
				// Compression buffers this small result until the exception. Force plain
				// streaming for this case so HTTP 200 precedes the server failure.
				const headers = new Headers(init?.headers)
				headers.set("accept-encoding", "identity")
				return fetch(input, { ...init, headers })
			}),
		),
	)
	it.effect("applies byte limits to a real large row", () =>
		run((client) =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(
					client.query({ sql: "SELECT repeat('x', 100000) AS payload", limits: { maxBytes: 100 } }),
				)
				assert.instanceOf(error, ClickHouseLimitError)
			}),
		),
	)
})
