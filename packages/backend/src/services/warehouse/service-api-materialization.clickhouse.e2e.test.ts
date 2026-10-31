// SAFETY-FILE: JSON in this test is emitted by ClickHouse before its fields are asserted.
// HTTP server spans on the real migration chain must land in migration 0048's measures and
// in `service_endpoint_details_hourly`, its backfill must rebuild what the view wrote, and the
// service API tab's queries must read them back: Server spans only, raw edge and rollup alike.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { isBackfill, migrations, renderStatementFull } from "@maple/domain/clickhouse"
import * as CH from "@maple/query-engine/ch"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_service_api_e2e")
const ORG_ID = "org_service_api_e2e"

const MINUTE = 60_000
const HOUR = 3_600_000
// Anchored to now: `traces` carries a 30-day TTL enforced at insert.
const T0 = Math.floor((Date.now() - 3 * HOUR) / MINUTE) * MINUTE
const WINDOW_START = T0 + 30_000
// Two whole hours after the window's first hour: read from the hourly tier.
const INTERIOR = Math.floor(T0 / HOUR) * HOUR + 2 * HOUR + 10 * MINUTE
const chDateTime = (epochMs: number): string => new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)
const chDateTime64 = (epochMs: number): string =>
	new Date(epochMs).toISOString().replace("T", " ").slice(0, 23)

interface SeedSpan {
	readonly traceId: string
	readonly at: number
	readonly kind?: string
	readonly name?: string
	readonly durationMs: number
	readonly attributes: Record<string, string>
}

const server = (
	traceId: string,
	offsetSeconds: number,
	status: string,
	durationMs: number,
	extra: Record<string, string> = {},
): SeedSpan => ({
	traceId,
	at: INTERIOR + offsetSeconds * 1000,
	durationMs,
	attributes: { "http.route": "/orders", "http.response.status_code": status, ...extra },
})

const SPANS: ReadonlyArray<SeedSpan> = [
	server("t200a", 1, "200", 10, { "http.request.body.size": "100", "user_agent.original": "curl/8" }),
	server("t200b", 2, "200", 20, { "http.request.body.size": "300", "user_agent.original": "curl/8" }),
	server("t402", 3, "402", 12, { "error.type": "PaymentRequired", "user_agent.original": "Mozilla" }),
	// Legacy attribute spellings: `http.status_code` and `http.user_agent`.
	{
		traceId: "t401",
		at: INTERIOR + 4000,
		durationMs: 15,
		attributes: { "http.route": "/orders", "http.status_code": "401", "http.user_agent": "Mozilla" },
	},
	server("t503", 5, "503", 900, { "error.type": "UpstreamTimeout", "http.request.body.size": "50" }),
	// An outbound call normalizes to the same name; its status is not this endpoint's.
	{
		traceId: "tclient",
		at: INTERIOR + 6000,
		kind: "Client",
		name: "GET",
		durationMs: 5,
		attributes: { "url.path": "/orders", "http.response.status_code": "500" },
	},
	// Inside the window's partial first minute: only the raw edge can count it.
	{
		traceId: "tedge",
		at: T0 + 40_000,
		durationMs: 30,
		attributes: { "http.route": "/orders", "http.response.status_code": "500" },
	},
]

