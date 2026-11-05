// Differential fuzz of the metrics builder's two aggregation stages: a seeded
// world of gauges and counters goes into the real migrated tables, random
// queries run through the real query engine, and every bucket and group must
// equal a plain TypeScript reference of "reduce each series in time, then
// combine the series of a group".
//
// Replay a failure with METRICS_FUZZ_SEED=<seed from the failure message>.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Effect, Schema, Array as Arr, String as Str } from "effect"
import fc from "fast-check"
import { MetricName, OrgId, UserId } from "@maple/domain"
import {
	QueryEngineExecuteRequest,
	type MetricsMetric,
	type MetricsSpaceAggregation,
	type QuerySpec,
} from "@maple/domain/query-engine"
import { baselineWarehouseCapabilities } from "@maple/query-engine"
import { makeQueryEngineExecute } from "@maple/query-engine/runtime"
import { compiledQueryOf, normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_metrics_fuzz_e2e")
const SEED = Number(process.env.METRICS_FUZZ_SEED || Date.now() % 2 ** 31)
const RUNS = Number(process.env.METRICS_FUZZ_RUNS || 300)

const tenant: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_metrics_fuzz"),
	userId: Schema.decodeSync(UserId)("user_metrics_fuzz"),
	roles: [],
	authMode: "self_hosted",
}

const MINUTE_MS = 60_000
// Second-aligned, now-relative (the tables enforce a TTL at insert time) and
// deliberately not minute-aligned, so edge buckets are partial.
const WINDOW_START_MS = Math.floor((Date.now() - 6 * 60 * MINUTE_MS) / 1000) * 1000 + 17_000
const WINDOW_MS = 90 * MINUTE_MS

const chDateTime = (ms: number): string => Str.slice(0, 19)(Str.replace("T", " ")(new Date(ms).toISOString()))
const quote = (value: string): string => `'${Str.replace(/[\\']/g, "\\$&")(value)}'`

// World

interface Point {
	readonly ms: number
	readonly startMs: number
	readonly value: number
}
interface Series {
	readonly service: string
	readonly attributes: Readonly<Record<string, string>>
	readonly resource: Readonly<Record<string, string>>
	readonly points: ReadonlyArray<Point>
}

