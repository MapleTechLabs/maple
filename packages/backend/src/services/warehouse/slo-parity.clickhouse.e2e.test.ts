// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// SLO splice parity: `sloTotalsQuery` and `sloBucketsQuery` against a flat scan.
//
// The SLO reads tile a window from raw `service_overview_spans` (partial minutes),
// `service_overview_minutely` (partial hours) and `service_overview_hourly` (the rest).
// Spans sit exactly on every seam of several windows, aligned and not, so a boundary
// that drifts by one bucket double-counts or drops a whole cluster of spans.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import type { SloSli } from "@maple/domain/slo"
import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import { Array as Arr, Record as Rec, Schema, String as Str } from "effect"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_slo_parity_e2e")
const ORG_ID = "org_slo_parity"
const LEGACY_ORG_ID = "org_slo_parity_pre_ladder"

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
const SECOND_MS = 1000

/** Midnight three days back: inside the 30-day TTL of `traces` and `service_overview_spans`. */
const BASE_MS = Math.floor((Date.now() - 3 * DAY_MS) / DAY_MS) * DAY_MS
const at = (h: number, m: number, s = 0): number => BASE_MS + h * HOUR_MS + m * MINUTE_MS + s * SECOND_MS

const chDateTime = (epochMs: number): string =>
	Str.slice(0, 19)(Str.replace("T", " ")(new Date(epochMs).toISOString()))

interface Window {
	readonly label: string
	readonly startMs: number
	readonly endMs: number
}

const WINDOWS: ReadonlyArray<Window> = [
	{ label: "unaligned 10:30:30-14:15:30", startMs: at(10, 30, 30), endMs: at(14, 15, 30) },
	{ label: "hour-aligned 10:00-14:00", startMs: at(10, 0), endMs: at(14, 0) },
	{ label: "minute-aligned 10:30-14:15", startMs: at(10, 30), endMs: at(14, 15) },
	{ label: "hour-aligned start, unaligned end 10:00-14:15:30", startMs: at(10, 0), endMs: at(14, 15, 30) },
	{ label: "unaligned start, hour-aligned end 10:30:30-14:00", startMs: at(10, 30, 30), endMs: at(14, 0) },
	{ label: "sub-hour 10:30:30-10:45:30", startMs: at(10, 30, 30), endMs: at(10, 45, 30) },
]

/** Every seam of every window above, plus the second on each side of each window bound. */
const SEAMS_MS: ReadonlyArray<number> = [
	at(9, 59, 59),
	at(10, 0),
	at(10, 0, 1),
	at(10, 0, 30),
	at(10, 29, 59),
	at(10, 30),
	at(10, 30, 1),
	at(10, 30, 29),
	at(10, 30, 30),
	at(10, 30, 59),
	at(10, 31),
	at(10, 45),
	at(10, 45, 29),
	at(10, 45, 30),
	at(10, 45, 31),
	at(10, 59, 59),
	at(11, 0),
	at(11, 59, 59),
	at(12, 0),
	at(13, 59, 59),
	at(14, 0),
	at(14, 0, 1),
	at(14, 14, 59),
	at(14, 15),
	at(14, 15, 1),
	at(14, 15, 29),
	at(14, 15, 30),
	at(14, 15, 31),
]

interface SeedSpan {
	readonly org: string
	readonly ms: number
	readonly service: string
	readonly environment: string
	readonly kind: "Server" | "Internal"
	readonly parent: string
	readonly durationNs: number
	readonly status: "Ok" | "Error"
	readonly sampleRate: number
}

const span = (ms: number, overrides: Partial<Omit<SeedSpan, "ms">> = {}): SeedSpan => ({
	org: ORG_ID,
	ms,
	service: "api",
	environment: "production",
	kind: "Server",
	parent: "",
	durationNs: 120_000_000,
	status: "Ok",
	sampleRate: 1,
	...overrides,
})

/** One cluster per seam: both sides of the 500ms rung, errors, sampled rows, and decoys. */
const seamCluster = (ms: number): ReadonlyArray<SeedSpan> => [
	span(ms, { durationNs: 499_999_999 }),
	span(ms, { durationNs: 500_000_000, sampleRate: 2 }),
	span(ms, { durationNs: 100_000_000, status: "Error", sampleRate: 3 }),
	span(ms, { durationNs: 1_200_000_000, status: "Error" }),
	span(ms, { environment: "staging", durationNs: 50_000_000, sampleRate: 5 }),
	span(ms, { environment: "staging", durationNs: 900_000_000, status: "Error", sampleRate: 7 }),
	span(ms, { service: "worker", durationNs: 2_000_000_000, status: "Error" }),
	// Not an entry point: the views never see it.
	span(ms, { kind: "Internal", parent: "parent-span", status: "Error", sampleRate: 11 }),
]

