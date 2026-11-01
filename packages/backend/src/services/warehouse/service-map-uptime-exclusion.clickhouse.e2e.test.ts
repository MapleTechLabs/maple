// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// Maple's own uptime checker emits Client spans as `maple-uptime`, and the
// checked service answers with a real Server span. The topology join pairs them
// into an edge the user never drew, so the map must drop it in every tier: the
// live join over the partial hours, the rollup writer sealing the interior, and
// hours sealed before the exclusion existed.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { OrgId } from "@maple/domain"
import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_service_map_uptime_e2e")
const ORG_ID = OrgId.make("org_service_map_uptime")
const UPTIME = "maple-uptime"

// Anchored to now, not a calendar date: `traces` and the service-map span
// tables enforce a TTL at insert time and would silently drop a fixed date.
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

const chDateTime = (epochMs: number): string => new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)

const BASE_MS = Math.floor((Date.now() - 3 * DAY_MS) / DAY_MS) * DAY_MS
// Unaligned at both ends, so the partial hours hold rows the live join must read.
const START_MS = BASE_MS + 10 * HOUR_MS + 30 * MINUTE_MS
const END_MS = BASE_MS + 13 * HOUR_MS + 15 * MINUTE_MS
const FIRST_FULL_HOUR_MS = BASE_MS + 11 * HOUR_MS
const END_HOUR_FLOOR_MS = BASE_MS + 13 * HOUR_MS

const START_TIME = chDateTime(START_MS)
const END_TIME = chDateTime(END_MS)
const window = { orgId: ORG_ID, startTime: START_TIME, endTime: END_TIME }

// Sealed before the exclusion shipped: the read must hide it, not only the writer.
const LEGACY_UPTIME_CALLS = 5

interface SeedSpan {
	readonly ms: number
	readonly service: string
	readonly kind: "Client" | "Server"
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string
}

let seq = 0
/** A parent Client span on `source` and its Server child on `checkout-api`. */
const callPair = (ms: number, source: string): ReadonlyArray<SeedSpan> => {
	const id = seq++
	const traceId = `trace-${id}`
	const parentSpanId = `span-${id}`
	return [
		{ ms, service: source, kind: "Client", traceId, spanId: parentSpanId, parentSpanId: "" },
		{
			ms,
			service: "checkout-api",
			kind: "Server",
			traceId,
			spanId: `${parentSpanId}-child`,
			parentSpanId,
		},
	]
}

// Leading partial hour, two interior hours, trailing partial hour.
const CALL_TIMES = [
	START_MS + 5 * MINUTE_MS,
	FIRST_FULL_HOUR_MS + 10 * MINUTE_MS,
	FIRST_FULL_HOUR_MS + HOUR_MS + 20 * MINUTE_MS,
	END_HOUR_FLOOR_MS + 5 * MINUTE_MS,
]

const SEED_SPANS: ReadonlyArray<SeedSpan> = CALL_TIMES.flatMap((ms) => [
	...callPair(ms, "frontend"),
	...callPair(ms + MINUTE_MS, UPTIME),
])

const quote = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

