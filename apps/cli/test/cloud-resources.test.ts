// Runs the cloud findings telemetry match on the real ClickHouse engine (chDB): which services served
// requests from a resource, counted from entry-point spans and weighted by their sample rate.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { OrgId } from "@maple/domain"
import { Array as Arr, Order, Record as Rec, Schema, String as Str } from "effect"
import { describeWithChdb } from "./libchdb-test-support"

const ORG = "org_cloud"
const OTHER_ORG = "org_other"
const decode = decodeJsonEachRow(CH.cloudResourceServicesRowSchema)

interface SpanSeed {
	readonly org?: string
	readonly at?: string
	readonly service: string
	readonly kind?: string
	readonly parent?: string
	readonly sampleRate?: number
	readonly resource: Record<string, string>
}

const row = (seed: SpanSeed, index: number) => {
	const map = Arr.join(
		Arr.map(Rec.toEntries(seed.resource), ([key, value]) => `'${key}', '${value}'`),
		", ",
	)
	const spanAttributes = seed.sampleRate === undefined ? "map()" : `map('SampleRate', '${seed.sampleRate}')`
	return `('${seed.org ?? ORG}', '${seed.at ?? "2026-11-16 12:00:00"}', 't${index}', 's${index}', '${seed.parent ?? ""}', 'GET /', '${seed.kind ?? "Server"}', '${seed.service}', map(${map}), ${spanAttributes})`
}

describeWithChdb("cloudResourceServicesQuery on chDB", () => {
	let root: string
	let db: Chdb

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-cloud-resources-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		const seeds: ReadonlyArray<SpanSeed> = [
			// Three requests served from the EC2 instance a finding names.
			...Arr.makeBy(3, () => ({ service: "checkout-api", resource: { "host.id": "i-0abc" } })),
			// Two sampled 1 in 2: four requests, from the Lambda function by name.
			...Arr.makeBy(2, () => ({
				service: "cart",
				sampleRate: 2,
				resource: { "faas.name": "cart-fn" },
			})),
			// A child span is not a request.
			{ service: "checkout-api", kind: "Internal", parent: "p1", resource: { "host.id": "i-0abc" } },
			// Another org's span on the same id, and one outside the window.
			{ org: OTHER_ORG, service: "intruder", resource: { "host.id": "i-0abc" } },
			{ service: "checkout-api", at: "2026-11-10 12:00:00", resource: { "host.id": "i-0abc" } },
			// A resource no finding names.
			{ service: "search", resource: { "host.id": "i-0zzz" } },
			// The same function name in another account does not count.
			{
				service: "intruder",
				resource: {
					"faas.name": "cart-fn",
					"cloud.account.id": "222222222222",
					"cloud.region": "us-east-1",
				},
			},
			// An ECS task's span carries its cluster too: both findings get it.
			{
				service: "orders",
				resource: { "aws.ecs.task.arn": "arn:task/1", "aws.ecs.cluster.arn": "arn:cluster/main" },
			},
		]
		db.exec(
			`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, ResourceAttributes, SpanAttributes) VALUES ${Arr.join(Arr.map(seeds, row), ", ")}`,
		)
	})

	afterAll(() => {
		db?.close()
		if (root) rmSync(root, { recursive: true, force: true })
	})

	test("counts each service's requests per matched resource, in the org and window only", () => {
		const compiled = CH.compileUnsafe(
			CH.cloudResourceServicesQuery({
				candidates: [
					{ key: "host.id", value: "i-0abc", scope: null },
					{
						key: "faas.name",
						value: "cart-fn",
						scope: { accountId: "111111111111", region: "us-east-1" },
					},
					{ key: "aws.ecs.task.arn", value: "arn:task/1", scope: null },
					{ key: "aws.ecs.cluster.arn", value: "arn:cluster/main", scope: null },
				],
			}),
			{
				orgId: Schema.decodeSync(OrgId)(ORG),
				startTime: formatWarehouseDateTime(Date.parse("2026-11-15T12:00:00Z")),
				endTime: formatWarehouseDateTime(Date.parse("2026-11-16T13:00:00Z")),
			},
		)
		const rows = decode(db.query(normalizeSqlForClickHouseClient(compiled.sql)))
		const sorted = Arr.sort(
			Arr.map(
				rows,
				(entry) =>
					[Str.replaceAll("\u001f", "|")(entry.match), entry.service, entry.requests] as const,
			),
			Order.mapInput(Order.String, (entry: readonly [string, string, number]) => entry[0]),
		)
		expect(sorted).toEqual([
			["aws.ecs.cluster.arn||arn:cluster/main", "orders", 1],
			["aws.ecs.task.arn||arn:task/1", "orders", 1],
			["faas.name|111111111111/us-east-1|cart-fn", "cart", 4],
			["host.id||i-0abc", "checkout-api", 3],
		])
	})
})
