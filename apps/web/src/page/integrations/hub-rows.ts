import type { V2DataSource } from "@maple/domain/http/v2"
import { countLabel } from "@maple/ui/lib/format"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Option, Order } from "effect"
import { AsyncData } from "foldkit"
import { isDataIntegration } from "../../route/data-integrations"
import { ENVIRONMENT_LABEL } from "../settings/data-sources/view-parts"
import {
	type AvailableOverview,
	type ConnectedOverview,
	isoMs,
	overviewOf,
	type UnavailableOverview,
} from "./derive"
import {
	CAPABILITIES,
	CATALOG,
	type Capability,
	type CatalogEntry,
	capabilityOf,
	type HubFilter,
	INTEGRATION_CATEGORIES,
} from "./catalog"
import { DATA_SOURCE_KIND_ENTRIES, DATA_SOURCE_KIND_ENTRY, type DataSourceKindEntry } from "../kit/providers"
import type { Model } from "./model"

export type ConnectedRow =
	| Readonly<{
			_tag: "Integration"
			capability: Capability
			entry: CatalogEntry
			overview: ConnectedOverview | UnavailableOverview
			/** The Sources search a connected data integration's row opens; null opens its own page. */
			sourcesQuery: string | null
	  }>
	| Readonly<{ _tag: "DataSource"; capability: "query"; source: V2DataSource; overview: ConnectedOverview }>

export type Shelf =
	| Readonly<{
			_tag: "Integrations"
			label: string
			capability: Capability
			entries: ReadonlyArray<Readonly<{ entry: CatalogEntry; cta: AvailableOverview["cta"] }>>
	  }>
	| Readonly<{
			_tag: "DataSources"
			label: string
			capability: "query"
			kinds: ReadonlyArray<DataSourceKindEntry>
	  }>

const STATE = {
	ok: { health: "healthy", label: "Healthy" },
	error: { health: "attention", label: "Connection error" },
	unknown: { health: "pending", label: "Not checked" },
} as const satisfies Record<
	V2DataSource["status"],
	Readonly<{ health: ConnectedOverview["health"]; label: string }>
>

/** A data source as a connected row: its last connection test, catalog size and kind. */
export const dataSourceOverview = (source: V2DataSource): ConnectedOverview => {
	const checkedAt = isoMs(source.last_checked_at)
	return {
		kind: "connected",
		health: STATE[source.status].health,
		stateLabel: STATE[source.status].label,
		context: `${DATA_SOURCE_KIND_ENTRY[source.kind].name} · ${ENVIRONMENT_LABEL[source.environment]}`,
		stat:
			source.catalog_entry_count === 0
				? null
				: countLabel(source.catalog_entry_count, source.kind === "clerk" ? "resource" : "table"),
		lastSync: checkedAt === null ? null : { verb: "checked", at: checkedAt },
		issue: source.catalog_error === null ? null : "Catalog refresh failed",
	}
}

/** PlanetScale without its OAuth connection is shown from standalone scrape targets. */
const isPlanetscaleConnected = (statuses: Model["statuses"]): boolean =>
	Option.match(AsyncData.getData(statuses.planetscale.data), {
		onNone: () => false,
		onSome: (status) => status.connected,
	})

/**
 * Scrape targets are stored as Prometheus sources, so standalone PlanetScale targets are found under
 * that platform; every other data integration under its own name. (WarpStream is never a connected row.)
 */
const sourcesQueryOf = (
	model: Model,
	entry: CatalogEntry,
	overview: ConnectedOverview | UnavailableOverview,
) =>
	overview.kind !== "connected" || !isDataIntegration(entry.id)
		? null
		: entry.id === "planetscale" && !isPlanetscaleConnected(model.statuses)
			? "Prometheus"
			: entry.name

export const needsAttention = (row: ConnectedRow): boolean =>
	row.overview.kind === "connected" && row.overview.health === "attention"

export const matchesFilter = (filter: HubFilter, row: ConnectedRow): boolean =>
	filter === "all" ? true : filter === "attention" ? needsAttention(row) : row.capability === filter

const byCapability = Order.mapInput(Order.Number, (row: ConnectedRow) => CAPABILITIES.indexOf(row.capability))

/** The data sources to list; `null` while the first read is in flight. A failed refresh keeps the last list. */
const dataSourcesOf = (model: Model): ReadonlyArray<V2DataSource> | null =>
	model.hasDataSources
		? AsyncData.match(model.statuses.dataSources.data, {
				onIdle: () => null,
				onLoading: () => null,
				onRefreshing: (sources) => sources,
				onSuccess: (sources) => sources,
				onFailure: () => [],
				onStale: ({ data }) => data,
			})
		: []

