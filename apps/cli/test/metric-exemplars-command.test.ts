// `maple metrics exemplars`: the local read on chDB, its table, and the real binary against a
// stub workspace (the hosted get_metric_exemplars tool), in remote mode.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Array as Arr, Effect, Option, Schema, String as Str } from "effect"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { OrgId, UserId } from "@maple/domain/http"
import type { GetMetricExemplarsOutput } from "@maple/domain/mcp-outputs"
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import {
	makeWarehouseExecutor,
	normalizeSqlForClickHouseClient,
	type WarehouseSqlClient,
	WarehouseDriverError,
} from "@maple/query-engine/execution"
import {
	metricExemplars,
	WarehouseExecutor,
	type MetricExemplarsInput,
} from "@maple/query-engine/observability"
import { describeWithChdb } from "./libchdb-test-support"
import { chTimestamp, MINUTE_MS, SECOND_MS } from "./histogram-metrics-support"
import { renderSections } from "../src/lib/output"
import { metricExemplarsView } from "../src/lib/views"

const TRACE_A = "4bf92f3577b34da6a3ce929d0e0e4736"
const TRACE_B = "0af7651916cd43dd8448eb211c80319c"

const TOOL_OUTPUT: typeof GetMetricExemplarsOutput.Type = {
	metricName: "http.server.request.duration",
	metricType: "histogram",
	timeRange: { start: "2026-11-20 00:00:00", end: "2026-11-20 01:00:00" },
	bucketSeconds: 120,
	perBucket: 3,
	filters: { service: "checkout" },
	exemplars: [
		{
			bucket: "2026-11-20 00:10:00.000",
			timestamp: "2026-11-20 00:10:42.125",
			value: 4.25,
			traceId: TRACE_A,
			spanId: "00f067aa0ba902b7",
			serviceName: "checkout",
		},
		{
			bucket: "2026-11-20 00:02:00.000",
			timestamp: "2026-11-20 00:03:01.000",
			value: 0.5,
			traceId: TRACE_B,
			spanId: "53995c3f42cd8ad8",
			serviceName: "checkout",
		},
	],
	truncated: false,
}

const lines = Str.split("\n")

const ORG = "org_cli_exemplars"
const METRIC = "http.server.request.duration"
const quote = (value: string) => `'${value}'`

/** Histogram rows with exemplars: [offset, service, [value, traceId][]]. */
const ROWS: ReadonlyArray<readonly [number, string, ReadonlyArray<readonly [number, string]>]> = [
	[
		10 * SECOND_MS,
		"api",
		[
			[0.2, "trace-low"],
			[2.5, "trace-spike"],
		],
	],
	[3 * MINUTE_MS, "worker", [[0.9, "trace-worker"]]],
]

const decodeRows = decodeJsonEachRow(Schema.Record(Schema.String, Schema.Unknown))

describeWithChdb("metric exemplars on chDB", () => {
	let root: string | undefined
	let db: Chdb

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-cli-exemplars-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		const values = Arr.map(ROWS, ([offset, service, exemplars]) => {
			const ts = quote(chTimestamp(offset))
			const list = (f: (e: readonly [number, string]) => string) =>
				`[${Arr.join(Arr.map(exemplars, f), ", ")}]`
			return `(${quote(ORG)}, ${quote(service)}, ${quote(METRIC)}, map(), ${ts}, ${ts}, 1, 1, [1], [], ${list(([, id]) => quote(id))}, ${list(([, id]) => quote(`${id}-span`))}, ${list(() => ts)}, ${list(([value]) => String(value))}, 1)`
		})
		db.exec(
			`INSERT INTO metrics_histogram (OrgId, ServiceName, MetricName, Attributes, StartTimeUnix, TimeUnix, Count, Sum, BucketCounts, ExplicitBounds, ExemplarsTraceId, ExemplarsSpanId, ExemplarsTimestamp, ExemplarsValue, AggregationTemporality) VALUES ${Arr.join(values, ", ")}`,
		)
	})

	afterAll(() => {
		db?.close()
		if (root !== undefined) rmSync(root, { recursive: true, force: true })
	})

	const client = (): WarehouseSqlClient => ({
		sql: (statement) =>
			Effect.sync(() => ({
				data: decodeRows(db.query(normalizeSqlForClickHouseClient(statement.text))),
			})),
		insert: () => Effect.fail(new WarehouseDriverError({ reason: "config", message: "read-only test" })),
	})

	const read = (input: Partial<MetricExemplarsInput>) => {
		const executor = makeWarehouseExecutor({
			createClient: () => Effect.succeed(client()),
			resolveRoute: () =>
				Effect.succeed({
					source: "managed" as const,
					config: {
						kind: "chdb" as const,
						url: "",
						username: "",
						password: "",
						database: "default",
					},
					clientCacheKey: "test",
				}),
		}).asExecutor({
			orgId: Schema.decodeSync(OrgId)(ORG),
			userId: Schema.decodeSync(UserId)("test"),
			authMode: "local" as const,
		})
		return Effect.runPromise(
			metricExemplars({
				metricName: METRIC,
				timeRange: {
					startTime: Str.slice(0, 19)(chTimestamp(-MINUTE_MS)),
					endTime: Str.slice(0, 19)(chTimestamp(10 * MINUTE_MS)),
				},
				bucketSeconds: 60,
				...input,
			}).pipe(Effect.provideService(WarehouseExecutor, executor)),
		)
	}

	test("finds the metric's type in the catalog and lists the linked traces, highest first", async () => {
		const result = await read({})
		expect(result._tag).toBe("found")
		if (result._tag !== "found") return
		expect(result.metricType).toBe("histogram")
		expect(Arr.map(result.exemplars, (e) => [e.value, e.traceId, e.serviceName])).toEqual([
			[2.5, "trace-spike", "api"],
			[0.9, "trace-worker", "worker"],
			[0.2, "trace-low", "api"],
		])
		expect(result.exemplars[0]?.timestamp).toBe(chTimestamp(10 * SECOND_MS))
	})

	test("scopes to one service and keeps the per-bucket cap", async () => {
		const result = await read({ service: "api", perBucket: 1 })
		expect(result._tag === "found" && Arr.map(result.exemplars, (e) => e.traceId)).toEqual([
			"trace-spike",
		])
	})

	test("a name not in the catalog is missing, with the names that matched the search", async () => {
		const result = await read({ metricName: "http.server.request" })
		expect(result).toEqual({ _tag: "missing", similar: [METRIC] })
	})
})

