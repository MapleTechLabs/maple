// SAFETY-FILE: JSON is emitted by the isolated ClickHouse fixture and decoded by the real query schema.
// The workload list joins three collectors' series (replica gauges, container restarts,
// pod usage) per workload. These seed each against the real schema and read the rows back.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { listWorkloadsQuery, type ListWorkloadsOpts } from "../../../../query-engine/src/ch/queries/infra"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_k8s_workloads_e2e")
const ORG = "org_k8s"

const MINUTE_MS = 60_000
// Anchored to now so the table TTL never drops the seed.
const END_MS = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS - 10 * MINUTE_MS
const START_MS = END_MS - 60 * MINUTE_MS
const chDateTime = (epochMs: number): string => new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)
const minutesBeforeEnd = (minutes: number) => chDateTime(END_MS - minutes * MINUTE_MS)

const quote = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

interface Sample {
	readonly org?: string
	readonly metric: string
	readonly minutesBeforeEnd: number
	readonly value: number
	readonly attrs: Record<string, string>
}

const cluster = { "k8s.cluster.name": "prod", "k8s.namespace.name": "payments" }
const deploy = (name: string) => ({ ...cluster, "k8s.deployment.name": name })
const pod = (deployment: string, uid: string, extra: Record<string, string> = {}) => ({
	...deploy(deployment),
	"k8s.pod.name": `${deployment}-${uid}`,
	"k8s.pod.uid": uid,
	...extra,
})
const fargatePod = (deployment: string, uid: string) =>
	pod(deployment, uid, { "eks.amazonaws.com/compute-type": "fargate" })
const job = (name: string) => ({ ...cluster, "k8s.job.name": name })

const samples: ReadonlyArray<Sample> = [
	// checkout-api: a rollout left 2 of 5 available, and two pods restart.
	{ metric: "k8s.deployment.desired", minutesBeforeEnd: 50, value: 5, attrs: deploy("checkout-api") },
	{ metric: "k8s.deployment.desired", minutesBeforeEnd: 1, value: 5, attrs: deploy("checkout-api") },
	{ metric: "k8s.deployment.available", minutesBeforeEnd: 50, value: 5, attrs: deploy("checkout-api") },
	{ metric: "k8s.deployment.available", minutesBeforeEnd: 1, value: 2, attrs: deploy("checkout-api") },
	{ metric: "k8s.pod.cpu.usage", minutesBeforeEnd: 40, value: 0.6, attrs: pod("checkout-api", "a") },
	{ metric: "k8s.pod.cpu.usage", minutesBeforeEnd: 1, value: 0.2, attrs: pod("checkout-api", "a") },
	{
		metric: "k8s.pod.memory_limit_utilization",
		minutesBeforeEnd: 20,
		value: 0.38,
		attrs: pod("checkout-api", "a"),
	},
	// Pod b stopped reporting half an hour ago: it counts as a pod, not as cores in use now.
	{ metric: "k8s.pod.cpu.usage", minutesBeforeEnd: 30, value: 0.9, attrs: pod("checkout-api", "b") },
	...restarts("checkout-api", "a", "app", [0, 1, 4], "OOMKilled"),
	...restarts("checkout-api", "b", "app", [10, 12], ""),
	...restarts("checkout-api", "b", "sidecar", [5, 5], "Completed"),
	// Errored 20 minutes before pod a's OOM kill, so the OOM kill is the workload's latest reason.
	...restarts("checkout-api", "b", "worker", [3, 8, 8], "Error"),

	// api: fully available. A Fargate pod near its CPU limit restarts twice; a node pod with
	// no usage series restarts 7 times, which a Fargate filter must not count.
	// The Fargate pod's Error is the more recent restart; the node pod's OOM kills came first.
	...restarts("api", "c", "app", [0, 0, 2], "Error", { computeType: "fargate" }),
	...restarts("api", "d", "app", [0, 7, 7], "OOMKilled"),
	{ metric: "k8s.deployment.desired", minutesBeforeEnd: 1, value: 3, attrs: deploy("api") },
	{ metric: "k8s.deployment.available", minutesBeforeEnd: 1, value: 3, attrs: deploy("api") },
	{
		metric: "k8s.pod.cpu_limit_utilization",
		minutesBeforeEnd: 15,
		value: 0.93,
		attrs: fargatePod("api", "c"),
	},
	{
		metric: "k8s.pod.cpu_limit_utilization",
		minutesBeforeEnd: 1,
		value: 0.4,
		attrs: fargatePod("api", "c"),
	},
	{ metric: "k8s.pod.cpu.usage", minutesBeforeEnd: 1, value: 0.5, attrs: fargatePod("api", "c") },

	// orphan: wants 2 pods, none ever scheduled, so there is no pod usage at all.
	{ metric: "k8s.deployment.desired", minutesBeforeEnd: 1, value: 2, attrs: deploy("orphan") },
	{ metric: "k8s.deployment.available", minutesBeforeEnd: 1, value: 0, attrs: deploy("orphan") },

	// Another tenant's checkout-api must not leak into this org's row.
	{
		org: "org_other",
		metric: "k8s.deployment.desired",
		minutesBeforeEnd: 1,
		value: 99,
		attrs: deploy("checkout-api"),
	},
	...restarts("checkout-api", "z", "app", [0, 500], "Error", { org: "org_other" }),

	// Jobs: one finished cleanly, one keeps failing.
	{ metric: "k8s.job.desired_successful_pods", minutesBeforeEnd: 1, value: 1, attrs: job("nightly") },
	{ metric: "k8s.job.successful_pods", minutesBeforeEnd: 1, value: 1, attrs: job("nightly") },
	{ metric: "k8s.job.failed_pods", minutesBeforeEnd: 1, value: 0, attrs: job("nightly") },
	{ metric: "k8s.job.desired_successful_pods", minutesBeforeEnd: 1, value: 1, attrs: job("broken") },
	{ metric: "k8s.job.successful_pods", minutesBeforeEnd: 1, value: 0, attrs: job("broken") },
	{ metric: "k8s.job.failed_pods", minutesBeforeEnd: 1, value: 2, attrs: job("broken") },
]

