import { describe, expect, it } from "vitest"

import type { GcpInfraServiceId } from "@maple/domain/gcp-infra"
import type { V2GcpConnector } from "@maple/domain/http/v2"

import {
	GCP_DATABASE_RULES,
	GCP_SERVICE_RULES,
	GCP_SUBSCRIPTION_RULES,
	GCP_WORKLOAD_RULES,
	NO_GCP_SPARKS,
	gcpBacklogGrowth,
	gcpConnectionShare,
	gcpListRows,
	gcpListScope,
	gcpProjectCounts,
	gcpProjectHealth,
	gcpProjectShares,
	gcpProjects,
	gcpQueryInsightsOff,
	gcpRequestedView,
	gcpRowsIn,
	gcpSparklineBucketSeconds,
	gcpSparklineServices,
	gcpSparks,
	gcpViewCounts,
	gcpViewFailed,
	gcpViews,
	rowHealth,
	sortByAttention,
	type GcpFleetRead,
	type GcpSparks,
} from "./list-model"
import type { GcpCloudSqlInstance } from "./inventory"
import { gcpWorkloadId, type GcpMetricPoint } from "./tabs"

const point = (
	keys: ReadonlyArray<string>,
	metric: string,
	label: string,
	total: number,
	samples = 1,
): GcpMetricPoint => ({ keys, metric, label, total, samples })

const read = (service: GcpInfraServiceId, points: ReadonlyArray<GcpMetricPoint>): GcpFleetRead => ({
	service,
	points,
	failed: false,
})

/** The fleet's window: a day. */
const DAY = 86_400

const RUN = "gcp.cloud_run"
const run = (
	name: string,
	project: string,
	signals: { ok?: number; c4xx?: number; c5xx?: number; p95?: number; billable?: number },
) => {
	const keys = [name, project, "us-central1"]
	return [
		point(keys, `${RUN}.requests`, "2xx", signals.ok ?? 0),
		point(keys, `${RUN}.requests`, "4xx", signals.c4xx ?? 0),
		point(keys, `${RUN}.requests`, "5xx", signals.c5xx ?? 0),
		...(signals.p95 === undefined ? [] : [point(keys, `${RUN}.request.duration`, "0.95", signals.p95)]),
		point(keys, `${RUN}.container.billable_time`, "", signals.billable ?? 0),
	]
}

const serviceRows = (points: ReadonlyArray<GcpMetricPoint>, functions: ReadonlyArray<GcpMetricPoint> = []) =>
	gcpListRows([read("cloudRun", points), read("cloudFunctions", functions)], NO_GCP_SPARKS, DAY).services

const names = (rows: ReadonlyArray<{ name: string }>) => rows.map((row) => row.name)

describe("services", () => {
	const rows = serviceRows(
		[
			...run("checkout-api", "acme-prod", { ok: 9_660, c5xx: 340, p95: 1.8 }),
			...run("search", "acme-prod", { ok: 8_000, p95: 1.2 }),
			...run("web-frontend", "acme-prod", { ok: 20_000, c4xx: 400, p95: 0.1 }),
			// Half an instance billed all day without a request.
			...run("legacy-export", "acme-prod", { billable: 43_200 }),
			// A deploy's startup check: five billed minutes, no requests.
			...run("deploy-blip", "acme-prod", { billable: 300 }),
			// Too few requests to rate: half failing is two requests.
			...run("canary", "acme-staging", { ok: 2, c5xx: 2 }),
		],
		[
			point(["image-resize", "acme-data", "europe-west1"], "gcp.cloud_functions.executions", "ok", 900),
			point(
				["image-resize", "acme-data", "europe-west1"],
				"gcp.cloud_functions.executions",
				"crash",
				80,
			),
			point(
				["image-resize", "acme-data", "europe-west1"],
				"gcp.cloud_functions.executions",
				"timeout",
				20,
			),
		],
	)
	const health = (name: string) =>
		rowHealth(GCP_SERVICE_RULES, rows.find((row) => row.name === name) ?? rows[0])

	it("merges Cloud Run services and 1st gen functions into one list", () => {
		expect(rows.map((row) => [row.name, row.service])).toContainEqual(["image-resize", "cloudFunctions"])
		expect(rows.find((row) => row.name === "image-resize")).toMatchObject({
			requests: 1000,
			failed: 100,
			project: "acme-data",
			region: "europe-west1",
		})
	})

	it("rates each service by its worst signal", () => {
		expect(health("checkout-api")).toBe("serving5xx")
		expect(health("image-resize")).toBe("serving5xx")
		expect(health("search")).toBe("slow")
		expect(health("legacy-export")).toBe("idle")
		expect(health("web-frontend")).toBe("ok")
		expect(health("canary")).toBe("ok")
		expect(health("deploy-blip")).toBe("ok")
	})

	it("scopes slow by latency alone, also when the service serves 5xx", () => {
		const slow = rows.filter((row) => GCP_SERVICE_RULES.inScope(row, "slow"))
		expect(names(slow).toSorted()).toEqual(["checkout-api", "search"])
	})

	it("lists problems first, then by requests", () => {
		expect(names(sortByAttention(GCP_SERVICE_RULES, rows))).toEqual([
			"checkout-api",
			"image-resize",
			"search",
			"legacy-export",
			"web-frontend",
			"canary",
			"deploy-blip",
		])
	})
})