const insertSpans = async (spans: ReadonlyArray<SeedSpan>): Promise<void> => {
	const rows = spans
		.map(
			(row) =>
				`(${quote(ORG_ID)}, ${quote(chDateTime(row.ms))}, ${quote(row.traceId)}, ${quote(row.spanId)}, ${quote(row.parentSpanId)}, 'op', ${quote(row.kind)}, ${quote(row.service)}, 90000000, 'Ok', 1, '', map('server.address', 'checkout.internal'), map('deployment.environment', 'production'))`,
		)
		.join(",\n")

	await clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, SampleRate, TraceState, SpanAttributes, ResourceAttributes)
		 VALUES\n${rows}`,
		database,
	)
}

/** Seal the whole interior hours exactly as `ServiceMapRollupService` does. */
const runEdgeRollup = async (): Promise<void> => {
	for (let hourMs = FIRST_FULL_HOUR_MS; hourMs < END_HOUR_FLOOR_MS; hourMs += HOUR_MS) {
		const { sql } = Effect.runSync(
			CH.serviceMapEdgesRollupSQL({
				orgId: ORG_ID,
				hourStart: chDateTime(hourMs),
				hourEnd: chDateTime(hourMs + HOUR_MS),
			}),
		)
		await clickhouseExec(
			`INSERT INTO service_map_edges_hourly_ingest ${normalizeSqlForClickHouseClient(sql)}`,
			database,
		)
	}
}

const insertLegacyUptimeRollupRow = (): Promise<string> =>
	clickhouseExec(
		`INSERT INTO service_map_edges_hourly_ingest
		 (OrgId, Hour, SourceService, TargetService, DeploymentEnv, CallCount, ErrorCount, DurationSumMs, MaxDurationMs, SampledSpanCount, UnsampledSpanCount, SampleRateSum)
		 VALUES (${quote(ORG_ID)}, ${quote(chDateTime(FIRST_FULL_HOUR_MS))}, ${quote(UPTIME)}, 'checkout-api', 'production', ${LEGACY_UPTIME_CALLS}, 0, 450, 90, 0, ${LEGACY_UPTIME_CALLS}, ${LEGACY_UPTIME_CALLS})`,
		database,
	)

const runJson = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	// The normalizer strips `FORMAT JSON`, so ask for it as a setting instead.
	const body = await clickhouseExec(normalizeSqlForClickHouseClient(sql), database, {
		default_format: "JSON",
		output_format_json_quote_64bit_integers: "0",
	})
	const parsed = JSON.parse(body) as { readonly data?: ReadonlyArray<Record<string, unknown>> }
	return parsed.data ?? []
}

const num = (value: unknown): number => Number(value ?? 0)
const edgeKey = (row: Record<string, unknown>) => `${String(row.sourceService)}->${String(row.targetService)}`

const assertOnlyRealEdge = (rows: ReadonlyArray<Record<string, unknown>>): void => {
	assert.deepStrictEqual(rows.map(edgeKey), ["frontend->checkout-api"])
	assert.strictEqual(num(rows[0]?.callCount), CALL_TIMES.length, "frontend edge lost calls from a tier")
}

describe.skipIf(!clickhouseE2eEnabled)("service map drops maple-uptime edges", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await insertSpans(SEED_SPANS)
		await insertLegacyUptimeRollupRow()
		await runEdgeRollup()
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("seeds uptime calls in every tier, so the exclusion is not vacuous", async () => {
		const [traces, rawUptime, sealedFrontend] = await Promise.all([
			runJson("SELECT count() AS n FROM traces"),
			runJson(
				`SELECT countIf(Timestamp < ${quote(chDateTime(FIRST_FULL_HOUR_MS))}) AS leading,
					countIf(Timestamp >= ${quote(chDateTime(END_HOUR_FLOOR_MS))}) AS trailing
				 FROM traces WHERE ServiceName = ${quote(UPTIME)}`,
			),
			runJson(
				"SELECT sum(CallCount) AS n FROM service_map_edges_hourly WHERE SourceService = 'frontend'",
			),
		])
		assert.strictEqual(num(traces[0]?.n), SEED_SPANS.length, "traces seed did not land, check the TTL")
		assert.isAbove(num(rawUptime[0]?.leading), 0, "no uptime span in the leading partial hour")
		assert.isAbove(num(rawUptime[0]?.trailing), 0, "no uptime span in the trailing partial hour")
		assert.strictEqual(num(sealedFrontend[0]?.n), 2, "the rollup did not seal the interior hours")
	})

	it("never seals an uptime edge from the rollup writer", async () => {
		// Only the hand-inserted legacy row may carry `maple-uptime` as a source.
		const rows = await runJson(
			`SELECT sum(CallCount) AS n FROM service_map_edges_hourly WHERE SourceService = ${quote(UPTIME)}`,
		)
		assert.strictEqual(num(rows[0]?.n), LEGACY_UPTIME_CALLS)
	})

	it("returns only the real edge from the org-wide map", async () => {
		const rows = await runJson(Effect.runSync(CH.serviceDependenciesSQL({}, window)).sql)
		assertOnlyRealEdge(rows)
	})

	it("returns only the real edge for the service the uptime check targets", async () => {
		const { sql } = Effect.runSync(
			CH.compile(CH.serviceDependenciesInvolvingServiceQuery({ serviceName: "checkout-api" }), window),
		)
		assertOnlyRealEdge(await runJson(sql))
	})
})
