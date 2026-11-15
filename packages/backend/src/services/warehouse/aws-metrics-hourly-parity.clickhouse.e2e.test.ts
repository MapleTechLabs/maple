// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// Raw-vs-rollup parity for the AWS infra metrics read.
//
// `aws_metrics_hourly` is a performance change, not a semantics change: `awsInfraMetricsSQL` must
// return the same rows whether it reads raw `metrics_sum` / `metrics_gauge` points or the rollup's
// whole hours spliced with the raw partial hours. A wrong seam double-counts or drops the edge
// hours and still renders a plausible number, so the seed puts points exactly on hour boundaries
// and the windows start and end on, between and inside them.
//
// Also seeded: one instance id in two accounts and two regions (the rollup must keep them apart),
// a load balancer's per-target-group and per-zone copies (excluded on both tiers), and a non-AWS
// metric (the views must not write it).

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { AWS_INFRA_KIND_IDS, type AwsInfraKindId } from "@maple/domain/aws-infra"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import * as Integrations from "@maple/query-engine-integrations"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "../../testing/clickhouse-e2e-support"

const database = uniqueDatabase("maple_aws_metrics_hourly_parity_e2e")
const ORG_ID = OrgId.make("org_aws_metrics_hourly_parity")

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** Midnight three days back: inside the 90-day TTL, so no seeded row is dropped on insert. */
const BASE_MS = Math.floor((Date.now() - 3 * DAY_MS) / DAY_MS) * DAY_MS
/** A query bound, to the millisecond. */
const at = (offsetMs: number): string =>
	Str.slice(0, 23)(Str.replace("T", " ")(new Date(BASE_MS + offsetMs).toISOString()))

interface Series {
	readonly table: "metrics_sum" | "metrics_gauge"
	readonly service: string
	readonly metric: string
	readonly attributes: Readonly<Record<string, string>>
	readonly region: string
	readonly account: string
}

const ec2 = (instance: string, region: string, account: string): ReadonlyArray<Series> => [
	{
		table: "metrics_gauge",
		service: instance,
		metric: "aws.ec2.cpu_utilization",
		attributes: { "aws.dimension.instance_id": instance },
		region,
		account,
	},
	{
		table: "metrics_sum",
		service: instance,
		metric: "aws.ec2.network_in.sum",
		attributes: { "aws.dimension.instance_id": instance },
		region,
		account,
	},
]

const loadBalancer = (attributes: Readonly<Record<string, string>>): Series => ({
	table: "metrics_sum",
	service: "app/lb-1/abc",
	metric: "aws.application_elb.request_count.sum",
	attributes: { "aws.dimension.load_balancer": "app/lb-1/abc", ...attributes },
	region: "us-east-1",
	account: "111",
})

const SERIES: ReadonlyArray<Series> = [
	...ec2("i-a", "us-east-1", "111"),
	// The same instance id in another account and region: two rows, never one.
	...ec2("i-a", "eu-west-1", "222"),
	...ec2("i-b", "us-east-1", "111"),
	loadBalancer({}),
	// CloudWatch's per-target-group and per-zone copies of the same requests.
	loadBalancer({ "aws.dimension.target_group": "tg-1" }),
	loadBalancer({ "aws.dimension.availability_zone": "us-east-1a" }),
	{
		table: "metrics_gauge",
		service: "host-1",
		metric: "system.cpu.utilization",
		attributes: {},
		region: "us-east-1",
		account: "111",
	},
]

/** A point every 10 minutes from half an hour before the day to half an hour after it, so every hour seam holds one. */
const OFFSETS = Arr.map(Arr.range(-3, 24 * 6 + 3), (step) => step * 10 * MINUTE_MS)

/** Whole and half values only: their sums are exact in any order, so the tiers can be compared with equality. */
const valueAt = (seriesIndex: number, step: number) => ((seriesIndex * 7 + step * 3) % 23) / 2

const quote = (value: string): string => `'${Str.replace(/[\\']/g, "\\$&")(value)}'`
const mapLiteral = (entries: Readonly<Record<string, string>>): string =>
	`map(${Arr.join(
		Arr.flatMap(Rec.toEntries(entries), ([key, value]) => [quote(key), quote(value)]),
		", ",
	)})`