describe("Pub/Sub subscriptions", () => {
	const SUB = "gcp.pubsub.subscription"
	const keys = (name: string) => [name, "acme-prod"]
	const sparks: GcpSparks = new Map([
		[
			gcpWorkloadId(keys("orders-fulfil")),
			new Map([[`${SUB}.undelivered_messages`, [2_000, 9_000, 48_000]]]),
		],
		// A batch consumer: a big backlog that stays put.
		[gcpWorkloadId(keys("analytics")), new Map([[`${SUB}.undelivered_messages`, [3_000, 3_200, 3_100]]])],
		// Small numbers: 4 to 40 is not a growing backlog.
		[gcpWorkloadId(keys("webhooks")), new Map([[`${SUB}.undelivered_messages`, [4, 40]]])],
	])
	const rows = gcpListRows(
		[
			read("pubsub", [
				point(keys("orders-fulfil"), `${SUB}.sent_messages`, "", 210_000),
				point(keys("orders-fulfil"), `${SUB}.push_requests`, "ack", 990),
				point(keys("orders-fulfil"), `${SUB}.push_requests`, "remote_server_5xx", 10),
				point(keys("analytics"), `${SUB}.sent_messages`, "", 920_000),
				point(keys("analytics"), `${SUB}.oldest_unacked_message.age`, "", 660),
				point(keys("webhooks"), `${SUB}.sent_messages`, "", 12_000),
				point(keys("email-send"), `${SUB}.sent_messages`, "", 88_000),
				point(keys("email-send"), `${SUB}.dead_lettered_messages`, "", 3),
			]),
		],
		sparks,
		DAY,
	).pubsub
	const find = (name: string) => rows.find((row) => row.name === name) ?? rows[0]

	it("reads push failures as every attempt not acked, and a pull subscription as none", () => {
		expect(find("orders-fulfil")).toMatchObject({ pushRequests: 1000, pushFailed: 10 })
		expect(find("analytics")).toMatchObject({ pushRequests: 0, pushFailed: 0 })
	})

	it("calls a backlog growing only when it rises by 100 messages and half its start", () => {
		expect(gcpBacklogGrowth(find("orders-fulfil"))).toBe(46_000)
		expect(rowHealth(GCP_SUBSCRIPTION_RULES, find("orders-fulfil"))).toBe("backlogGrowing")
		expect(GCP_SUBSCRIPTION_RULES.inScope(find("analytics"), "backlogGrowing")).toBe(false)
		expect(GCP_SUBSCRIPTION_RULES.inScope(find("webhooks"), "backlogGrowing")).toBe(false)
		// Without a sparkline, there is no growth to judge.
		expect(gcpBacklogGrowth(find("email-send"))).toBeUndefined()
	})

	it("ranks dead-lettering above a stale backlog, and lists problems first", () => {
		expect(rowHealth(GCP_SUBSCRIPTION_RULES, find("analytics"))).toBe("stale")
		expect(rowHealth(GCP_SUBSCRIPTION_RULES, find("email-send"))).toBe("deadLettering")
		expect(names(sortByAttention(GCP_SUBSCRIPTION_RULES, rows))).toEqual([
			"orders-fulfil",
			"email-send",
			"analytics",
			"webhooks",
		])
	})
})

