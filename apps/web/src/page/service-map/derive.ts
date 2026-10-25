import { parseWarehouseDateTime } from "@maple/query-engine"
import { AsyncData } from "foldkit"
import { Option } from "effect"
import type { TimeWindow } from "../../data/time-range"
import { buildSourceGraph, type SourceGraph } from "../../service-map/map/graph"
import type { Focus } from "../../service-map/map/state"
import type { Model } from "./model"

// The pure halves of the service map page and its view.

/** The "All environments" option, kept in the URL so the explicit choice sticks. */
export const ALL_ENVIRONMENTS = "__all__"

/** The map's default window. */
export const DEFAULT_PRESET = "12h"

export type Search = Model["search"]

const environmentsOf = (model: Model): ReadonlyArray<string> =>
	Option.getOrElse(AsyncData.getData(model.facets.data), () => [])

/** Default to production; before facets resolve assume it exists, only a confirmed no-production org shows all. */
export const selectedEnvironment = (model: Model): string => {
	// Ready while any facets answer is held: a refetch waiting, or a failed one over it (`Stale`).
	const isReady = Option.isSome(AsyncData.getData(model.facets.data))
	const hasProduction = environmentsOf(model).includes("production")
	return model.search.environment ?? (isReady && !hasProduction ? ALL_ENVIRONMENTS : "production")
}

export const deploymentEnvOf = (model: Model): string | undefined => {
	const environment = selectedEnvironment(model)
	return environment === ALL_ENVIRONMENTS ? undefined : environment
}

export const environmentItems = (model: Model): ReadonlyArray<{ value: string; label: string }> => [
	{ value: ALL_ENVIRONMENTS, label: "All environments" },
	...environmentsOf(model).map((name) => ({ value: name, label: name })),
]

/** The URL's focus (`focusService`, `focusHops`, `focusMode`). */
export const focusOf = (search: Search): Option.Option<Focus> =>
	search.focusService === undefined
		? Option.none()
		: Option.some({
				serviceId: search.focusService,
				hops: search.focusHops ?? 1,
				mode: search.focusMode ?? "dim",
			})

/** `handleFocusChange`: defaults stay out of the URL. */
export const withFocus = (search: Search, focus: Option.Option<Focus>): Search =>
	Option.match(focus, {
		onNone: () => ({ ...search, focusService: undefined, focusHops: undefined, focusMode: undefined }),
		onSome: (next) => ({
			...search,
			focusService: next.serviceId,
			focusHops: next.hops !== 1 ? next.hops : undefined,
			focusMode: next.mode !== "dim" ? next.mode : undefined,
		}),
	})

export const durationSecondsOf = (window: TimeWindow): number =>
	Math.max(1, (parseWarehouseDateTime(window.endTime) - parseWarehouseDateTime(window.startTime)) / 1000)

const dataOr = <A, E>(data: AsyncData.AsyncData<A, E>, fallback: A): A =>
	Option.getOrElse(AsyncData.getData(data), () => fallback)

const bundleOf = (model: Model) =>
	Option.getOrNull(Option.map(AsyncData.getData(model.bundle.data), (bundle) => bundle.value))

/**
 * The client-side namespace pin: drop out-of-namespace services and everything only they touch,
 * and blank `serviceNamespace` (one namespace has nothing left to group).
 */
export const scopedRows = (model: Model, pinnedNamespace: string | null) => {
	const bundle = bundleOf(model)
	if (bundle === null) return null
	const members =
		pinnedNamespace === null
			? null
			: new Set(
					bundle.overview
						.filter((row) => row.serviceNamespace === pinnedNamespace)
						.map((row) => row.serviceName),
				)
	const isMember = (service: string) => members === null || members.has(service)
	return {
		edges: bundle.edges.filter((edge) => isMember(edge.sourceService) && isMember(edge.targetService)),
		dbEdges: bundle.dbEdges.filter((edge) => isMember(edge.sourceService)),
		overviews:
			members === null
				? bundle.overview
				: bundle.overview
						.filter((row) => isMember(row.serviceName))
						.map((row) => ({ ...row, serviceNamespace: "" })),
		workloads: bundle.workloads.filter((workload) => isMember(workload.serviceName)),
		platforms: bundle.platforms,
	}
}
export type ScopedRows = NonNullable<ReturnType<typeof scopedRows>>

/** `buildFlowElements` over the scoped rows and whichever overlays have landed. */
export const sourceGraphOf = (model: Model, rows: ScopedRows, window: TimeWindow): SourceGraph => {
	const platforms = new Map(rows.platforms.map((row) => [row.serviceName, row.platform]))
	const runtimes = new Map(
		rows.platforms.flatMap((row) => (row.runtime ? [[row.serviceName, row.runtime] as const] : [])),
	)
	const faasNames = new Map(
		rows.platforms.flatMap((row) => (row.faasName ? [[row.serviceName, row.faasName] as const] : [])),
	)
	const inventory = dataOr(model.planetscaleInventory.data, [])
	return buildSourceGraph({
		edges: [...rows.edges],
		dbEdges: [...rows.dbEdges],
		serviceOverviews: [...rows.overviews],
		durationSeconds: durationSecondsOf(window),
		serviceWorkloads: [...rows.workloads],
		platforms,
		runtimes,
		cloudflareServices: Option.match(AsyncData.getData(model.cloudflare.data), {
			onNone: () => [],
			onSome: (stats) => stats.value.services,
		}),
		faasNames,
		planetscaleDatabases: new Map(inventory.map((db) => [db.name.toLowerCase(), db])),
		planetscaleStats: Option.match(AsyncData.getData(model.planetscaleStats.data), {
			onNone: () => [],
			onSome: (stats) => stats.value.databases,
		}),
		hyperdriveConfigs: dataOr(model.hyperdrives.data, []),
	})
}
