import assert from "node:assert/strict"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import type * as CH from "@maple-dev/clickhouse-builder"

// Opt in with CLICKHOUSE_BUILDER_TEST_URL, plus _USER and _PASSWORD if needed.
// All fixtures are SELECTs/CTEs; this suite creates no tables and writes no data.
export const endpoint = process.env.CLICKHOUSE_BUILDER_TEST_URL
const user = process.env.CLICKHOUSE_BUILDER_TEST_USER ?? "default"
const password = process.env.CLICKHOUSE_BUILDER_TEST_PASSWORD ?? ""

const WireRow = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeWireRow = Schema.decodeUnknownEffect(WireRow)
const decodeJson = Schema.decodeUnknownEffect(
	Schema.fromJsonString(
		Schema.Struct({
			data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
		}),
	),
)

/** POST the compiled SQL and decode the JSONEachRow reply through the query's own codec. */
export const execute = Effect.fn("execute")(function* <Output>(
	compiled: CH.CompiledQuery<Output>,
	settings: Record<string, string> = {},
	format: "JSONEachRow" | "JSON" = "JSONEachRow",
) {
	const client = yield* HttpClient.HttpClient
	const request = HttpClientRequest.post(endpoint!).pipe(
		HttpClientRequest.setUrlParams({
			default_format: "JSONEachRow",
			session_timezone: "UTC",
			...settings,
		}),
		HttpClientRequest.setHeaders({
			"X-ClickHouse-User": user,
			"X-ClickHouse-Key": password,
		}),
		HttpClientRequest.bodyText(compiled.sql),
	)
	const { response, text } = yield* Effect.gen(function* () {
		const response = yield* client.execute(request)
		return { response, text: yield* response.text }
	}).pipe(Effect.timeout("10 seconds"))
	assert.ok(
		response.status >= 200 && response.status < 300,
		`${compiled.sql}\nHTTP ${response.status}: ${text}`,
	)
	const wire =
		format === "JSON"
			? (yield* decodeJson(text)).data
			: yield* Effect.forEach(text.trim().split("\n").filter(Boolean), (line) => decodeWireRow(line))
	const rows = yield* compiled.decodeRows(wire)
	return { wire, rows }
})