describe("Cloud SQL instances", () => {
	const DB = "gcp.cloud_sql"
	const keysOf = (name: string) => [`acme-prod:${name}`, "acme-prod", "us-central1"]
	const db = (
		name: string,
		use: {
			cpu?: number
			disk?: number
			connections?: number
			idleInTransaction?: number
			lag?: number
			p95?: number
			queries?: number
			transactionIds?: number
		},
	) => {
		const keys = keysOf(name)
		const gauge = (metric: string, label: string, value: number | undefined) =>
			value === undefined ? [] : [point(keys, metric, label, value * 2, 2)]
		return [
			...gauge(`${DB}.cpu.utilization`, "", use.cpu ?? 0.2),
			...gauge(`${DB}.disk.utilization`, "", use.disk ?? 0.3),
			...gauge(`${DB}.connection.count`, "", use.connections),
			...gauge(`${DB}.postgresql.connection.count`, "idle_in_transaction", use.idleInTransaction),
			...gauge(`${DB}.replication.lag`, "", use.lag),
			...gauge(`${DB}.query.duration`, "0.95", use.p95),
			...gauge(`${DB}.postgresql.transaction_id.utilization`, "", use.transactionIds),
			...(use.queries === undefined ? [] : [point(keys, `${DB}.queries`, "", use.queries)]),
		]
	}
	const instance = (name: string, settings: Partial<GcpCloudSqlInstance> = {}): GcpCloudSqlInstance => ({
		id: `acme-prod:${name}`,
		name,
		databaseVersion: "POSTGRES_15",
		edition: "ENTERPRISE",
		tier: "db-custom-4-16384",
		cpus: 4,
		memoryGb: 16,
		availabilityType: "REGIONAL",
		primary: null,
		diskSizeGb: 500,
		queryInsightsEnabled: true,
		maxConnections: 100,
		maxConnectionsSource: "default",
		...settings,
	})
	const rowsOf = (points: ReadonlyArray<GcpMetricPoint>, instances?: ReadonlyArray<GcpCloudSqlInstance>) =>
		gcpListRows([read("cloudSql", points)], NO_GCP_SPARKS, DAY, instances).cloudSql

	it("names an instance without its project and reads its connections and query insights", () => {
		const [row] = rowsOf(
			db("orders-db", { connections: 97, idleInTransaction: 38, p95: 0.34, queries: 29_100 }),
		)
		expect(row).toMatchObject({
			name: "orders-db",
			connections: 97,
			idleInTransaction: 38,
			queryP95: 0.34,
			queries: 29_100,
		})
	})

	it("has no query count for an instance Query Insights reports nothing for", () => {
		expect(rowsOf(db("users-mysql", {}))[0].queries).toBeUndefined()
	})

	it("folds a read replica into its primary, with its lag", () => {
		const rows = rowsOf(
			[...db("orders-db", {}), ...db("orders-db-replica-1", { lag: 4 })],
			[instance("orders-db"), instance("orders-db-replica-1", { primary: "acme-prod:orders-db" })],
		)
		expect(names(rows)).toEqual(["orders-db"])
		expect(rows[0].replicas).toEqual([{ name: "orders-db-replica-1", lagSeconds: 4 }])
	})

	it("keeps a replica's own row while the inventory is unknown, and rates its lag", () => {
		const rows = rowsOf([...db("orders-db", {}), ...db("orders-db-replica-1", { lag: 31 })])
		expect(names(rows)).toEqual(["orders-db", "orders-db-replica-1"])
		expect(rowHealth(GCP_DATABASE_RULES, rows[1])).toBe("replicaLag")
	})

	it("rates a primary by its folded replica's lag", () => {
		const rows = rowsOf(
			[...db("orders-db", {}), ...db("orders-db-replica-1", { lag: 31 })],
			[instance("orders-db"), instance("orders-db-replica-1", { primary: "acme-prod:orders-db" })],
		)
		expect(rowHealth(GCP_DATABASE_RULES, rows[0])).toBe("replicaLag")
	})

	it("puts an instance at a limit when its connections reach 90% of max_connections", () => {
		const points = [...db("orders-db", { connections: 97 }), ...db("analytics-pg", { connections: 97 })]
		const rows = rowsOf(points, [
			instance("orders-db"),
			instance("analytics-pg", { maxConnections: 200 }),
		])
		expect(gcpConnectionShare(rows[0])).toBeCloseTo(0.97)
		expect(rows.map((row) => rowHealth(GCP_DATABASE_RULES, row))).toEqual(["atLimit", "ok"])
	})

	it("cannot rate connections without a known max_connections", () => {
		const [row] = rowsOf(db("users-mysql", { connections: 97 }), [
			instance("users-mysql", { maxConnections: null }),
		])
		expect(gcpConnectionShare(row)).toBeUndefined()
		expect(rowHealth(GCP_DATABASE_RULES, row)).toBe("ok")
	})

	it("flags transaction IDs half used toward wraparound, before a slow p95", () => {
		const rows = rowsOf([
			...db("old-pg", { transactionIds: 0.55, p95: 2.4 }),
			...db("young-pg", { transactionIds: 0.18 }),
		])
		expect(rows.map((row) => rowHealth(GCP_DATABASE_RULES, row))).toEqual(["wraparound", "ok"])
	})

	it("rates by the worst signal and lists the instance closest to a limit first", () => {
		const rows = rowsOf(
			[
				...db("users-mysql", { cpu: 0.23, disk: 0.34 }),
				...db("analytics-pg", { cpu: 0.41, disk: 0.88, p95: 2.4 }),
				...db("orders-db", { cpu: 0.62, disk: 0.71, connections: 97 }),
				...db("staging-pg", { cpu: 0.04, disk: 0.85 }),
			],
			[
				instance("users-mysql", { databaseVersion: "MYSQL_8_0", maxConnections: null }),
				instance("analytics-pg"),
				instance("orders-db"),
				instance("staging-pg"),
			],
		)
		expect(rows.map((row) => [row.name, rowHealth(GCP_DATABASE_RULES, row)])).toEqual([
			["users-mysql", "ok"],
			["analytics-pg", "slow"],
			["orders-db", "atLimit"],
			["staging-pg", "fillingUp"],
		])
		expect(names(sortByAttention(GCP_DATABASE_RULES, rows))).toEqual([
			"orders-db",
			"analytics-pg",
			"staging-pg",
			"users-mysql",
		])
	})

	it("says Query Insights is off only for a PostgreSQL instance the inventory says so of", () => {
		const rows = rowsOf(
			[...db("staging-pg", {}), ...db("users-mysql", {}), ...db("unknown-pg", {})],
			[
				instance("staging-pg", { queryInsightsEnabled: false }),
				instance("users-mysql", { databaseVersion: "MYSQL_8_0", queryInsightsEnabled: false }),
			],
		)
		expect(rows.map(gcpQueryInsightsOff)).toEqual([true, false, false])
	})
})

