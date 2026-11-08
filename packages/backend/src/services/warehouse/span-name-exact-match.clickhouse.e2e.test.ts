// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// An exact span-name filter matches the stored name or its HTTP display form
// (`http.server GET` + route reads `GET /users`). The filter now prunes on the
// stored name first, so every spelling must still select the same spans.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Effect, Array as Arr, String as Str } from "effect"
import { OrgId } from "@maple/domain"
import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_span_name_exact_e2e")
const ORG_ID = OrgId.make("org_span_name_exact")
const HOUR_MS = 3_600_000

const chDateTime = (epochMs: number): string =>
	Str.slice(0, 19)(Str.replace("T", " ")(new Date(epochMs).toISOString()))

// Anchored to now: `traces` enforces a TTL at insert time.
const SEED_MS = Date.now() - 2 * HOUR_MS
const window = {
	orgId: ORG_ID,
	startTime: chDateTime(SEED_MS - HOUR_MS),
	endTime: chDateTime(SEED_MS + HOUR_MS),
}

interface SeedSpan {
	readonly spanId: string
	readonly name: string
	readonly route?: string
	readonly path?: string
}

const SEED: ReadonlyArray<SeedSpan> = [
	{ spanId: "plain", name: "posthog" },
	{ spanId: "server-route", name: "http.server GET", route: "/users" },
	{ spanId: "bare-method-path", name: "GET", path: "/orders" },
	{ spanId: "literal-display", name: "GET /users" },
	{ spanId: "server-no-route", name: "http.server POST" },
	{ spanId: "spaced-plain", name: "a b" },
	{ spanId: "spaced-server-route", name: "http.server a b", route: "/x" },
]

const quote = (value: string): string => `'${Str.replace(/[\\']/g, "\\$&")(value)}'`

const attributes = (span: SeedSpan): string => {
	const pairs = [
		...(span.route === undefined ? [] : [`'http.route', ${quote(span.route)}`]),
		...(span.path === undefined ? [] : [`'url.path', ${quote(span.path)}`]),
	]
	return pairs.length === 0 ? "map()" : `map(${Arr.join(pairs, ", ")})`
}

const runJson = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	const body = await clickhouseExec(normalizeSqlForClickHouseClient(sql), database, {
		default_format: "JSON",
		output_format_json_quote_64bit_integers: "0",
	})
	const parsed = JSON.parse(body) as { readonly data?: ReadonlyArray<Record<string, unknown>> }
	return parsed.data ?? []
}

const matchedSpanIds = async (spanName: string): Promise<ReadonlyArray<string>> => {
	const { sql } = Effect.runSync(CH.compile(CH.spanSearchQuery({ spanName, limit: 100 }), window))
	const rows = await runJson(sql)
	return Arr.sort(
		Arr.map(rows, (row) => String(row.spanId)),
		Str.Order,
	)
}

describe.skipIf(!clickhouseE2eEnabled)("exact span-name filter", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		const rows = Arr.join(
			Arr.map(
				SEED,
				(span, i) =>
					`(${quote(ORG_ID)}, ${quote(chDateTime(SEED_MS + i * 1000))}, 'trace-1', ${quote(span.spanId)}, '', ${quote(span.name)}, 'Server', 'api', 1000000, 'Ok', 1, '', ${attributes(span)}, map())`,
			),
			",\n",
		)
		await clickhouseExec(
			`INSERT INTO traces
			 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, SampleRate, TraceState, SpanAttributes, ResourceAttributes)
			 VALUES\n${rows}`,
			database,
		)
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it.each([
		["a name without spaces", "posthog", ["plain"]],
		["a display name from a route", "GET /users", ["literal-display", "server-route"]],
		["a display name from a url.path", "GET /orders", ["bare-method-path"]],
		["a raw HTTP name", "http.server GET", ["server-route"]],
		["a raw HTTP name with no route", "http.server POST", ["server-no-route"]],
		["a plain name with a space", "a b", ["spaced-plain"]],
		["a display name whose method part has a space", "a b /x", ["spaced-server-route"]],
		["a name nothing carries", "missing", []],
	])("selects %s", async (_, spanName, expected) => {
		assert.deepStrictEqual(await matchedSpanIds(spanName), expected)
	})
})