const SEED_SPANS: ReadonlyArray<SeedSpan> = [
	...Arr.flatMap(SEAMS_MS, seamCluster),
	// Interior volume every 7 minutes from 09:00 to 15:30, so every tier aggregates real rows.
	...Arr.map(Arr.range(0, 55), (i) =>
		span(at(9, 0) + i * 7 * MINUTE_MS + 13 * SECOND_MS, {
			durationNs: (40 + i * 23) * 1_000_000,
			status: i % 5 === 0 ? "Error" : "Ok",
			sampleRate: i % 3 === 0 ? 10 : 1,
			environment: i % 4 === 0 ? "staging" : "production",
		}),
	),
	// The pre-ladder org's real spans, read beside its directly inserted legacy rollup rows.
	...Arr.map([at(10, 30, 45), at(10, 50), at(12, 20), at(13, 40), at(14, 15, 10)], (ms, i) =>
		span(ms, {
			org: LEGACY_ORG_ID,
			durationNs: i % 2 === 0 ? 200_000_000 : 800_000_000,
			status: i === 3 ? "Error" : "Ok",
			sampleRate: 2,
		}),
	),
]

const quote = (value: string): string => `'${Str.replace(/'/g, "\\'")(Str.replace(/\\/g, "\\\\")(value))}'`

const seed = async (): Promise<void> => {
	const rows = Arr.join(
		Arr.map(SEED_SPANS, (row, index) => {
			const resourceAttributes = `map('deployment.environment', ${quote(row.environment)}, 'service.namespace', 'ns', 'vcs.ref.head.revision', 'abc123')`
			return `(${quote(row.org)}, ${quote(chDateTime(row.ms))}, ${quote(`trace-${index}`)}, ${quote(`span-${index}`)}, ${quote(row.parent)}, 'GET /x', ${quote(row.kind)}, ${quote(row.service)}, ${row.durationNs}, ${quote(row.status)}, ${row.sampleRate}, ${resourceAttributes})`
		}),
		",\n",
	)
	await clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, SampleRate, ResourceAttributes)
		 VALUES\n${rows}`,
		database,
	)
}

/** Rows as written before migration 0058: no ladder columns, so they default to 0. */
const LEGACY_ROWS = [
	{ table: "service_overview_hourly", time: "Hour", ms: at(12, 0), estimated: 50, errors: 5 },
	// The leading partial hour of the unaligned window: the minutely tier owns it.
	{ table: "service_overview_minutely", time: "Minute", ms: at(10, 40), estimated: 30, errors: 3 },
	// Inside the hourly interior: a whole-window read must take the hour row, not this one.
	{ table: "service_overview_minutely", time: "Minute", ms: at(12, 10), estimated: 1000, errors: 0 },
] as const

const seedLegacy = async (): Promise<void> => {
	for (const row of LEGACY_ROWS) {
		await clickhouseExec(
			`INSERT INTO ${row.table} (OrgId, ${row.time}, ServiceName, DeploymentEnv, ServiceNamespace, CommitSha, SpanCount, EstimatedSpanCount, ErrorCount, EstimatedErrorCount, DurationSum, FirstSeen, ApdexSatisfiedCount, ApdexToleratingCount)
			 VALUES (${quote(LEGACY_ORG_ID)}, ${quote(chDateTime(row.ms))}, 'api', 'production', 'ns', 'abc123', ${row.estimated}, ${row.estimated}, ${row.errors}, ${row.errors}, 1000000, ${quote(chDateTime(row.ms))}, 0, 0)`,
			database,
		)
	}
}

const runJson = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	const body = await clickhouseExec(normalizeSqlForClickHouseClient(sql), database, {
		default_format: "JSON",
		output_format_json_quote_64bit_integers: "0",
	})
	const parsed = JSON.parse(body) as { readonly data?: ReadonlyArray<Record<string, unknown>> }
	return parsed.data ?? []
}

const num = (value: unknown): number => Number(value ?? 0)

interface Case {
	readonly label: string
	readonly sli: SloSli
	readonly environments: readonly string[]
}

const SLIS: ReadonlyArray<{ readonly label: string; readonly sli: SloSli }> = [
	{ label: "availability", sli: { _tag: "availability" } },
	{ label: "latency 500ms", sli: { _tag: "latency", thresholdMs: 500 } },
	{ label: "latency 250ms", sli: { _tag: "latency", thresholdMs: 250 } },
]

const ENVIRONMENTS: ReadonlyArray<readonly string[]> = [[], ["production"], ["production", "staging"]]

const goodPredicate = (sli: SloSli): string =>
	sli._tag === "availability" ? "StatusCode != 'Error'" : `Duration < ${sli.thresholdMs * 1_000_000}`

/** Ground truth: one scan of the per-span projection the rollups derive from, no splice. */
const flatSql = (orgId: string, window: Window, c: Case, bucketSeconds: number | undefined): string => `
	SELECT
		${bucketSeconds === undefined ? "'all'" : `toString(toStartOfInterval(toDateTime(Timestamp), INTERVAL ${bucketSeconds} SECOND))`} AS bucket,
		toFloat64(sum(SampleRate)) AS total,
		toFloat64(sumIf(SampleRate, ${goodPredicate(c.sli)})) AS good
	FROM service_overview_spans
	WHERE OrgId = ${quote(orgId)}
		AND ServiceName = 'api'
		AND Timestamp >= ${quote(chDateTime(window.startMs))}
		AND Timestamp <= ${quote(chDateTime(window.endMs))}
		${c.environments.length > 0 ? `AND DeploymentEnv IN (${Arr.join(Arr.map(c.environments, quote), ", ")})` : ""}
	GROUP BY bucket
	ORDER BY bucket
