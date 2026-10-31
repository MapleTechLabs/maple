// SAFETY-FILE: JSON is emitted by the isolated ClickHouse fixture and decoded by the real query schema.
// The platform integrations write their metrics under `service.name` = the resource name. These
// seed each one's series against the real schema and read back the resources a service runs as.

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

const database = uniqueDatabase("maple_service_runtimes_e2e")
const ORG = "org_runtimes"

const MINUTE_MS = 60_000
// Anchored to now so the table TTL never drops the seed.
const END_MS = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS - 10 * MINUTE_MS
const START_MS = END_MS - 60 * MINUTE_MS
const chDateTime = (epochMs: number): string => new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)

const quote = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
const mapLiteral = (attrs: Readonly<Record<string, string>>): string =>
	`map(${Object.entries(attrs)
		.flatMap(([key, value]) => [quote(key), quote(value)])
		.join(", ")})`

interface Sample {
	readonly org?: string
	readonly service: string
	readonly metric: string
	readonly resource: Readonly<Record<string, string>>
	readonly point?: Readonly<Record<string, string>>
}

const RAILWAY = (environmentId: string, environmentName: string) => ({
	"railway.service.id": "svc_worker",
	"railway.environment.id": environmentId,
	"railway.environment.name": environmentName,
})

const SAMPLES: ReadonlyArray<Sample> = [
	{
		service: "fleet-api",
		metric: "gcp.cloud_run.container.instance.count",
		resource: { "cloud.account.id": "fleet-prod", "cloud.region": "europe-west1" },
	},
	// Not a marker: a resource is counted once, by its marker.
	{
		service: "fleet-api",
		metric: "gcp.cloud_run.container.cpu.utilization",
		resource: { "cloud.account.id": "fleet-prod", "cloud.region": "europe-west1" },
	},
	{
		service: "cloudflare-worker/edge-router",
		metric: "cloudflare.worker.cpu_time",
		resource: { "cloudflare.account.id": "cf-acct" },
	},
	{ service: "fleet-worker", metric: "railway.cpu.usage", resource: RAILWAY("env_prod", "production") },
	{ service: "fleet-worker", metric: "railway.cpu.usage", resource: RAILWAY("env_stg", "staging") },
	{
		service: "checkout",
		metric: "aws.ecs.cpu_utilization",
		resource: { "cloud.account.id": "123456789012", "cloud.region": "us-east-1" },
		point: { "aws.dimension.cluster_name": "prod-cluster" },
	},
	// Another tenant's resource of the same name.
	{
		org: "org_other",
		service: "fleet-api",
		metric: "gcp.cloud_run.container.instance.count",
		resource: { "cloud.account.id": "intruder", "cloud.region": "us-central1" },
	},
	// A service nobody asked about.
	{ service: "billing", metric: "aws.lambda.duration", resource: { "cloud.region": "us-east-1" } },
]

const runJson = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	// The normalizer strips `FORMAT JSON`, so ask for it as a setting instead.
	const body = await clickhouseExec(normalizeSqlForClickHouseClient(sql), database, {
		default_format: "JSON",
		output_format_json_quote_64bit_integers: "0",
	})
	const parsed = JSON.parse(body) as { readonly data?: ReadonlyArray<Record<string, unknown>> }
	return parsed.data ?? []
}

const runtimes = async (services: ReadonlyArray<string>) => {
	const compiled = Effect.runSync(
		CH.serviceRuntimesSQL(
			{ services },
			{ orgId: OrgId.make(ORG), startTime: chDateTime(START_MS), endTime: chDateTime(END_MS) },
		),
	)
	return Effect.runPromise(compiled.decodeRows(await runJson(compiled.sql)))
}

describe.skipIf(!clickhouseE2eEnabled)("serviceRuntimesSQL against ClickHouse", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		const at = quote(chDateTime(END_MS - 5 * MINUTE_MS))
		const rows = SAMPLES.map(
			(sample) =>
				`(${quote(sample.org ?? ORG)}, ${quote(sample.service)}, ${quote(sample.metric)}, ${at}, ${at}, 1, ${mapLiteral(sample.resource)}, ${mapLiteral(sample.point ?? {})})`,
		).join(",\n")
		await clickhouseExec(
			`INSERT INTO metrics_gauge (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value, ResourceAttributes, Attributes) VALUES\n${rows}`,
			database,
		)
	}, 120_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	})

	it("finds each platform's resource under the service's names, with the keys its page needs", async () => {
		const rows = await runtimes(["fleet-api", "edge-router", "fleet-worker", "checkout"])
		assert.deepStrictEqual(
			rows.map((row) => [row.metricServiceName, row.metricName, row.account, row.region, row.cluster]),
			[
				["checkout", "aws.ecs.cpu_utilization", "123456789012", "us-east-1", "prod-cluster"],
				["cloudflare-worker/edge-router", "cloudflare.worker.cpu_time", "cf-acct", "", ""],
				["fleet-api", "gcp.cloud_run.container.instance.count", "fleet-prod", "europe-west1", ""],
				["fleet-worker", "railway.cpu.usage", "", "", ""],
				["fleet-worker", "railway.cpu.usage", "", "", ""],
			],
		)
		assert.deepStrictEqual(
			rows
				.filter((row) => row.metricServiceName === "fleet-worker")
				.map((row) => [row.railwayServiceId, row.railwayEnvironmentId, row.railwayEnvironmentName])
				.sort(),
			[
				["svc_worker", "env_prod", "production"],
				["svc_worker", "env_stg", "staging"],
			],
		)
	})

	it("reads nothing for a service that runs on no connected platform", async () => {
		assert.deepStrictEqual(await runtimes(["frontend"]), [])
	})
})
