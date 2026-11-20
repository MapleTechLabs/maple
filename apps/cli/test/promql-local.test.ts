// `maple promql` in local mode: the engine's selector reads run on a real ClickHouse engine (chDB)
// through a WarehouseExecutor, as they do against `maple start`.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Array as Arr, Effect, Exit, Option, Schema, String as Str } from "effect"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import { normalizeSqlForClickHouseClient, resolveCompiledQuery } from "@maple/query-engine/execution"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import { evaluationWindow, parseQuery, toPromqlOutput } from "../src/core/promql"
import { localPromqlMetricNames, runLocalPromql } from "../src/core/promql-local"
import { LOCAL_ORG_ID } from "../src/core/executor"
import { formatEpochMsUTC } from "../src/core/time"
import { describeWithChdb } from "./libchdb-test-support"

const MINUTE_MS = 60_000
/** On the minute, an hour ago, inside every table's TTL. */
const BASE_MS = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS - 60 * MINUTE_MS
const RANGE = { startTime: formatEpochMsUTC(BASE_MS), endTime: formatEpochMsUTC(BASE_MS + 10 * MINUTE_MS) }

const chTime = (ms: number): string => `'${formatEpochMsUTC(ms)}'`

const gaugeRows = (org: string, metric: string, service: string, values: ReadonlyArray<number>): string =>
	Arr.join(
		Arr.map(
			values,
			(value, i) =>
				`('${org}', map('service.name', '${service}'), '${service}', '${metric}', '', map(), ${chTime(BASE_MS)}, ${chTime(BASE_MS + i * MINUTE_MS)}, ${value})`,
		),
		", ",
	)

const decodeRecords = decodeJsonEachRow(Schema.Record(Schema.String, Schema.Unknown))

let root = ""
let db: Chdb
const sqls: Array<string> = []

/** The CLI's executor over chDB: every compiled query runs as the local server would run it. */
const chdbExecutor = () =>
	WarehouseExecutor.of({
		orgId: LOCAL_ORG_ID,
		query: () => Effect.die("pipe queries are not used by PromQL"),
		compiledQuery: (input) =>
			Effect.flatMap(resolveCompiledQuery(input), (compiled) => {
				sqls.push(compiled.sql)
				const rows = decodeRecords(db.query(normalizeSqlForClickHouseClient(compiled.sql)))
				return Effect.orDie(compiled.decodeRows(rows))
			}),
		compiledQueryFirst: () => Effect.die("unused"),
	})

const runLocal = async (query: string, instant = false) => {
	const effect = Effect.gen(function* () {
		const expr = yield* parseQuery(query, instant)
		const window = yield* evaluationWindow({ range: RANGE, instant, step: "1m" })
		return toPromqlOutput(query, window, yield* runLocalPromql(expr, window))
	})
	return Effect.runPromiseExit(Effect.provideService(effect, WarehouseExecutor, chdbExecutor()))
}

describeWithChdb("maple promql, local mode", () => {
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-promql-local-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		const rows = [
			gaugeRows("local", "queue_depth", "api", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
			gaugeRows("local", "queue_depth", "worker", [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]),
			// Another tenant's series under the same name must never be read.
			gaugeRows(
				"org_other",
				"queue_depth",
				"api",
				[1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
			),
			gaugeRows("org_other", "secret_gauge", "api", [1]),
			...Arr.makeBy(101, (i) => gaugeRows("local", `many_${i}`, "api", [i])),
		]
		db.exec(
			`INSERT INTO metrics_gauge (OrgId, ResourceAttributes, ServiceName, MetricName, MetricUnit, Attributes, StartTimeUnix, TimeUnix, Value) VALUES ${Arr.join(rows, ", ")}`,
		)
	})

	afterAll(() => {
		db.close()
		rmSync(root, { recursive: true, force: true })
	})

	test("evaluates over the local store's series, scoped to the local tenant", async () => {
		sqls.length = 0
		const exit = await runLocal("sum by (job) (queue_depth)")
		expect(Exit.isSuccess(exit)).toBe(true)
		const output = Exit.isSuccess(exit) ? exit.value : undefined
		expect(output?.resultType).toBe("matrix")
		const series = output?.series ?? []
		expect(Arr.map(series, (s) => [s.labels.job, s.points[s.points.length - 1]?.v])).toEqual([
			["api", 11],
			["worker", 10],
		])
		expect(series[0]?.stats).toEqual({ min: 1, avg: 6, max: 11 })
		expect(sqls.length).toBeGreaterThan(1)
		expect(Arr.every(sqls, (sql) => Str.includes("'local'")(sql))).toBe(true)
	})

	test("an instant query reads one value per series", async () => {
		const exit = await runLocal("queue_depth", true)
		const output = Exit.isSuccess(exit) ? exit.value : undefined
		expect(output?.resultType).toBe("vector")
		expect(output?.totalSeries).toBe(2)
	})

	test("refuses a selector that matches more than 100 metrics", async () => {
		const exit = await runLocal('{__name__=~"many_.+"}')
		const error = Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined
		expect(error?.message).toBe("a selector matches 101 metrics, at most 100")
	})

	test("lists the local tenant's Prometheus names only", async () => {
		const names = await Effect.runPromise(
			Effect.provideService(
				localPromqlMetricNames({ startMs: BASE_MS, endMs: BASE_MS + 10 * MINUTE_MS }),
				WarehouseExecutor,
				chdbExecutor(),
			),
		)
		expect(names).toContain("queue_depth")
		expect(names).toContain("many_100")
		expect(names).not.toContain("secret_gauge")
	})
})