function restarts(
	deployment: string,
	uid: string,
	container: string,
	totals: ReadonlyArray<number>,
	reason: string,
	{ org, computeType }: { org?: string; computeType?: string } = {},
): ReadonlyArray<Sample> {
	const baseAttrs = {
		"k8s.container.name": container,
		"k8s.container.status.last_terminated_reason": reason,
	}
	const containerAttrs =
		computeType === undefined
			? baseAttrs
			: { ...baseAttrs, "eks.amazonaws.com/compute-type": computeType }
	return totals.map((value, index) => ({
		org,
		metric: "k8s.container.restarts",
		minutesBeforeEnd: 45 - index * 20,
		value,
		attrs: pod(deployment, uid, containerAttrs),
	}))
}

const mapLiteral = (attrs: Record<string, string>) =>
	`map(${Object.entries(attrs)
		.flatMap(([key, value]) => [quote(key), quote(value)])
		.join(", ")})`

describe.skipIf(!clickhouseE2eEnabled)("listWorkloadsQuery against ClickHouse", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		const rows = samples
			.map((sample) => {
				const at = quote(minutesBeforeEnd(sample.minutesBeforeEnd))
				return `(${quote(sample.org ?? ORG)}, '', ${quote(sample.metric)}, ${at}, ${at}, ${sample.value}, ${mapLiteral(sample.attrs)})`
			})
			.join(",\n")
		await clickhouseExec(
			`INSERT INTO metrics_gauge (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value, ResourceAttributes) VALUES\n${rows}`,
			database,
		)
	}, 120_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	})

	const run = async (opts: ListWorkloadsOpts) => {
		const compiled = compileUnsafe(listWorkloadsQuery(opts), {
			orgId: OrgId.make(ORG),
			startTime: chDateTime(START_MS),
			endTime: chDateTime(END_MS),
		})
		const body = JSON.parse(
			await clickhouseExec(normalizeSqlForClickHouseClient(compiled.sql), database, {
				default_format: "JSON",
				output_format_json_quote_64bit_integers: "0",
			}),
		)
		assert.isDefined(compiled.rowSchema)
		return Schema.decodeUnknownSync(Schema.Array(compiled.rowSchema!))(body.data)
	}

	it("ranks missing replicas first, including a workload with no pods at all", async () => {
		const rows = await run({ kind: "deployment" })
		assert.deepEqual(
			rows.map((row) => row.workloadName),
			["checkout-api", "orphan", "api"],
		)
		const orphan = rows[1]!
		assert.strictEqual(orphan.podCount, 0)
		assert.strictEqual(orphan.shortfall, 2)
	})

	it("reads the latest replica gauges and sums restarts per container, not per sample", async () => {
		const [checkout] = await run({ kind: "deployment", workloadNames: ["checkout-api"] })
		assert.isDefined(checkout)
		assert.strictEqual(checkout!.desiredReplicas, 5)
		assert.strictEqual(checkout!.readyReplicas, 2)
		assert.strictEqual(checkout!.shortfall, 3)
		assert.isAbove(checkout!.replicaSamples, 0)
		// 0 → 4 on pod a's app, 10 → 12 on b's app, 3 → 8 on b's worker, 5 → 5 on the sidecar;
		// the other org's 500 is excluded.
		assert.strictEqual(checkout!.restarts, 11)
		// a's OOM kill is the latest restart; b's worker errored earlier.
		assert.strictEqual(checkout!.lastTerminatedReason, "OOMKilled")
		assert.strictEqual(checkout!.podCount, 2)
		// Only pod a still reports at the window's end.
		assert.closeTo(checkout!.cpuUsage, 0.2, 1e-9)
		assert.closeTo(checkout!.peakMemoryLimitPct, 0.38, 1e-9)
	})

	it("reports the worst pod's peak, not where it ended", async () => {
		const [api] = await run({ kind: "deployment", workloadNames: ["api"] })
		assert.closeTo(api!.peakCpuLimitPct, 0.93, 1e-9)
		assert.closeTo(api!.saturation, 0.93, 1e-9)
		assert.strictEqual(api!.shortfall, 0)
		assert.strictEqual(api!.restarts, 9)
		// c's Error is newer than d's OOM kills, whatever order the series are read in.
		assert.strictEqual(api!.lastTerminatedReason, "Error")
	})

	it("lists jobs by failures, without calling a running job short of replicas", async () => {
		const rows = await run({ kind: "job" })
		assert.deepEqual(
			rows.map((row) => [row.workloadName, row.failedPods, row.readyReplicas, row.shortfall]),
			[
				["broken", 2, 0, 0],
				["nightly", 0, 1, 0],
			],
		)
	})

	it("lists only workloads with a matching pod when filtering by compute type, keeping their replica gauges", async () => {
		const rows = await run({ kind: "deployment", computeTypes: ["fargate"] })
		// orphan has no pods and checkout-api's pods carry no compute type: neither may leak in.
		// api's restarts count only its Fargate pod, not the node pod's OOM kills.
		assert.deepEqual(
			rows.map((row) => [
				row.workloadName,
				row.desiredReplicas,
				row.podCount,
				row.restarts,
				row.lastTerminatedReason,
			]),
			[["api", 3, 1, 2, "Error"]],
		)
	})
})