export interface HubRows {
	readonly connected: ReadonlyArray<ConnectedRow>
	/** Status reads still in flight: one skeleton row each. */
	readonly loading: number
	/** The data sources read failed, so their rows are missing, not absent. */
	readonly isDataSourcesFailed: boolean
	readonly shelves: ReadonlyArray<Shelf>
}

export const hubRowsOf = (model: Model): HubRows => {
	const integrations = Arr.map(CATALOG, (entry) => ({
		entry,
		overview: overviewOf(model.statuses, model.nowMs, entry.id),
	}))
	const sources = dataSourcesOf(model)
	const connected = Arr.sort(
		[
			...Arr.flatMap(integrations, ({ entry, overview }): ReadonlyArray<ConnectedRow> =>
				// A deployment with no setup for an integration lists it nowhere.
				overview !== null &&
				overview.kind !== "available" &&
				!(overview.kind === "unavailable" && overview.reason === "not-configured")
					? [
							{
								_tag: "Integration",
								capability: capabilityOf(entry.category),
								entry,
								overview,
								sourcesQuery: sourcesQueryOf(model, entry, overview),
							},
						]
					: [],
			),
			...Arr.map(sources ?? [], (source): ConnectedRow => ({
				_tag: "DataSource",
				capability: "query",
				source,
				overview: dataSourceOverview(source),
			})),
		],
		byCapability,
	)
	const integrationShelves = Arr.map(INTEGRATION_CATEGORIES, (category): Shelf => ({
		_tag: "Integrations",
		label: category.label,
		capability: capabilityOf(category.id),
		entries: Arr.sort(
			Arr.flatMap(integrations, ({ entry, overview }) =>
				entry.category === category.id && overview !== null && overview.kind === "available"
					? [{ entry, cta: overview.cta }]
					: [],
			),
			Order.flip(
				Order.mapInput(Order.Number, (item: { readonly entry: CatalogEntry }) =>
					Number(item.entry.isNew ?? false),
				),
			),
		),
	}))
	// Connecting a data source is admin-only, so members get no cards that lead to a form they cannot save.
	const queryShelf: ReadonlyArray<Shelf> =
		model.hasDataSources && Policy.has(model.grants, "data_sources:manage")
			? [
					{
						_tag: "DataSources",
						label: "Query in place",
						capability: "query",
						kinds: DATA_SOURCE_KIND_ENTRIES,
					},
				]
			: []
	// Query in place sits between the telemetry shelves and the destinations.
	const telemetryCount = Arr.filter(integrationShelves, (shelf) => shelf.capability === "telemetry").length
	return {
		connected,
		isDataSourcesFailed:
			model.hasDataSources &&
			(model.statuses.dataSources.data._tag === "Failure" ||
				model.statuses.dataSources.data._tag === "Stale"),
		loading:
			Arr.filter(integrations, ({ overview }) => overview === null).length + (sources === null ? 1 : 0),
		shelves: Arr.filter(
			[
				...Arr.take(integrationShelves, telemetryCount),
				...queryShelf,
				...Arr.drop(integrationShelves, telemetryCount),
			],
			(shelf) => shelf._tag === "DataSources" || shelf.entries.length > 0,
		),
	}
}

/** The filter chips' counts: connected rows per capability, and those needing attention. */
export const filterCounts = (rows: ReadonlyArray<ConnectedRow>): Record<HubFilter, number> => ({
	all: rows.length,
	telemetry: Arr.filter(rows, (row) => row.capability === "telemetry").length,
	query: Arr.filter(rows, (row) => row.capability === "query").length,
	alerts: Arr.filter(rows, (row) => row.capability === "alerts").length,
	analytics: Arr.filter(rows, (row) => row.capability === "analytics").length,
	security: Arr.filter(rows, (row) => row.capability === "security").length,
	attention: Arr.filter(rows, needsAttention).length,
})

/** The capability filters the hub offers: Query behind its flag, Needs attention while something does. */
export const offeredFilters = (
	model: Pick<Model, "hasDataSources" | "filter">,
	rows: ReadonlyArray<ConnectedRow>,
): ReadonlyArray<HubFilter> =>
	rows.length === 0
		? []
		: [
				"all",
				...Arr.filter(CAPABILITIES, (capability) => capability !== "query" || model.hasDataSources),
				...(Arr.some(rows, needsAttention) ? (["attention"] as const) : []),
			]

/** The filter in force: the chosen one while its chip is offered, else All (it never strands the page). */
export const activeFilter = (
	model: Pick<Model, "hasDataSources" | "filter">,
	rows: ReadonlyArray<ConnectedRow>,
): HubFilter => (offeredFilters(model, rows).includes(model.filter) ? model.filter : "all")