describe("table", () => {
	test("lists each exemplar's time, value, service and trace id, highest first", () => {
		const view = metricExemplarsView("none")
		const text = renderSections(
			view.table?.({
				metricName: TOOL_OUTPUT.metricName,
				metricType: TOOL_OUTPUT.metricType,
				bucketSeconds: TOOL_OUTPUT.bucketSeconds,
				exemplars: TOOL_OUTPUT.exemplars,
			}) ?? [],
		)
		const rows = Arr.filter(
			lines(text),
			(line) => Str.includes(TRACE_A)(line) || Str.includes(TRACE_B)(line),
		)
		expect(rows).toHaveLength(2)
		expect(rows[0]).toMatch(/4\.25\s+checkout\s+4bf92f3577b34da6a3ce929d0e0e4736/)
		expect(rows[1]).toMatch(/0\.5\s+checkout\s+0af7651916cd43dd8448eb211c80319c/)
	})

	test("an empty list is empty, so the empty message prints instead of a table", () => {
		const view = metricExemplarsView("none")
		expect(
			view.isEmpty?.({ metricName: "m", metricType: "histogram", bucketSeconds: 60, exemplars: [] }),
		).toBe(true)
	})
})

const CLI = join(import.meta.dir, "..", "src", "bin.ts")

const decodeRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))

const decodeToolCall = Schema.decodeUnknownSync(
	Schema.Struct({
		id: Schema.Number,
		params: Schema.Struct({ arguments: Schema.Struct({ metric_name: Schema.String }) }),
	}),
)

const calls: Array<object> = []
const lastCall = (): object | undefined => Option.getOrUndefined(Arr.last(calls))

let server: ReturnType<typeof Bun.serve>
let home: string

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "maple-exemplars-cli-"))
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const raw = decodeRecord(await request.json())
			const body = decodeToolCall(raw)
			calls.push(raw)
			const result =
				body.params.arguments.metric_name === "missing.metric"
					? {
							isError: true,
							content: [
								{
									type: "text",
									text: 'Invalid input (`metric_name`): No metric named "missing.metric"',
								},
							],
						}
					: { content: [{ type: "text", text: "ok" }], structuredContent: TOOL_OUTPUT }
			return Response.json({ jsonrpc: "2.0", id: body.id, result })
		},
	})
})

afterAll(() => {
	void server.stop(true)
	rmSync(home, { recursive: true, force: true })
})

const cli = async (args: ReadonlyArray<string>) => {
	const proc = Bun.spawn(["bun", CLI, ...args, "--remote"], {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: home,
			MAPLE_API_URL: server.url.origin,
			MAPLE_API_TOKEN: "maple_ak_test",
			MAPLE_TELEMETRY: "0",
			MAPLE_NO_UPDATE_CHECK: "1",
			NO_COLOR: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
	})
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	return { stdout, stderr, code }
}

describe("maple metrics exemplars against a workspace", () => {
	test("sends the metric, window and filters to get_metric_exemplars and prints the traces", async () => {
		const out = await cli([
			"metrics",
			"exemplars",
			"http.server.request.duration",
			"--start",
			"2026-11-20 00:00:00",
			"--end",
			"2026-11-20 01:00:00",
			"-s",
			"checkout",
			"--bucket",
			"120",
			"--per-bucket",
			"2",
			"--format",
			"table",
		])
		expect(out.code).toBe(0)
		expect(out.stdout).toContain(TRACE_A)
		expect(out.stdout).toContain(TRACE_B)
		expect(lastCall()).toMatchObject({
			method: "tools/call",
			params: {
				name: "get_metric_exemplars",
				arguments: {
					metric_name: "http.server.request.duration",
					start_time: "2026-11-20 00:00:00",
					end_time: "2026-11-20 01:00:00",
					service: "checkout",
					bucket_seconds: 120,
					per_bucket: 2,
				},
			},
		})
	}, 30_000)

	test("prints the exemplars as JSON", async () => {
		const out = await cli(["metrics", "exemplars", "http.server.request.duration"])
		expect(out.code).toBe(0)
		const printed = Schema.decodeSync(
			Schema.fromJsonString(
				Schema.Struct({
					metricType: Schema.String,
					exemplars: Schema.Array(Schema.Struct({ traceId: Schema.String, value: Schema.Number })),
				}),
			),
		)(out.stdout)
		expect(printed.metricType).toBe("histogram")
		expect(printed.exemplars).toEqual([
			{ traceId: TRACE_A, value: 4.25 },
			{ traceId: TRACE_B, value: 0.5 },
		])
	}, 30_000)

	test("the workspace's refusal of an unknown metric is the error line", async () => {
		const out = await cli(["metrics", "exemplars", "missing.metric"])
		expect(out.code).toBe(1)
		expect(out.stderr).toContain('No metric named "missing.metric"')
	}, 30_000)
})
