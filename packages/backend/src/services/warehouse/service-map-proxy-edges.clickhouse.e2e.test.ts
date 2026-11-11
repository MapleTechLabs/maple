// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// Vercel's edge request span (`vercel.edge-network`, Server) is the direct parent of the project's
// `Invoke Function` span (Server), with no Client span between. The map draws that hop as an edge
// in the live join and the rollup alike; an ordinary Server→Server parent stays no edge.

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
} from "../../testing/clickhouse-e2e-support"

const database = uniqueDatabase("maple_service_map_proxy_e2e")
const ORG_ID = OrgId.make("org_service_map_proxy")
const EDGE = "vercel.edge-network"

// Anchored to now: `traces` and the service-map span tables enforce a TTL at insert time.
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

const chDateTime = (epochMs: number): string =>
	Str.slice(0, 19)(Str.replace("T", " ")(new Date(epochMs).toISOString()))

const BASE_MS = Math.floor((Date.now() - 3 * DAY_MS) / DAY_MS) * DAY_MS
// One partial hour, one sealed hour, one partial hour.
const START_MS = BASE_MS + 10 * HOUR_MS + 30 * MINUTE_MS
const SEALED_HOUR_MS = BASE_MS + 11 * HOUR_MS
const END_MS = BASE_MS + 12 * HOUR_MS + 30 * MINUTE_MS
const window = { orgId: ORG_ID, startTime: chDateTime(START_MS), endTime: chDateTime(END_MS) }

const CALL_TIMES = [START_MS + 5 * MINUTE_MS, SEALED_HOUR_MS + 10 * MINUTE_MS, END_MS - 5 * MINUTE_MS]

interface SeedSpan {
	readonly ms: number
	readonly service: string
	readonly name: string
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string
}

/** An edge request with its routing child and the function it invokes; a plain Server→Server pair. */
const request = (ms: number, index: number): ReadonlyArray<SeedSpan> => {
	const traceId = `trace-${index}`
	return [
		{ ms, service: EDGE, name: "GET /api", traceId, spanId: `edge-${index}`, parentSpanId: "" },
		{
			ms,
			service: EDGE,
			name: "Resolve Route",
			traceId,
			spanId: `route-${index}`,
			parentSpanId: `edge-${index}`,
		},
		{
			ms,
			service: "storefront",
			name: "Invoke Function",
			traceId,
			spanId: `invoke-${index}`,
			parentSpanId: `edge-${index}`,
		},
		{
			ms,
			service: "gateway",
			name: "GET /",
			traceId: `other-${index}`,
			spanId: `gw-${index}`,
			parentSpanId: "",
		},
		{
			ms,
			service: "backend",
			name: "GET /",
			traceId: `other-${index}`,
			spanId: `be-${index}`,
			parentSpanId: `gw-${index}`,
		},
	]
}

const SEED_SPANS = Arr.flatten(Arr.map(CALL_TIMES, request))

const quote = (value: string): string => `'${Str.replace(/[\\']/g, "\\$&")(value)}'`

const insertSpans = (spans: ReadonlyArray<SeedSpan>): Promise<string> =>
	clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, SampleRate, TraceState, SpanAttributes, ResourceAttributes)
		 VALUES\n${Arr.join(
				Arr.map(
					spans,
					(span) =>
						`(${quote(ORG_ID)}, ${quote(chDateTime(span.ms))}, ${quote(span.traceId)}, ${quote(span.spanId)}, ${quote(span.parentSpanId)}, ${quote(span.name)}, 'Server', ${quote(span.service)}, 90000000, 'Ok', 1, '', map(), map('deployment.environment', 'production'))`,
				),
				",\n",
			)}`,
		database,
	)

const sealHour = async (): Promise<void> => {
	const { sql } = Effect.runSync(
		CH.serviceMapEdgesRollupSQL({
			orgId: ORG_ID,
			hourStart: chDateTime(SEALED_HOUR_MS),
			hourEnd: chDateTime(SEALED_HOUR_MS + HOUR_MS),
		}),
	)
	await clickhouseExec(
		`INSERT INTO service_map_edges_hourly_ingest ${normalizeSqlForClickHouseClient(sql)}`,
		database,
	)
}

const runJson = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	// The normalizer strips `FORMAT JSON`, so ask for it as a setting instead.
	const body = await clickhouseExec(normalizeSqlForClickHouseClient(sql), database, {
		default_format: "JSON",
		output_format_json_quote_64bit_integers: "0",
	})
	const parsed = JSON.parse(body) as { readonly data?: ReadonlyArray<Record<string, unknown>> }
	return parsed.data ?? []
}

describe.skipIf(!clickhouseE2eEnabled)("service map edges from a platform proxy", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await insertSpans(SEED_SPANS)
		await sealHour()
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("seals the edge request → function hop in the rollup", async () => {
		const rows = await runJson(
			"SELECT SourceService, TargetService, sum(CallCount) AS n FROM service_map_edges_hourly GROUP BY SourceService, TargetService",
		)
		assert.deepStrictEqual(
			Arr.map(rows, (row) => [row.SourceService, row.TargetService, Number(row.n)]),
			[[EDGE, "storefront", 1]],
		)
	})

	it("draws the hop across every tier, and no edge for a plain Server→Server parent", async () => {
		const rows = await runJson(Effect.runSync(CH.serviceDependenciesSQL({}, window)).sql)
		assert.deepStrictEqual(
			Arr.map(rows, (row) => [row.sourceService, row.targetService, Number(row.callCount)]),
			[[EDGE, "storefront", CALL_TIMES.length]],
		)
	})
})