/** mulberry32: a tiny seeded PRNG so the world replays from the seed alone. */
const prng = (seed: number) => {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const buildWorld = (seed: number, kind: "gauge" | "counter"): ReadonlyArray<Series> => {
	const rand = prng(seed + (kind === "gauge" ? 1 : 2))
	const pick = <A,>(items: ReadonlyArray<A>): A => items[Math.floor(rand() * items.length)] as A
	const generated = Arr.makeBy(24, (): Series => {
		const intervalMs = pick([5_000, 10_000, 15_000, 30_000, 60_000])
		// Series start before the window (counters need a previous sample) and some stop early.
		const firstMs = WINDOW_START_MS - pick([0, 60_000, 300_000]) + Math.floor(rand() * 5) * 1000
		const lastMs = WINDOW_START_MS + WINDOW_MS * (rand() < 0.2 ? rand() : 1.05)
		const points: Point[] = []
		let startMs = firstMs - 3_600_000
		let total = Math.floor(rand() * 1000)
		for (let ms = firstMs; ms < lastMs; ms += intervalMs) {
			if (kind === "gauge") {
				points.push({ ms, startMs, value: Math.round((rand() * 200 - 50) * 100) / 100 })
				continue
			}
			const reset = rand() < 0.01
			if (reset) {
				total = Math.floor(rand() * 5)
				// Half the resets restamp StartTimeUnix the way a restarted SDK does.
				if (rand() < 0.5) startMs = ms - 1000
			} else total += Math.floor(rand() * 20)
			points.push({ ms, startMs, value: total })
		}
		return {
			service: pick(["api", "worker", "web"]),
			attributes: Object.fromEntries(
				Arr.filter(
					[
						["namespace", pick(["prod", "staging", ""])],
						["job", pick(["scrape", "push"])],
					] as const,
					([, v]) => v !== "",
				),
			),
			resource: { "host.name": pick(["h1", "h2", "h3", "h4"]) },
			points,
		}
	})
	// Two series with the same service, labels and resource ARE one series to
	// the warehouse; keep the first so the reference agrees on identity.
	return Arr.dedupeWith(generated, (a, b) => identityOf(a) === identityOf(b))
}

const identityOf = (s: Series): string => JSON.stringify([s.service, s.attributes, s.resource])

// Reference semantics

interface FuzzQuery {
	readonly kind: "gauge" | "counter"
	readonly metric: MetricsMetric
	readonly space: MetricsSpaceAggregation | undefined
	readonly groupService: boolean
	readonly attributeKeys: ReadonlyArray<string>
	readonly resourceKeys: ReadonlyArray<string>
	readonly bucketSeconds: number
	readonly startOffsetSeconds: number
	readonly durationSeconds: number
	readonly serviceFilter: string | undefined
	readonly seriesLimit: number | undefined
}

const groupOf = (series: Series, q: FuzzQuery): string => {
	const parts: string[] = []
	if (q.groupService) parts.push(series.service)
	for (const key of q.attributeKeys) parts.push(series.attributes[key] ?? "")
	for (const key of q.resourceKeys) parts.push(series.resource[key] ?? "")
	if (parts.length === 0) return "all"
	if (parts.length === 1) return parts[0] || "(empty)"
	return Arr.join(Arr.filter(parts, (p) => p !== ""), " · ") || "(empty)"
}

const combine = (values: ReadonlyArray<number>, space: MetricsSpaceAggregation): number => {
	switch (space) {
		case "sum":
			return values.reduce((a, b) => a + b, 0)
		case "avg":
			return values.reduce((a, b) => a + b, 0) / values.length
		case "min":
			return Math.min(...values)
		case "max":
			return Math.max(...values)
		case "count":
			return values.length
	}
}

const reduceInTime = (points: ReadonlyArray<Point>, metric: MetricsMetric): number => {
	const values = Arr.map(points, (p) => p.value)
	switch (metric) {
		case "avg":
			return values.reduce((a, b) => a + b, 0) / values.length
		case "sum":
			return values.reduce((a, b) => a + b, 0)
		case "min":
			return Math.min(...values)
		case "max":
			return Math.max(...values)
		case "count":
			return values.length
		default:
			return Arr.reduce(points, points[0] as Point, (best, p) => (p.ms > best.ms ? p : best)).value
	}
}

/** `metricDeltaExpr`: reset-aware increment against the previous sample of the series. */
const deltasOf = (points: ReadonlyArray<Point>, fromMs: number): ReadonlyArray<Point> => {
	const visible = Arr.filter(points, (p) => p.ms >= fromMs)
	return Arr.map(visible, (p, i) => {
		const prev = i === 0 ? p : (visible[i - 1] as Point)
		const restarted = p.startMs > prev.ms && p.startMs < p.ms
		const delta = p.value < prev.value || restarted ? p.value : p.value - prev.value
		return { ...p, value: delta }
	})
}

const referenceSeries = (world: ReadonlyArray<Series>, q: FuzzQuery) => {
	const startMs = WINDOW_START_MS + q.startOffsetSeconds * 1000
	const endMs = startMs + q.durationSeconds * 1000
	const bucketMs = q.bucketSeconds * 1000
	const isCounter = q.metric === "rate" || q.metric === "increase"
	// bucket -> group -> per-series values
	const cells = new Map<number, Map<string, number[]>>()
	for (const series of world) {
		if (q.serviceFilter !== undefined && series.service !== q.serviceFilter) continue
		const points = isCounter ? deltasOf(series.points, startMs - bucketMs) : series.points
		const byBucket = new Map<number, Point[]>()
		for (const p of points) {
			if (p.ms < startMs || p.ms > endMs) continue
			const bucket = Math.floor(p.ms / bucketMs) * bucketMs
			byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), p])
		}
		const group = groupOf(series, q)
		for (const [bucket, inBucket] of byBucket) {
			const value = isCounter
				? inBucket.reduce((a, p) => a + p.value, 0)
				: reduceInTime(inBucket, q.metric)
			const groups = cells.get(bucket) ?? new Map<string, number[]>()
			groups.set(group, [...(groups.get(group) ?? []), value])
			cells.set(bucket, groups)
		}
	}
	const defaultSpace: MetricsSpaceAggregation =
		q.metric === "avg" || q.metric === "min" || q.metric === "max" ? q.metric : "sum"
	const space = q.space ?? defaultSpace
	const out = new Map<number, Map<string, number>>()
	for (const [bucket, groups] of cells) {
		const covered =
			(Math.min(bucket + bucketMs, Math.floor(endMs / 1000) * 1000) - Math.max(bucket, startMs)) / 1000
		const row = new Map<string, number>()
		for (const [group, values] of groups) {
			const combined = combine(values, space)
			row.set(group, q.metric === "rate" && space !== "count" ? (covered > 0 ? combined / covered : 0) : combined)
		}
		out.set(bucket, row)
	}
	if (q.seriesLimit === undefined || q.groupService === false && q.attributeKeys.length + q.resourceKeys.length === 0)
		return out
	const peaks = new Map<string, number>()
	for (const row of out.values())
		for (const [group, value] of row) peaks.set(group, Math.max(peaks.get(group) ?? -Infinity, value))
	const kept = new Set(
		Arr.map(
			[...peaks].sort(([ga, a], [gb, b]) => (b - a !== 0 ? b - a : ga < gb ? -1 : 1)).slice(0, q.seriesLimit),
			([group]) => group,
		),
	)
	for (const row of out.values()) for (const group of [...row.keys()]) if (!kept.has(group)) row.delete(group)
	return out
}