describe("GKE, VMs and URL maps", () => {
	it("scopes a workload by its busiest limit and its error rate", () => {
		const vm = (name: string, cpu: number) =>
			point([name, "acme-prod", "us-central1-a"], "gcp.gce.cpu.utilization", "", cpu)
		const rows = gcpListRows(
			[read("computeEngine", [vm("idle", 0.1), vm("hot", 0.7), vm("full", 0.95)])],
			NO_GCP_SPARKS,
			DAY,
		).computeEngine
		expect(rows.map((row) => rowHealth(GCP_WORKLOAD_RULES, row))).toEqual(["ok", "hot", "atLimit"])
		expect(names(sortByAttention(GCP_WORKLOAD_RULES, rows))).toEqual(["full", "hot", "idle"])
	})
})

describe("views", () => {
	it("reads a link from before the views", () => {
		expect(gcpRequestedView(undefined, "cloudRun")).toBe("services")
		expect(gcpRequestedView(undefined, "cloudFunctions")).toBe("services")
		expect(gcpRequestedView(undefined, "pubsub")).toBe("pubsub")
		expect(gcpRequestedView(undefined, "resources")).toBe("resources")
		expect(gcpRequestedView("cloudSql", "cloudRun")).toBe("cloudSql")
		expect(gcpRequestedView("nonsense", undefined)).toBeUndefined()
		expect(gcpRequestedView(undefined, undefined)).toBeUndefined()
	})

	const counts = { services: 7, pubsub: 4, cloudSql: 0, gke: 0, computeEngine: 0, loadBalancing: 0 }

	it("shows the views with rows, then the inventory, and the first by default", () => {
		expect(gcpViews(counts, undefined, true)).toEqual({
			views: ["services", "pubsub", "resources"],
			view: "services",
		})
		expect(gcpViews({ ...counts, services: 0 }, undefined, true).view).toBe("pubsub")
	})

	it("keeps a requested view that is empty in the window", () => {
		expect(gcpViews(counts, "cloudSql", true)).toEqual({
			views: ["services", "pubsub", "cloudSql", "resources"],
			view: "cloudSql",
		})
	})

	it("leaves the inventory out while no connection collects, also when it is requested", () => {
		expect(gcpViews(counts, "resources", false)).toEqual({
			views: ["services", "pubsub"],
			view: "services",
		})
	})

	it("shows only the requested view while the fleet loads", () => {
		expect(gcpViews(null, "pubsub", false)).toEqual({ views: ["pubsub"], view: "pubsub" })
		expect(gcpViews(null, undefined, false)).toEqual({ views: [], view: "services" })
		expect(gcpViews(null, undefined, true)).toEqual({ views: [], view: "services" })
		expect(gcpViews(null, "resources", true)).toEqual({ views: ["resources"], view: "resources" })
	})

	it("tells a view whose query failed from an empty one", () => {
		const fleet = [read("cloudRun", []), { ...read("cloudFunctions", []), failed: true }]
		expect(gcpViewFailed(fleet, "services")).toBe(true)
		expect(gcpViewFailed(fleet, "pubsub")).toBe(false)
	})
})

