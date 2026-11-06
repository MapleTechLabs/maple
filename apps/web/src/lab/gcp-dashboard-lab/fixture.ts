import { DashboardDocument } from "@maple/domain/http"
import type { VariableValues } from "@maple/query-engine"
import fixture from "../gcp-dashboard-fixture.json"
import { Option, Order, Schema, Array as Arr, Record as Rec, String as Str } from "effect"

// The series fixture (WORKLOADS, GROUPS, OPTIONS,
// `fixtureRows`), over the template document as the dashboards view reads it.

export const DASHBOARD_ID = "gcp-lab"

export const DASHBOARD = Schema.decodeUnknownSync(DashboardDocument)({
	...fixture,
	id: DASHBOARD_ID,
	createdAt: "2026-10-01T00:00:00.000Z",
	updatedAt: "2026-10-01T00:00:00.000Z",
	schemaVersion: 3,
})

type Widget = DashboardDocument["widgets"][number]
type Resource = Readonly<{ name: string; project: string; region?: string }>

const run = (name: string, project: string, region: string): Resource => ({ name, project, region })
const global = (name: string, project: string): Resource => ({ name, project })

const WORKLOADS = new Map<string, ReadonlyArray<Resource>>([
	[
		"cloud-run",
		[
			run("checkout", "acme-prod", "us-central1"),
			run("storefront", "acme-prod", "europe-west1"),
			run("checkout", "acme-staging", "us-central1"),
		],
	],
	[
		"cloud-functions",
		[run("resize-image", "acme-prod", "us-central1"), run("send-receipt", "acme-prod", "europe-west1")],
	],
	[
		"gke",
		[
			run("orders-api", "acme-prod", "us-central1"),
			run("worker", "acme-prod", "us-central1"),
			run("metrics-server", "acme-staging", "europe-west1"),
		],
	],
	[
		"compute-engine",
		[run("bastion", "acme-prod", "us-central1"), run("ci-runner", "acme-staging", "europe-west1")],
	],
])

const GROUPS = new Map<string, ReadonlyArray<Resource>>([
	[
		"resource.k8s.cluster.name",
		[run("prod-us", "acme-prod", "us-central1"), run("staging-eu", "acme-staging", "europe-west1")],
	],
	[
		"resource.gcp.resource.labels.database_id",
		[
			run("acme-prod:orders-db", "acme-prod", "us-central1"),
			run("acme-prod:orders-db-replica", "acme-prod", "europe-west1"),
		],
	],
	[
		"resource.gcp.resource.labels.subscription_id",
		[
			global("orders-fulfilment", "acme-prod"),
			global("receipts", "acme-prod"),
			global("orders-fulfilment", "acme-staging"),
		],
	],
	[
		"resource.gcp.resource.labels.topic_id",
		[global("orders", "acme-prod"), global("orders", "acme-staging")],
	],
	[
		"resource.gcp.resource.labels.url_map_name",
		[global("storefront-lb", "acme-prod"), global("api-lb", "acme-prod")],
	],
	[
		"attr.gcp.metric.labels.response_code_class",
		[global("2xx", "acme-prod"), global("4xx", "acme-prod"), global("5xx", "acme-prod")],
	],
])

const ALL_RESOURCES = [...WORKLOADS.values(), ...GROUPS.values()].flat()
const unique = (values: ReadonlyArray<string | undefined>): ReadonlyArray<string> =>
	Arr.sort([...new Set(Arr.filter(values, (value): value is string => value !== undefined))], Order.String)

/** What the metric-sourced variables would list against this data. */
export const OPTIONS = new Map<string, ReadonlyArray<string>>([
	["project", unique(Arr.map(ALL_RESOURCES, (resource) => resource.project))],
	["region", unique(Arr.map(ALL_RESOURCES, (resource) => resource.region))],
	["workload", unique(Arr.map([...WORKLOADS.values()].flat(), (resource) => resource.name))],
])

const ATTRIBUTE = new Map<string, (resource: Resource) => string | undefined>([
	["project", (resource) => resource.project],
	["region", (resource) => resource.region],
	["workload", (resource) => resource.name],
])

const RANGES = new Map<string, readonly [number, number]>([
	["percent", [0.15, 0.85]],
	["bytes", [2e7, 6e8]],
	["duration_s", [0.05, 2]],
])

const BUCKETS = Array.from({ length: 48 }, (_, i) => new Date(Date.UTC(2026, 9, 14, 0, i * 30)).toISOString())

const hash = (text: string): number =>
	(Arr.reduce(Array.from(text), 2166136261, (h, char) =>
		Math.imul(h ^ Option.getOrElse(Str.charCodeAt(char, 0), () => 0), 16777619),
	) >>>
		0) /
	4294967296

/** `fixtureRows`: a resource passes a variable only when the widget's where clause filters on it. */
export const fixtureRows = (
	widget: Widget,
	values: VariableValues,
): ReadonlyArray<Record<string, string | number>> => {
	if (widget.dataSource.kind !== "query") return []
	const query = widget.dataSource.queries[0]
	const groupBy = query?.groupBy?.[0] ?? ""
	const resources =
		(groupBy === "service.name" ? WORKLOADS.get(widget.tabId ?? "") : GROUPS.get(groupBy)) ?? []
	const whereClause = query?.whereClause
	const filters = Arr.filter(
		[...ATTRIBUTE.keys()],
		(name) => whereClause !== undefined && Str.includes(`$${name}`)(whereClause),
	)
	const kept = Arr.filter(resources, (resource) =>
		Arr.every(filters, (name) => {
			const selected = values[name]
			return (
				selected === undefined || selected.isAll || ATTRIBUTE.get(name)?.(resource) === selected.value
			)
		}),
	)
	const series = unique(Arr.map(kept, (resource) => resource.name))
	const [low, high] = RANGES.get(String(widget.display.unit)) ?? [5, 1800]
	return Arr.map(BUCKETS, (bucket, i) => ({
		bucket,
		...Rec.fromEntries(
			Arr.map(series, (name) => {
				const seed = hash(`${widget.id}/${name}`)
				const wave = 0.5 + 0.35 * Math.sin(i / 5 + seed * 6) + 0.15 * (hash(`${seed}/${i}`) - 0.5)
				return [name, low + (high - low) * Math.min(1, Math.max(0, wave * (0.4 + seed)))]
			}),
		),
	}))
}