// Engine under test

const decodeJsonRows = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Struct({ data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) })),
)
const runRows = (sql: string) =>
	Effect.promise(() =>
		clickhouseExec(normalizeSqlForClickHouseClient(sql), database, {
			default_format: "JSON",
			output_format_json_quote_64bit_integers: "0",
		}).then((body) => decodeJsonRows(body).data),
	)

const execute = makeQueryEngineExecute({
	rawSqlQuery: (_tenant, sql) => runRows(sql),
	compiledQuery: (_tenant, compiled) =>
		runRows(compiledQueryOf(compiled).sql).pipe(
			Effect.flatMap((rows) => compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie)),
		),
	compiledQueryWithCapabilities: (_tenant, compile) =>
		compile(baselineWarehouseCapabilities()).pipe(
			Effect.orDie,
			Effect.flatMap((compiled) =>
				runRows(compiledQueryOf(compiled).sql).pipe(
					Effect.flatMap((rows) => compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie)),
				),
			),
		),
})

const specOf = (q: FuzzQuery): QuerySpec => {
	const groupBy: Array<"service" | "attribute" | "resource_attribute"> = []
	if (q.groupService) groupBy.push("service")
	if (q.attributeKeys.length > 0) groupBy.push("attribute")
	if (q.resourceKeys.length > 0) groupBy.push("resource_attribute")
	return {
		kind: "timeseries",
		source: "metrics",
		metric: q.metric,
		...(q.space === undefined ? undefined : { spaceAggregation: q.space }),
		...(groupBy.length === 0 ? undefined : { groupBy }),
		filters: {
			metricName: Schema.decodeSync(MetricName)(q.kind === "gauge" ? "fuzz.gauge" : "fuzz.counter"),
			metricType: q.kind === "gauge" ? "gauge" : "sum",
			...(q.serviceFilter === undefined ? undefined : { serviceName: q.serviceFilter }),
			...(q.attributeKeys.length > 0 ? { groupByAttributeKeys: q.attributeKeys } : undefined),
			...(q.resourceKeys.length > 0 ? { groupByResourceAttributeKeys: q.resourceKeys } : undefined),
		},
		bucketSeconds: q.bucketSeconds,
		...(q.seriesLimit === undefined ? undefined : { seriesLimit: q.seriesLimit }),
	} as QuerySpec
}

