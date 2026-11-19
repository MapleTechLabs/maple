// A traces widget over a numeric span attribute (`valueField: attr.gen_ai.usage.cost`) runs end to
// end on the real ClickHouse engine (chDB): the request is decoded from the JSON the dashboard sends,
// lowered by the query engine and answered with the attribute aggregate, not the span count.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { baselineWarehouseCapabilities } from "@maple/query-engine"
import { compiledQueryOf, normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import {
	makeQueryEngineEvaluate,
	makeQueryEngineExecute,
	type QueryEngineWarehouse,
} from "@maple/query-engine/runtime"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { OrgId } from "@maple/domain"
import { QueryEngineExecuteRequest } from "@maple/domain/query-engine"
import { Array as Arr, Effect, Exit, Order, Record as Rec, Schema, String as Str } from "effect"
import { describeWithChdb } from "./libchdb-test-support"

const ORG = "org_numeric"
const tenant = { orgId: Schema.decodeSync(OrgId)(ORG) }

// Now-relative so the tables' TTL keeps the rows; one whole hour, two hours back.
const HOUR_MS = 3_600_000
const START_MS = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 2 * HOUR_MS
const chDateTime = (ms: number): string => Str.slice(0, 19)(Str.replace("T", " ")(new Date(ms).toISOString()))

interface SpanSeed {
	readonly org?: string
	readonly service: string
	readonly attributes: Record<string, string>
}

const seeds: ReadonlyArray<SpanSeed> = [
	{ service: "llm-api", attributes: { "gen_ai.usage.cost": "0.5", "gen_ai.usage.output_tokens": "100" } },
	{ service: "llm-api", attributes: { "gen_ai.usage.cost": "1.5", "gen_ai.usage.output_tokens": "300" } },
	// Sampled 1 in 2: stands for two spans in the sum, one value everywhere else.
	{ service: "llm-api", attributes: { "gen_ai.usage.cost": "2", SampleRate: "2" } },
	// No value, a value that is not a number, and non-finite ones: counted spans, never values.
	{ service: "llm-api", attributes: {} },
	{ service: "llm-api", attributes: { "gen_ai.usage.cost": "n/a" } },
	{ service: "llm-api", attributes: { "gen_ai.usage.cost": "NaN" } },
	{ service: "llm-api", attributes: { "gen_ai.usage.cost": "inf" } },
	{ service: "batch", attributes: { "gen_ai.usage.cost": "10" } },
	{ org: "org_other", service: "llm-api", attributes: { "gen_ai.usage.cost": "1000" } },
]

const row = (seed: SpanSeed, index: number) => {
	const map = Arr.join(
		Arr.map(Rec.toEntries(seed.attributes), ([key, value]) => `'${key}', '${value}'`),
		", ",
	)
	return `('${seed.org ?? ORG}', '${chDateTime(START_MS + 60_000 * (index + 1))}', 't${index}', 's${index}', '', 'POST /chat', 'Server', '${seed.service}', map(), map(${map}))`
}

const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(QueryEngineExecuteRequest))
const decodeJsonLine = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