`

const params = (orgId: string, window: Window) => ({
	orgId,
	startTime: chDateTime(window.startMs),
	endTime: chDateTime(window.endMs),
})

const decodeTotals = Schema.decodeUnknownSync(CH.sloTotalsRowSchema)

const splicedTotals = async (orgId: string, window: Window, c: Case) => {
	const rows = await runJson(
		CH.compileUnsafe(
			CH.sloTotalsQuery({ serviceName: "api", environments: c.environments, sli: c.sli }),
			params(orgId, window),
		).sql,
	)
	assert.lengthOf(rows, 1, "sloTotalsQuery returns exactly one row")
	return decodeTotals(rows[0])
}

const flatTotals = async (orgId: string, window: Window, c: Case) => {
	const rows = await runJson(flatSql(orgId, window, c, undefined))
	return { total: num(rows[0]?.total), good: num(rows[0]?.good) }
}

/** Buckets keyed by their start; empty buckets carry no information on either side. */
const byBucket = (rows: ReadonlyArray<Record<string, unknown>>) =>
	Rec.fromEntries(
		Arr.map(
			Arr.filter(rows, (row) => num(row.total) !== 0 || num(row.good) !== 0),
			(row): readonly [string, { readonly total: number; readonly good: number }] => [
				Str.slice(0, 19)(String(row.bucket)),
				{ total: num(row.total), good: num(row.good) },
			],
		),
	)

const BUCKET_GRAINS = [
	{ grain: "hour", bucketSeconds: 3600 },
	{ grain: "hour", bucketSeconds: 7200 },
	{ grain: "minute", bucketSeconds: 60 },
	{ grain: "minute", bucketSeconds: 300 },
] as const

describe.skipIf(!clickhouseE2eEnabled)("SLO raw-vs-rollup parity", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await seed()
		await seedLegacy()
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("lands the seed in the projection and both rollups, with a cluster on every seam", async () => {
		const entryPoints = Arr.filter(SEED_SPANS, (row) => row.org === ORG_ID && row.kind === "Server")
		const weight = Arr.reduce(entryPoints, 0, (sum, row) => sum + row.sampleRate)
		const where = `WHERE OrgId = ${quote(ORG_ID)}`
		const [spans, minutely, hourly] = await Promise.all([
			runJson(
				`SELECT count() AS n, toFloat64(sum(SampleRate)) AS w FROM service_overview_spans ${where}`,
			),
			runJson(
				`SELECT toFloat64(sum(EstimatedSpanCount)) AS w, toFloat64(sum(EstimatedLadderSpanCount)) AS c FROM service_overview_minutely ${where}`,
			),
			runJson(
				`SELECT toFloat64(sum(EstimatedSpanCount)) AS w, toFloat64(sum(EstimatedLadderSpanCount)) AS c FROM service_overview_hourly ${where}`,
			),
		])
		assert.strictEqual(num(spans[0]?.n), entryPoints.length, "check the seed against the 30-day TTL")
		assert.strictEqual(num(spans[0]?.w), weight)
		for (const rollup of [minutely[0], hourly[0]]) {
			assert.strictEqual(num(rollup?.w), weight)
			assert.strictEqual(num(rollup?.c), weight)
		}
		for (const seam of SEAMS_MS) {
			const rows = await runJson(
				`SELECT count() AS n FROM service_overview_spans ${where} AND Timestamp = ${quote(chDateTime(seam))}`,
			)
			assert.isAbove(num(rows[0]?.n), 0, `no span sits on ${chDateTime(seam)}`)
		}
	})

	// `for` loops, not `describe.each`: the latter OOMs tsc in this repo.
	for (const window of WINDOWS) {
		for (const { label, sli } of SLIS) {
			for (const environments of ENVIRONMENTS) {
				const c: Case = { label, sli, environments }
				const name = `${window.label}, ${label}, env=[${Arr.join(environments, ",")}]`

				it(`totals match a flat scan: ${name}`, async () => {
					const [spliced, truth] = await Promise.all([
						splicedTotals(ORG_ID, window, c),
						flatTotals(ORG_ID, window, c),
					])
					assert.isAbove(truth.total, 0, "the flat scan found nothing: the seed missed the window")
					assert.isAbove(truth.total, truth.good, "every span is good: the SLI cannot fail")
					assert.isAbove(truth.good, 0, "no span is good")
					assert.deepStrictEqual(spliced, truth)
				})
			}
		}

		for (const { grain, bucketSeconds } of BUCKET_GRAINS) {
			for (const { label, sli } of Arr.take(SLIS, 2)) {
				for (const environments of Arr.take(ENVIRONMENTS, 2)) {
					const c: Case = { label, sli, environments }
					const name = `${window.label}, ${grain} ${bucketSeconds}s, ${label}, env=[${Arr.join(environments, ",")}]`

					it(`buckets match per-bucket flat scans and sum to the totals: ${name}`, async () => {
						const [spliced, truth, totals] = await Promise.all([
							runJson(
								CH.compileUnsafe(
									CH.sloBucketsQuery(
										{ serviceName: "api", environments: c.environments, sli: c.sli },
										grain,
									),
									{ ...params(ORG_ID, window), bucketSeconds },
								).sql,
							),
							runJson(flatSql(ORG_ID, window, c, bucketSeconds)),
							splicedTotals(ORG_ID, window, c),
						])
						assert.isAbove(truth.length, 0)
						assert.deepStrictEqual(byBucket(spliced), byBucket(truth))
						assert.deepStrictEqual(
							Arr.reduce(spliced, { total: 0, good: 0 }, (sum, row) => ({
								total: sum.total + num(row.total),
								good: sum.good + num(row.good),
							})),
							totals,
						)
					})
				}
			}
		}
	}

	it("drops pre-ladder rollup rows from a latency SLI and still counts them for availability", async () => {
		const window = Arr.getUnsafe(WINDOWS, 0)
		const availability: Case = { label: "availability", sli: { _tag: "availability" }, environments: [] }
		const latency: Case = {
			label: "latency",
			sli: { _tag: "latency", thresholdMs: 500 },
			environments: [],
		}
		const [availabilitySpliced, availabilityFlat, latencySpliced, latencyFlat] = await Promise.all([
			splicedTotals(LEGACY_ORG_ID, window, availability),
			flatTotals(LEGACY_ORG_ID, window, availability),
			splicedTotals(LEGACY_ORG_ID, window, latency),
			flatTotals(LEGACY_ORG_ID, window, latency),
		])
		assert.isAbove(latencyFlat.total, 0)
		// Legacy rows have zero coverage: the latency read is exactly the real spans.
		assert.deepStrictEqual(latencySpliced, latencyFlat)
		// The whole-window read takes the 12:00 hour row and the 10:40 minute row; the 12:10
		// minute row sits inside the hourly interior, where the minutely tier does not read.
		assert.deepStrictEqual(availabilitySpliced, {
			total: availabilityFlat.total + 50 + 30,
			good: availabilityFlat.good + (50 - 5) + (30 - 3),
		})
	})
})