const fuzzQuery: fc.Arbitrary<FuzzQuery> = fc
	.record({
		kind: fc.constantFrom("gauge" as const, "counter" as const),
		gaugeMetric: fc.constantFrom<MetricsMetric>("avg", "sum", "min", "max", "count", "latest"),
		counterMetric: fc.constantFrom<MetricsMetric>("rate", "increase"),
		space: fc.option(fc.constantFrom<MetricsSpaceAggregation>("sum", "avg", "min", "max", "count"), {
			nil: undefined,
		}),
		groupService: fc.boolean(),
		attributeKeys: fc.subarray(["namespace", "job"]),
		resourceKeys: fc.subarray(["host.name"]),
		bucketSeconds: fc.constantFrom(60, 120, 300, 900),
		startOffsetSeconds: fc.integer({ min: 0, max: 1800 }),
		durationSeconds: fc.integer({ min: 120, max: 3600 }),
		serviceFilter: fc.option(fc.constantFrom("api", "worker"), { nil: undefined }),
		seriesLimit: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
	})
	.map(({ gaugeMetric, counterMetric, ...rest }) => ({
		...rest,
		metric: rest.kind === "gauge" ? gaugeMetric : counterMetric,
	}))

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b))

const GAUGES = buildWorld(SEED, "gauge")
const COUNTERS = buildWorld(SEED, "counter")

const insertWorld = async (world: ReadonlyArray<Series>, table: string, name: string, extra: string) => {
	const mapOf = (m: Readonly<Record<string, string>>) =>
		`map(${Arr.join(Arr.flatMap(Object.entries(m), ([k, v]) => [quote(k), quote(v)]), ", ")})`
	const rows = Arr.flatMap(world, (s) =>
		Arr.map(
			s.points,
			(p) =>
				`(${quote(tenant.orgId)}, ${quote(s.service)}, ${quote(name)}, ${quote(chDateTime(p.startMs))}, ${quote(chDateTime(p.ms))}, ${p.value}, ${mapOf(s.attributes)}, ${mapOf(s.resource)}${extra})`,
		),
	)
	const columns = `OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value, Attributes, ResourceAttributes${extra === "" ? "" : ", AggregationTemporality, IsMonotonic"}`
	await clickhouseExec(`INSERT INTO ${table} (${columns}) VALUES\n${Arr.join(rows, ",\n")}`, database)
}

describe.skipIf(!clickhouseE2eEnabled)("metrics two-stage aggregation fuzz", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await insertWorld(GAUGES, "metrics_gauge", "fuzz.gauge", "")
		await insertWorld(COUNTERS, "metrics_sum", "fuzz.counter", ", 2, true")
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	})

	it.effect(`matches the reference for ${RUNS} random queries (seed ${SEED})`, () =>
		Effect.promise(() =>
			fc.assert(
				fc.asyncProperty(fuzzQuery, async (q) => {
					const startMs = WINDOW_START_MS + q.startOffsetSeconds * 1000
					const request = new QueryEngineExecuteRequest({
						startTime: chDateTime(startMs),
						endTime: chDateTime(startMs + q.durationSeconds * 1000),
						query: specOf(q),
					})
					const response = await Effect.runPromise(execute(tenant, request))
					assert.strictEqual(response.result.kind, "timeseries")
					const actual = new Map<number, Readonly<Record<string, number>>>()
					if (response.result.kind === "timeseries")
						for (const point of response.result.data) actual.set(Date.parse(point.bucket), point.series)
					const expected = referenceSeries(q.kind === "gauge" ? GAUGES : COUNTERS, q)
					for (const [bucket, groups] of expected) {
						const got = actual.get(bucket) ?? {}
						for (const [group, value] of groups) {
							const observed = got[group]
							assert.isTrue(
								observed !== undefined && close(observed, value),
								`seed ${SEED} bucket ${new Date(bucket).toISOString()} group ${group}: expected ${value}, got ${observed} for ${JSON.stringify(q)}`,
							)
						}
						assert.strictEqual(Object.keys(got).length, groups.size, `extra groups at ${bucket}: ${JSON.stringify(q)}`)
					}
					for (const [bucket, series] of actual)
						if (!expected.has(bucket))
							assert.strictEqual(Object.keys(series).length, 0, `unexpected bucket ${bucket}: ${JSON.stringify(q)}`)
				}),
				{ numRuns: RUNS, seed: SEED },
			),
		),
	240_000)
})