describeWithChdb("traces numeric-attribute aggregation on chDB", () => {
	let root: string
	let db: Chdb

	const runRows = (sql: string) =>
		Effect.sync(() =>
			Arr.map(
				Arr.filter(Str.split("\n")(db.query(normalizeSqlForClickHouseClient(sql))), Str.isNonEmpty),
				(line) => decodeJsonLine(line),
			),
		)

	const warehouse: QueryEngineWarehouse = {
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
						Effect.flatMap((rows) =>
							compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie),
						),
					),
				),
			),
	}
	const execute = makeQueryEngineExecute(warehouse)
	const evaluate = makeQueryEngineEvaluate(warehouse)

	// The spec the query builder emits for `aggregation: fn`, `valueField: attr.<key>`, as JSON.
	const requestJson = (
		kind: "timeseries" | "breakdown",
		key: string,
		fn: string,
		extra: Record<string, unknown> = {},
	) =>
		JSON.stringify({
			startTime: chDateTime(START_MS),
			endTime: chDateTime(START_MS + HOUR_MS - 1000),
			query: {
				kind,
				source: "traces",
				metric: "count",
				// Root-only, hourly, by service: every rollup route could answer the count.
				...(kind === "timeseries"
					? { groupBy: ["service"], bucketSeconds: 3600 }
					: { groupBy: "service" }),
				filters: { rootSpansOnly: true, numericAggregation: { key, fn } },
				...extra,
			},
		})

	const timeseries = async (key: string, fn: string, extra: Record<string, unknown> = {}) => {
		const response = await Effect.runPromise(
			execute(tenant, decodeRequest(requestJson("timeseries", key, fn, extra))),
		)
		expect(response.result.kind).toBe("timeseries")
		return response.result.kind === "timeseries"
			? Arr.map(response.result.data, (point) => point.series)
			: []
	}

	const breakdown = async (key: string, fn: string) => {
		const response = await Effect.runPromise(
			execute(tenant, decodeRequest(requestJson("breakdown", key, fn))),
		)
		expect(response.result.kind).toBe("breakdown")
		return response.result.kind === "breakdown" ? response.result.data : []
	}

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-numeric-aggregation-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		db.exec(
			`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, ResourceAttributes, SpanAttributes) VALUES ${Arr.join(Arr.map(seeds, row), ", ")}`,
		)
	})

	afterAll(() => {
		db?.close()
		if (root) rmSync(root, { recursive: true, force: true })
	})

	test("sum charts the sample-weighted attribute total per service, not the span count", async () => {
		expect(await timeseries("gen_ai.usage.cost", "sum")).toEqual([{ "llm-api": 6, batch: 10 }])
	})

	test("avg, min and max read only spans carrying a numeric value", async () => {
		const [avg] = await timeseries("gen_ai.usage.cost", "avg")
		expect(avg?.["llm-api"]).toBeCloseTo(4 / 3, 9)
		expect(await timeseries("gen_ai.usage.cost", "min")).toEqual([{ "llm-api": 0.5, batch: 10 }])
		expect(await timeseries("gen_ai.usage.cost", "max")).toEqual([{ "llm-api": 2, batch: 10 }])
	})

	test("percentiles interpolate over numeric values only, and a group without any reads zero", async () => {
		const [p50] = await timeseries("gen_ai.usage.cost", "p50")
		expect(p50?.["llm-api"]).toBeCloseTo(1.5, 9)
		const [p95] = await timeseries("gen_ai.usage.cost", "p95")
		expect(p95?.["llm-api"]).toBeCloseTo(1.95, 9)
		expect(p95?.batch).toBeCloseTo(10, 9)
		const [p99] = await timeseries("gen_ai.usage.output_tokens", "p99")
		expect(p99?.["llm-api"]).toBeCloseTo(298, 9)
		expect(p99?.batch).toBe(0)
	})

	test("a key no span carries reads zero", async () => {
		expect(await timeseries("gen_ai.usage.missing", "sum")).toEqual([{ "llm-api": 0, batch: 0 }])
	})

	test("breakdown ranks services by the attribute aggregate", async () => {
		expect(await breakdown("gen_ai.usage.cost", "sum")).toEqual([
			{ name: "batch", value: 10 },
			{ name: "llm-api", value: 6 },
		])
		expect(await breakdown("gen_ai.usage.output_tokens", "max")).toEqual([
			{ name: "llm-api", value: 300 },
			{ name: "batch", value: 0 },
		])
	})

	test("a series cap keeps the groups with the largest values, not the busiest", async () => {
		expect(await timeseries("gen_ai.usage.cost", "sum", { seriesLimit: 1 })).toEqual([{ batch: 10 }])
	})

	test("an all-metrics request with a numeric aggregation still charts the value", async () => {
		expect(await timeseries("gen_ai.usage.cost", "max", { allMetrics: true })).toEqual([
			{ "llm-api": 2, batch: 10 },
		])
	})

	test("an alert samples only spans carrying a value, and none is no data", async () => {
		const observe = (key: string) =>
			Effect.runPromise(
				evaluate(tenant, {
					startTime: chDateTime(START_MS),
					endTime: chDateTime(START_MS + HOUR_MS - 1000),
					source: {
						kind: "spec",
						query: decodeRequest(requestJson("timeseries", key, "min")).query,
					},
					reducer: "identity",
					sampleCountStrategy: "trace_count",
				}),
			)
		const byGroup = <A extends { readonly groupKey: string }>(rows: ReadonlyArray<A>) =>
			Arr.sort(
				rows,
				Order.mapInput(Order.String, (entry: A) => entry.groupKey),
			)
		expect(byGroup(await observe("gen_ai.usage.cost"))).toEqual([
			{ groupKey: "batch", value: 10, sampleCount: 1, hasData: true },
			{ groupKey: "llm-api", value: 0.5, sampleCount: 3, hasData: true },
		])
		expect(Arr.every(await observe("gen_ai.usage.missing"), (entry) => !entry.hasData)).toBe(true)
	})

	test("a blank attribute key or unknown function is rejected at decode", () => {
		const exit = (key: string, fn: string) =>
			Effect.runSyncExit(
				Schema.decodeEffect(Schema.fromJsonString(QueryEngineExecuteRequest))(
					requestJson("timeseries", key, fn),
				),
			)
		expect(Exit.isFailure(exit("", "sum"))).toBe(true)
		expect(Exit.isFailure(exit(" gen_ai.usage.cost", "sum"))).toBe(true)
		expect(Exit.isFailure(exit("gen_ai.usage.cost", "median"))).toBe(true)
		expect(Exit.isSuccess(exit("gen_ai.usage.cost", "p95"))).toBe(true)
	})
})