const insert = (spans: ReadonlyArray<SeedSpan>) =>
	clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, StatusMessage, SampleRate, SpanAttributes, ResourceAttributes)
		 VALUES\n${spans
				.map((span) => {
					const attributes = Object.entries(span.attributes)
						.map(([key, value]) => `'${key}', '${value}'`)
						.join(", ")
					return `('${ORG_ID}', '${chDateTime64(span.at)}', '${span.traceId}', 's-${span.traceId}', '', '${span.name ?? "http.server GET"}', '${span.kind ?? "Server"}', 'api', ${span.durationMs * 1_000_000}, 'Unset', '', 1, map(${attributes}), map('service.name', 'api'))`
				})
				.join("\n,")}`,
		database,
	)

const runJson = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	const body = await clickhouseExec(`${sql} FORMAT JSON`, database, {
		output_format_json_quote_64bit_integers: "0",
	})
	return (JSON.parse(body) as { readonly data?: ReadonlyArray<Record<string, unknown>> }).data ?? []
}

const window = {
	orgId: ORG_ID,
	startTime: chDateTime(WINDOW_START),
	endTime: chDateTime(Date.now()),
}
const read = (query: Parameters<typeof CH.compileUnsafe>[0], params: Record<string, unknown> = window) =>
	runJson(CH.compileUnsafe(query, params).sql.replace(/\s*FORMAT JSON\s*$/, ""))

const pick = (row: Record<string, unknown> | undefined, keys: ReadonlyArray<string>) =>
	Object.fromEntries(keys.map((key) => [key, row?.[key]]))

const HTTP_KEYS = [
	"spanCount",
	"httpClassifiedSpanCount",
	"httpStatusCount",
	"http4xxCount",
	"http5xxCount",
	"requestBodyBytes",
	"requestBodyCount",
]

const detailsRows = () =>
	runJson(
		`SELECT SpanName, HttpStatusCode, ErrorType, sum(SpanCount) AS spans, sum(BodyCount) AS bodies,
		        max(BodySizeMax) AS maxBody, argMaxMerge(SlowestTraceId) AS slowest,
		        argMaxMerge(SlowestBodySize) AS slowestBody
		 FROM service_endpoint_details_hourly WHERE OrgId = '${ORG_ID}'
		 GROUP BY SpanName, HttpStatusCode, ErrorType ORDER BY HttpStatusCode`,
	)

describe.skipIf(!clickhouseE2eEnabled)("service API tab: migration 0048 rollups and reads", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await insert(SPANS)
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("rolls up server spans per status code and error.type", async () => {
		assert.deepStrictEqual(await detailsRows(), [
			{
				SpanName: "GET /orders",
				HttpStatusCode: "200",
				ErrorType: "",
				spans: 2,
				bodies: 2,
				maxBody: 300,
				slowest: "t200b",
				slowestBody: 300,
			},
			{
				SpanName: "GET /orders",
				HttpStatusCode: "401",
				ErrorType: "",
				spans: 1,
				bodies: 0,
				maxBody: 0,
				slowest: "t401",
				slowestBody: -1,
			},
			{
				SpanName: "GET /orders",
				HttpStatusCode: "402",
				ErrorType: "PaymentRequired",
				spans: 1,
				bodies: 0,
				maxBody: 0,
				slowest: "t402",
				slowestBody: -1,
			},
			{
				SpanName: "GET /orders",
				HttpStatusCode: "500",
				ErrorType: "",
				spans: 1,
				bodies: 0,
				maxBody: 0,
				slowest: "tedge",
				slowestBody: -1,
			},
			{
				SpanName: "GET /orders",
				HttpStatusCode: "503",
				ErrorType: "UpstreamTimeout",
				spans: 1,
				bodies: 1,
				maxBody: 50,
				slowest: "t503",
				slowestBody: 50,
			},
		])
	})

	it("rebuilds the same rollup from the migration's backfill", async () => {
		const before = await detailsRows()
		const backfill = migrations
			.filter((migration) => migration.version === 48)
			.flatMap((migration) => migration.statements.filter(isBackfill))
		assert.strictEqual(backfill.length, 1)
		await clickhouseExec("TRUNCATE TABLE service_endpoint_details_hourly", database)
		for (const statement of backfill)
			await clickhouseExec(renderStatementFull(statement, database), database)
		assert.deepStrictEqual(await detailsRows(), before)
	})

	it("counts HTTP measures on server spans only, raw edge included", async () => {
		const [totals] = await read(CH.serviceApiTotalsQuery({ serviceName: "api" }))
		assert.deepStrictEqual(pick(totals, HTTP_KEYS), {
			spanCount: 7,
			httpClassifiedSpanCount: 7,
			httpStatusCount: 6,
			http4xxCount: 2,
			http5xxCount: 2,
			requestBodyBytes: 450,
			requestBodyCount: 3,
		})
		const [raw] = await read(CH.serviceApiTotalsQuery({ serviceName: "api", tiers: "raw" }))
		assert.deepStrictEqual(pick(raw, HTTP_KEYS), pick(totals, HTTP_KEYS))
		assert.isAbove(Number(totals?.p99DurationMs), 100)
	})

	it("carries the measures on the per-endpoint rows", async () => {
		const rows = await read(CH.serviceEndpointsSummaryQuery({ serviceName: "api" }))
		assert.strictEqual(rows.length, 1)
		assert.deepStrictEqual(pick(rows[0], ["spanName", ...HTTP_KEYS]), {
			spanName: "GET /orders",
			spanCount: 7,
			httpClassifiedSpanCount: 7,
			httpStatusCount: 6,
			http4xxCount: 2,
			http5xxCount: 2,
			requestBodyBytes: 450,
			requestBodyCount: 3,
		})
	})

	it("buckets the merged and the per-endpoint series alike", async () => {
		const keys = ["spanName", "httpStatusCount", "http4xxCount", "http5xxCount", "requestBodyBytes"]
		const params = { ...window, bucketSeconds: 3600 }
		const merged = await read(
			CH.serviceApiTimeseriesQuery({ serviceName: "api", bucketSeconds: 3600 }),
			params,
		)
		const perEndpoint = await read(
			CH.serviceApiTimeseriesQuery({
				serviceName: "api",
				bucketSeconds: 3600,
				spanNames: ["GET /orders"],
			}),
			params,
		)
		const interiorBucket = chDateTime(Math.floor(INTERIOR / HOUR) * HOUR)
		const at = (rows: ReadonlyArray<Record<string, unknown>>) =>
			pick(
				rows.find((row) => row.bucket === interiorBucket),
				keys,
			)
		assert.deepStrictEqual(at(merged), {
			spanName: "",
			httpStatusCount: 5,
			http4xxCount: 2,
			http5xxCount: 1,
			requestBodyBytes: 450,
		})
		assert.deepStrictEqual(at(perEndpoint), { ...at(merged), spanName: "GET /orders" })
	})

	it("breaks the endpoint down by status code and error.type", async () => {
		const rows = await read(
			CH.serviceEndpointStatusBreakdownQuery({ serviceName: "api", spanName: "GET /orders" }),
		)
		assert.deepStrictEqual(
			rows.map((row) => [row.httpStatusCode, row.errorType, row.spanCount]),
			[
				["200", "", 2],
				["401", "", 1],
				["402", "PaymentRequired", 1],
				["500", "", 1],
				["503", "UpstreamTimeout", 1],
			],
		)
	})

	it("reads the distributions, user agents and slowest requests", async () => {
		const [distribution] = await read(
			CH.serviceEndpointDistributionQuery({ serviceName: "api", spanName: "GET /orders" }),
		)
		assert.strictEqual(distribution?.spanCount, 6)
		assert.strictEqual(distribution?.bodyCount, 3)
		assert.strictEqual(distribution?.bodyMaxBytes, 300)
		const levels = distribution?.latencyQuantilesMs
		assert.strictEqual(
			Array.isArray(levels) ? levels.length : -1,
			CH.ENDPOINT_LATENCY_QUANTILE_LEVELS.length,
		)
		const agents = distribution?.userAgents
		assert.deepStrictEqual(Array.isArray(agents) ? agents.toSorted() : agents, ["Mozilla", "curl/8"])
		assert.deepStrictEqual(distribution?.userAgentCounts, [2, 2])

		const slowest = await read(
			CH.serviceEndpointSlowestQuery({ serviceName: "api", spanName: "GET /orders" }),
		)
		assert.deepStrictEqual(
			slowest
				.slice(0, 2)
				.map((row) => [row.traceId, row.httpStatusCode, row.durationMs, row.bodyBytes]),
			[
				["t503", "503", 900, 50],
				["tedge", "500", 30, -1],
			],
		)
		assert.strictEqual(slowest[0]?.timestamp, chDateTime64(INTERIOR + 5000))
	})
})