describe("projects", () => {
	const rows = gcpListRows(
		[
			read("cloudRun", [
				...run("checkout-api", "acme-prod", { ok: 880 }),
				...run("web-frontend", "acme-prod", { ok: 0 }),
				...run("search", "acme-staging", { ok: 10 }),
			]),
			read("cloudFunctions", [
				point(
					["image-resize", "acme-data", "europe-west1"],
					"gcp.cloud_functions.executions",
					"ok",
					110,
				),
			]),
			read("cloudSql", [
				point(
					["acme-prod:orders-db", "acme-prod", "us-central1"],
					"gcp.cloud_sql.cpu.utilization",
					"",
					0.5,
				),
				point(
					["acme-data:analytics-pg", "acme-data", "us-central1"],
					"gcp.cloud_sql.cpu.utilization",
					"",
					0.5,
				),
			]),
		],
		NO_GCP_SPARKS,
		DAY,
	)

	it("lists the projects with the most workloads first", () => {
		expect(gcpProjects(rows)).toEqual(["acme-prod", "acme-data", "acme-staging"])
	})

	it("shares a view's volume between projects", () => {
		expect(Object.fromEntries(gcpProjectShares(rows, "services"))).toEqual({
			"acme-prod": 0.88,
			"acme-data": 0.11,
			"acme-staging": 0.01,
		})
		// No volume to weigh: one share per instance.
		expect(Object.fromEntries(gcpProjectShares(rows, "cloudSql"))).toEqual({
			"acme-prod": 0.5,
			"acme-data": 0.5,
		})
	})

	it("counts what a project holds, the current view first", () => {
		expect(gcpProjectCounts(rows, "acme-prod", "services")).toBe("2 services · 1 database")
		expect(gcpProjectCounts(rows, "acme-prod", "cloudSql")).toBe("1 database · 2 services")
		expect(gcpProjectCounts(rows, "acme-staging", "cloudSql")).toBe("0 databases · 1 service")
	})

	it("scopes every view to one project and region", () => {
		expect(gcpViewCounts(gcpRowsIn(rows, { project: "acme-data" }))).toMatchObject({
			services: 1,
			cloudSql: 1,
		})
		expect(gcpViewCounts(gcpRowsIn(rows, { region: "europe-west1" }))).toMatchObject({
			services: 1,
			cloudSql: 0,
		})
	})

	it("scopes the page to a project it knows, and resolves the view within it", () => {
		const scoped = gcpListScope(rows, { project: "acme-staging" }, false)
		expect(scoped).toMatchObject({ project: "acme-staging", views: ["services"], view: "services" })
		expect(gcpListScope(rows, { project: "acme-data" }, false).views).toEqual(["services", "cloudSql"])
		// A project from another organization's link is no scope.
		expect(gcpListScope(rows, { project: "elsewhere" }, false).project).toBeUndefined()
		expect(gcpListScope(null, { view: "pubsub" }, false)).toMatchObject({ counts: null, view: "pubsub" })
	})

	it("takes a project's health from a connection of that project alone", () => {
		const NOW = Date.parse("2026-10-08T12:00:00.000Z")
		const connector = (
			scope_type: V2GcpConnector["scope_type"],
			scope_id: string,
			minutesAgo: number,
		) => ({
			scope_type,
			scope_id,
			metrics_enabled: true,
			last_metrics_received_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
			last_metrics_error: null,
			discovered_project_count: 0,
			last_resources_error: null,
			applied_metrics_enabled: true,
			setup_reported_at: "2026-10-01T00:00:00.000Z",
			created_at: "2026-10-01T00:00:00.000Z",
		})
		const health = gcpProjectHealth(
			[
				connector("project", "acme-prod", 2),
				connector("project", "acme-data", 45),
				connector("folder", "1234", 45),
			],
			NOW,
		)
		expect(health.get("acme-prod")?.tone).toBe("ok")
		expect(health.get("acme-data")).toEqual({ tone: "warn", message: "metrics stalled" })
		expect(health.has("1234")).toBe(false)
	})
})

