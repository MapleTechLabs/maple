import { useMemo, useState } from "react"
import { Schema } from "effect"
import { PortableDashboardDocument } from "@maple/domain/http"
import { ALL_VALUE, resolveDashboardVariableValue, type VariableValues } from "@maple/query-engine"

import { DashboardPage } from "@/components/layout/dashboard-page"
import { VariablesManagerDialog } from "@/components/dashboard-builder/config/variables-manager-dialog"
import {
	DashboardVariablesContext,
	useDashboardVariables,
	type DashboardVariablesContextValue,
	type VariableOptionsState,
} from "@/components/dashboard-builder/dashboard-variables-context"
import { ReadOnlyDashboardView } from "@/components/dashboard-builder/read-only-dashboard-view"
import { VariableSelects } from "@/components/dashboard-builder/toolbar/variable-selects"
import type { DashboardVariable, WidgetDataState, WidgetDisplayConfig } from "@/components/dashboard-builder/types"
import { visualizationFor } from "@/components/dashboard-builder/widgets/types"
import fixture from "@/lab/gcp-dashboard-fixture.json"

// `gcpTemplate.build({})` from @maple/backend, which the web app cannot import. Regenerate after
// changing the template:
//   cd packages/backend && bun -e 'import { gcpTemplate } from "@maple/backend/dashboard-templates/infrastructure/gcp"; await Bun.write("../../apps/web/src/lab/gcp-dashboard-fixture.json", JSON.stringify(gcpTemplate.build({}), null, "\t") + "\n")'
const DASHBOARD = Schema.decodeUnknownSync(PortableDashboardDocument)(fixture)

type Widget = (typeof DASHBOARD.widgets)[number]

interface Resource {
	readonly name: string
	readonly project: string
	readonly region?: string
}

const run = (name: string, project: string, region: string): Resource => ({ name, project, region })
const global = (name: string, project: string): Resource => ({ name, project })

// Workloads differ per tab, so a `service.name` series list is the tab's.
const WORKLOADS = new Map<string, ReadonlyArray<Resource>>(
	Object.entries({
		"cloud-run": [
			run("checkout", "acme-prod", "us-central1"),
			run("storefront", "acme-prod", "europe-west1"),
			run("checkout", "acme-staging", "us-central1"),
		],
		"cloud-functions": [
			run("resize-image", "acme-prod", "us-central1"),
			run("send-receipt", "acme-prod", "europe-west1"),
		],
		gke: [
			run("orders-api", "acme-prod", "us-central1"),
			run("worker", "acme-prod", "us-central1"),
			run("metrics-server", "acme-staging", "europe-west1"),
		],
		"compute-engine": [
			run("bastion", "acme-prod", "us-central1"),
			run("ci-runner", "acme-staging", "europe-west1"),
		],
	}),
)

const GROUPS = new Map<string, ReadonlyArray<Resource>>(
	Object.entries({
		"resource.k8s.cluster.name": [
			run("prod-us", "acme-prod", "us-central1"),
			run("staging-eu", "acme-staging", "europe-west1"),
		],
		"resource.gcp.resource.labels.database_id": [
			run("acme-prod:orders-db", "acme-prod", "us-central1"),
			run("acme-prod:orders-db-replica", "acme-prod", "europe-west1"),
		],
		"resource.gcp.resource.labels.subscription_id": [
			global("orders-fulfilment", "acme-prod"),
			global("receipts", "acme-prod"),
			global("orders-fulfilment", "acme-staging"),
		],
		"resource.gcp.resource.labels.topic_id": [
			global("orders", "acme-prod"),
			global("orders", "acme-staging"),
		],
		"resource.gcp.resource.labels.url_map_name": [
			global("storefront-lb", "acme-prod"),
			global("api-lb", "acme-prod"),
		],
		"attr.gcp.metric.labels.response_code_class": [
			global("2xx", "acme-prod"),
			global("4xx", "acme-prod"),
			global("5xx", "acme-prod"),
		],
	}),
)

const ALL_RESOURCES = [...WORKLOADS.values(), ...GROUPS.values()].flat()
const unique = (values: ReadonlyArray<string | undefined>) =>
	[...new Set(values.filter((value): value is string => value !== undefined))].sort()

