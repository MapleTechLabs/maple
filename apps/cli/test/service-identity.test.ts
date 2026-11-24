import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CH from "@maple/query-engine/ch"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import { Effect, Option, Record as Rec, Array as Arr, String as Str } from "effect"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { LOCAL_ORG_ID } from "../src/core/executor"
import { describeWithChdb } from "./libchdb-test-support"

// Spans through `service_platforms_hourly_mv` into the rollup, read back by `servicePlatformsSQL` and
// classified: the whole service-identity path on the real engine.

interface SpanSeed {
	readonly service: string
	readonly scope: string
	readonly kind: string
	readonly parent: string
	readonly resource: Readonly<Record<string, string>>
}

const mapLiteral = (attrs: Readonly<Record<string, string>>) =>
	`map(${Arr.join(
		Arr.flatMap(Rec.toEntries(attrs), ([key, value]) => [`'${key}'`, `'${value}'`]),
		", ",
	)})`

const NODE = { "process.runtime.name": "nodejs" }
const WORKER = {
	"maple.sdk.type": "cloudflare",
	"process.runtime.name": "workerd",
	"cloud.platform": "cloudflare.workers",
}
const PYTHON = { "telemetry.sdk.name": "opentelemetry", "telemetry.sdk.language": "python" }

describeWithChdb("service identity", () => {
	let root = ""
	let db: Chdb
	const nowMs = Date.now()
	const atMs = nowMs - 20 * 60_000

	const seeds: ReadonlyArray<SpanSeed> = [
		// A Next.js app: its framework's own scope, Server spans.
		{ service: "storefront", scope: "next.js", kind: "Server", parent: "", resource: NODE },
		{
			service: "storefront",
			scope: "@opentelemetry/instrumentation-http",
			kind: "Client",
			parent: "p",
			resource: NODE,
		},
		// Maple's Effect SDK on a Worker: the scope is the service name, `maple.sdk.type` says Effect.
		{ service: "orders-api", scope: "orders-api", kind: "Server", parent: "p", resource: WORKER },
		{ service: "orders-api", scope: "orders-api", kind: "Server", parent: "p", resource: WORKER },
		// A Celery worker: Consumer spans.
		{
			service: "billing-worker",
			scope: "opentelemetry.instrumentation.celery",
			kind: "Consumer",
			parent: "p",
			resource: PYTHON,
		},
		{
			service: "billing-worker",
			scope: "opentelemetry.instrumentation.celery",
			kind: "Consumer",
			parent: "p",
			resource: PYTHON,
		},
		{
			service: "billing-worker",
			scope: "opentelemetry.instrumentation.redis",
			kind: "Client",
			parent: "p",
			resource: PYTHON,
		},
	]

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-service-identity-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		const rows = Arr.map(
			seeds,
			(seed, i) =>
				`('local', '${formatWarehouseDateTime(atMs + i * 1000)}', 't${i}', 's${i}', '${seed.parent}', 'op', '${seed.kind}', '${seed.service}', '${seed.scope}', 1000000, 'Ok', ${mapLiteral(seed.resource)})`,
		)
		db.exec(
			`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, ScopeName, Duration, StatusCode, ResourceAttributes) VALUES ${Arr.join(rows, ", ")}`,
		)
	})

	afterAll(() => {
		db?.close()
		if (root) rmSync(root, { recursive: true, force: true })
	})

	test("the platforms rollup carries what the classifier needs, and each service is named", async () => {
		const compiled = await Effect.runPromise(
			CH.servicePlatformsSQL(
				{},
				{
					orgId: LOCAL_ORG_ID,
					startTime: formatWarehouseDateTime(nowMs - 2 * 3_600_000),
					endTime: formatWarehouseDateTime(nowMs),
				},
			),
		)
		const lines = Str.split("\n")(db.query(normalizeSqlForClickHouseClient(compiled.sql)))
		const rows = await Effect.runPromise(
			compiled.decodeRows(
				Arr.map(
					Arr.filter(lines, (line) => line !== ""),
					(line) => JSON.parse(line),
				),
			),
		)
		const rowOf = (service: string) =>
			Option.getOrThrow(Arr.findFirst(rows, (row) => row.serviceName === service))
		const identityOf = (service: string) => {
			const row = rowOf(service)
			const identity = CH.servicePlatformIdentity(row)
			return {
				kind: identity?.kind,
				framework: identity?.framework,
				scopes: Arr.sort(row.scopeNames, Str.Order),
			}
		}

		expect(identityOf("storefront")).toEqual({
			kind: "web-app",
			framework: "nextjs",
			scopes: ["@opentelemetry/instrumentation-http", "next.js"],
		})
		expect(identityOf("orders-api")).toMatchObject({ kind: "api", framework: "effect" })
		expect(identityOf("billing-worker")).toMatchObject({ kind: "worker", framework: "celery" })
		expect(rowOf("billing-worker")).toMatchObject({
			classifiedSpanCount: 3,
			consumerSpanCount: 2,
			serverSpanCount: 0,
			rootSpanCount: 0,
			telemetrySdkLanguage: "python",
		})
	})
})