describe("sparklines", () => {
	it("reads sparklines only for the lists that draw them", () => {
		expect(gcpSparklineServices("services")).toEqual(["cloudRun", "cloudFunctions"])
		expect(gcpSparklineServices("pubsub")).toEqual(["pubsub"])
		expect(gcpSparklineServices("cloudSql")).toEqual(["cloudSql"])
		expect(gcpSparklineServices("resources")).toEqual([])
	})

	it("aims for 24 buckets of whole minutes", () => {
		expect(gcpSparklineBucketSeconds("2026-10-14 00:00:00", "2026-10-14 12:00:00")).toBe(1800)
		expect(gcpSparklineBucketSeconds("2026-10-14 00:00:00", "2026-10-14 00:15:00")).toBe(60)
	})

	it("fills a counter's quiet buckets with zeros and leaves a gauge's gaps out", () => {
		const keys = ["orders-fulfil", "acme-prod"]
		const sparks = gcpSparks(
			[
				{
					service: "pubsub",
					points: [
						{
							keys,
							bucket: "2026-10-14T00:00:00.000Z",
							metric: "gcp.pubsub.subscription.sent_messages",
							total: 5,
							samples: 30,
						},
						{
							keys,
							bucket: "2026-10-14T01:00:00.000Z",
							metric: "gcp.pubsub.subscription.sent_messages",
							total: 7,
							samples: 30,
						},
						{
							keys,
							bucket: "2026-10-14T01:00:00.000Z",
							metric: "gcp.pubsub.subscription.undelivered_messages",
							total: 300,
							samples: 30,
						},
						{
							keys,
							bucket: "2026-10-14T00:00:00.000Z",
							metric: "gcp.pubsub.subscription.undelivered_messages",
							total: 60,
							samples: 30,
						},
					],
				},
			],
			{ startTime: "2026-10-14 00:00:00", endTime: "2026-10-14 01:30:00", bucketSeconds: 1800 },
		)
		const series = sparks.get(gcpWorkloadId(keys))
		expect(series?.get("gcp.pubsub.subscription.sent_messages")).toEqual([5, 0, 7, 0])
		expect(series?.get("gcp.pubsub.subscription.undelivered_messages")).toEqual([2, 10])
	})
})