// What the metric-sourced variables would list against this data.
const OPTIONS = new Map<string, VariableOptionsState>([
	["project", { options: unique(ALL_RESOURCES.map((r) => r.project)), loading: false }],
	["region", { options: unique(ALL_RESOURCES.map((r) => r.region)), loading: false }],
	["workload", { options: unique([...WORKLOADS.values()].flat().map((r) => r.name)), loading: false }],
])

// A resource passes a variable only when the widget filters on it; a widget that leaves a
// variable out (Region on Pub/Sub) keeps every series whatever is picked.
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

function hash(text: string): number {
	let h = 2166136261
	for (const char of text) h = Math.imul(h ^ char.charCodeAt(0), 16777619)
	return (h >>> 0) / 4294967296
}

function fixtureRows(widget: Widget, values: VariableValues): Array<Record<string, string | number>> {
	if (widget.dataSource.kind !== "query") return []
	const query = widget.dataSource.queries[0]
	const groupBy = query?.groupBy?.[0] ?? ""
	const resources =
		(groupBy === "service.name" ? WORKLOADS.get(widget.tabId ?? "") : GROUPS.get(groupBy)) ?? []
	const filters = [...ATTRIBUTE.keys()].filter((name) => query?.whereClause?.includes(`$${name}`))
	const kept = resources.filter((resource) =>
		filters.every((name) => {
			const selected = values[name]
			return (
				selected === undefined || selected.isAll || ATTRIBUTE.get(name)?.(resource) === selected.value
			)
		}),
	)
	const series = unique(kept.map((resource) => resource.name))
	const [low, high] = RANGES.get(String(widget.display.unit)) ?? [5, 1800]
	return BUCKETS.map((bucket, i) => ({
		bucket,
		...Object.fromEntries(
			series.map((name) => {
				const seed = hash(`${widget.id}/${name}`)
				const wave = 0.5 + 0.35 * Math.sin(i / 5 + seed * 6) + 0.15 * (hash(`${seed}/${i}`) - 0.5)
				return [name, low + (high - low) * Math.min(1, Math.max(0, wave * (0.4 + seed)))]
			}),
		),
	}))
}

function LabWidget({ widget }: { widget: Widget }) {
	const { values } = useDashboardVariables()
	const Visualization = visualizationFor(widget.visualization)
	const dataState = useMemo<WidgetDataState>(
		() => ({ status: "ready", data: fixtureRows(widget, values) }),
		[widget, values],
	)
	return <Visualization dataState={dataState} display={widget.display as WidgetDisplayConfig} mode="view" />
}

/**
 * `/lab/gcp-dashboard` — the Google Cloud template as a board: its tabs, its Project / Region /
 * Workload chips over fixture options, and the variables dialog, with no API.
 */
export function GcpDashboardLab() {
	const [variables, setVariables] = useState<DashboardVariable[]>(
		() => structuredClone(DASHBOARD.variables ?? []) as DashboardVariable[],
	)
	const [selected, setSelected] = useState<Record<string, string>>({})
	const [managing, setManaging] = useState(false)

	const context = useMemo<DashboardVariablesContextValue>(() => {
		const values: VariableValues = {}
		for (const variable of variables) {
			const options = OPTIONS.get(variable.name) ?? { options: [], loading: false }
			const value = resolveDashboardVariableValue(variable, selected[variable.name], options)
			if (value !== undefined) {
				values[variable.name] = { value, isAll: value === ALL_VALUE, options: options.options }
			}
		}
		return {
			variables,
			values,
			optionsByName: Object.fromEntries(OPTIONS),
			setValue: (name, value) => setSelected((prev) => ({ ...prev, [name]: value })),
		}
	}, [variables, selected])

	return (
		<DashboardVariablesContext.Provider value={context}>
			<DashboardPage
				breadcrumbs={[{ label: "Lab", href: "/lab" }, { label: DASHBOARD.name }]}
				headerActions={<VariableSelects onManage={() => setManaging(true)} />}
				fill
			>
				<ReadOnlyDashboardView
					widgets={DASHBOARD.widgets}
					sections={DASHBOARD.sections ?? []}
					renderWidget={LabWidget}
				/>
			</DashboardPage>
			<VariablesManagerDialog
				open={managing}
				onOpenChange={setManaging}
				variables={variables}
				onSave={setVariables}
			/>
		</DashboardVariablesContext.Provider>
	)
}