const seed = async (): Promise<void> => {
	for (const table of ["metrics_sum", "metrics_gauge"] as const) {
		const rows = Arr.flatMap(
			Arr.filter(
				Arr.map(SERIES, (series, index) => [series, index] as const),
				([series]) => series.table === table,
			),
			([series, index]) =>
				Arr.map(
					OFFSETS,
					(offset, step) =>
						`(${quote(ORG_ID)}, ${mapLiteral({ "cloud.region": series.region, "cloud.account.id": series.account })}, ${quote(series.service)}, ${quote(series.metric)}, ${mapLiteral(series.attributes)}, ${quote(at(offset))}, ${valueAt(index, step)})`,
				),
		)
		await clickhouseExec(
			`INSERT INTO ${table} (OrgId, ResourceAttributes, ServiceName, MetricName, Attributes, TimeUnix, Value) VALUES\n${Arr.join(rows, ",\n")}`,
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

const WINDOWS: ReadonlyArray<{ readonly label: string; readonly start: number; readonly end: number }> = [
	{ label: "hour-aligned", start: HOUR_MS, end: 23 * HOUR_MS },
	{ label: "mid-hour at both ends", start: HOUR_MS + 30 * MINUTE_MS, end: 20 * HOUR_MS + 15 * MINUTE_MS },
	{ label: "inside one hour", start: 5 * HOUR_MS + 10 * MINUTE_MS, end: 5 * HOUR_MS + 50 * MINUTE_MS },
	{ label: "starting on a point", start: 2 * HOUR_MS + 20 * MINUTE_MS, end: 5 * HOUR_MS + 20 * MINUTE_MS },
	{ label: "the whole day and beyond", start: -2 * HOUR_MS, end: 26 * HOUR_MS },
	{ label: "starting half a second past an hour's point", start: 3 * HOUR_MS + 500, end: 6 * HOUR_MS },
]

const read = (kind: AwsInfraKindId, tier: Integrations.AwsMetricsTier, start: number, end: number) =>
	runJson(
		compileUnsafe(Integrations.awsInfraMetricsSQL(kind, tier), {
			orgId: ORG_ID,
			startTime: at(start),
			endTime: at(end),
		}).sql,
	)

if (clickhouseE2eEnabled) {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await seed()
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)
}

describe.skipIf(!clickhouseE2eEnabled)("AWS infra metrics raw-vs-rollup parity", () => {
	it("fills the rollup from the views with the AWS series only, one row per series and hour", async () => {
		const rows = await runJson(
			`SELECT MetricName, count() AS rows, uniqExact(Hour) AS hours FROM aws_metrics_hourly FINAL WHERE OrgId = ${quote(ORG_ID)} GROUP BY MetricName ORDER BY MetricName`,
		)
		assert.deepStrictEqual(
			Arr.map(rows, (row) => row.MetricName),
			["aws.application_elb.request_count.sum", "aws.ec2.cpu_utilization", "aws.ec2.network_in.sum"],
		)
		// 26 hours hold points (the half hour on either side of the day included).
		for (const row of rows) assert.strictEqual(Number(row.hours), 26, String(row.MetricName))
	})

	// A `for` loop, not `describe.each`: the latter OOMs tsc in this repo.
	for (const window of WINDOWS) {
		it(`agrees across tiers for every kind: ${window.label}`, async () => {
			for (const kind of AWS_INFRA_KIND_IDS) {
				const [hourly, raw] = await Promise.all([
					read(kind, "hourly", window.start, window.end),
					read(kind, "raw", window.start, window.end),
				])
				assert.deepStrictEqual(hourly, raw, `${kind} over ${window.label}`)
			}
		})
	}

	it("keeps an instance id's accounts apart and drops the load balancer's per-target-group and per-zone copies", async () => {
		const ec2Rows = await read("ec2", "hourly", HOUR_MS, 23 * HOUR_MS)
		assert.deepStrictEqual(Arr.dedupe(Arr.map(ec2Rows, (row) => JSON.stringify(row.keys))), [
			JSON.stringify(["i-a", "eu-west-1", "222"]),
			JSON.stringify(["i-a", "us-east-1", "111"]),
			JSON.stringify(["i-b", "us-east-1", "111"]),
		])
		const lbRows = await read("loadBalancers", "hourly", HOUR_MS, 23 * HOUR_MS)
		const requests = Option.getOrThrow(
			Arr.findFirst(lbRows, (row) => row.metric === "aws.application_elb.request_count.sum"),
		)
		// 22 hours of 6 points plus the one on the inclusive end bound; the copies would triple it.
		assert.strictEqual(Number(requests.samples), 22 * 6 + 1)
	})
})
