import { classifyZone, type ZoneHealth } from "../../../../components/infra/cloudflare/list-model"
import {
	type CloudflareFilterKey,
	type CloudflareFilters,
	filtersFromSearch,
} from "../../../../components/infra/cloudflare/filters"
import { zoneSignalTotals } from "../../../../components/infra/cloudflare/zone-signals"
import { AsyncData } from "foldkit"
import { chartBucketSeconds } from "../../../../charts/infra-metric-series"
import type { TimeWindow } from "../../../../data/time-range"
import type {
	BreakdownDimension,
	BreakdownInput,
	ZoneDetailInput,
	ZoneFacetsInput,
	ZoneRow,
	ZonesInput,
} from "../data"
import { dataOf } from "../list/derive"
import type { Model, ZoneTab } from "./model"

const ZONE_SERVICE_PREFIX = "cloudflare/"
/** Rows the server returns per dimension. */
export const BREAKDOWN_ROW_LIMIT = 100

export const serviceNameOf = (model: Model) => `${ZONE_SERVICE_PREFIX}${model.zoneName}`

export const filtersOf = (model: Model): CloudflareFilters => filtersFromSearch(model.search)

export type DimensionDef = Readonly<{
	id: BreakdownDimension
	tab: string
	column: string
	noun: string
	filterKey: CloudflareFilterKey
	liveDimension?: "host" | "path"
}>

/** `DIMENSIONS`. */
export const DIMENSIONS: ReadonlyArray<DimensionDef> = [
	{ id: "path", tab: "Paths", column: "Path", noun: "paths", filterKey: "paths", liveDimension: "path" },
	{ id: "host", tab: "Hosts", column: "Host", noun: "hosts", filterKey: "hosts", liveDimension: "host" },
	{ id: "country", tab: "Countries", column: "Country", noun: "countries", filterKey: "countries" },
	{ id: "method", tab: "Methods", column: "Method", noun: "methods", filterKey: "methods" },
	{
		id: "statusClass",
		tab: "Status",
		column: "Status class",
		noun: "status classes",
		filterKey: "statusClasses",
	},
	{
		id: "cacheStatus",
		tab: "Cache",
		column: "Cache status",
		noun: "cache statuses",
		filterKey: "cacheStatuses",
	},
]

export const dimensionOf = (model: Model): DimensionDef =>
	DIMENSIONS.find((dimension) => dimension.id === model.dimension) ??
	DIMENSIONS[0] ?? {
		id: "path",
		tab: "Paths",
		column: "Path",
		noun: "paths",
		filterKey: "paths",
	}

/** The filter fields as request fields: absent filters stay absent. */
const filterFields = (filters: CloudflareFilters) => ({
	hosts: filters.hosts,
	cacheStatuses: filters.cacheStatuses,
	statusClasses: filters.statusClasses,
	paths: filters.paths,
	pathContains: filters.pathContains,
	countries: filters.countries,
	methods: filters.methods,
	protocols: filters.protocols,
	deviceTypes: filters.deviceTypes,
})

export type ZoneInputs = Readonly<{
	detail: ZoneDetailInput
	facets: ZoneFacetsInput
	zones: ZonesInput
	breakdown: BreakdownInput
}>

export const inputsOf = (model: Model, window: TimeWindow): ZoneInputs => {
	const filters = filterFields(filtersOf(model))
	const serviceName = serviceNameOf(model)
	const range = { startTime: window.startTime, endTime: window.endTime }
	const detail = {
		serviceName,
		...range,
		bucketSeconds: chartBucketSeconds(window.startTime, window.endTime),
		...filters,
	}
	return {
		detail,
		facets: { serviceName, ...range, ...filters },
		zones: { ...range, ...filters },
		breakdown: { ...detail, dimension: model.dimension, limit: BREAKDOWN_ROW_LIMIT },
	}
}

export type ZoneRailDns = Readonly<{ queries: number; alwaysNxdomain: number }>

/** Null while loading or when the zone has no DNS analytics. */
export const dnsSummaryOf = (model: Model): ZoneRailDns | null => {
	const dns = dataOf(model.dns.data)
	if (dns === null || (dns.names.length === 0 && dns.buckets.length === 0)) return null
	return {
		queries: dns.buckets.reduce((acc, b) => acc + b.queries, 0),
		alwaysNxdomain: dns.names.filter((n) => n.queries > 0 && n.nxdomain >= n.queries).length,
	}
}

/** Null while loading; zero means the dataset is live but quiet. */
export const firewallEventsOf = (model: Model): number | null => {
	const security = dataOf(model.security.data)
	return security === null ? null : security.buckets.reduce((acc, b) => acc + b.events, 0)
}

export const tabsOf = (model: Model): ReadonlyArray<Readonly<{ value: ZoneTab; label: string }>> => {
	const events = firewallEventsOf(model)
	return [
		{ value: "traffic", label: "Traffic" },
		...(dnsSummaryOf(model) === null ? [] : [{ value: "dns" as const, label: "DNS" }]),
		...(events === null || events === 0 ? [] : [{ value: "security" as const, label: "Security" }]),
	]
}

/** The section the page renders: a tab without its dataset falls back to traffic. */
export const sectionOf = (model: Model): ZoneTab => {
	const tab = model.search.tab ?? "traffic"
	if (tab === "dns" && dnsSummaryOf(model) !== null) return "dns"
	const events = firewallEventsOf(model)
	if (tab === "security" && events !== null && events > 0) return "security"
	return "traffic"
}

/** The breakdown panel mounts under the strips once the detail has rows. */
export const needsBreakdown = (model: Model): boolean => {
	if (sectionOf(model) !== "traffic") return false
	const slot = model.detail.data
	if (AsyncData.isRefreshing(slot)) return true
	return AsyncData.isSuccess(slot) && slot.data.statusBuckets.length > 0
}

export const zoneRowOf = (model: Model): ZoneRow | null =>
	dataOf(model.zones.data)?.find((zone) => zone.serviceName === serviceNameOf(model)) ?? null

export type ZoneAccount = Readonly<{ id: string; name: string; multi: boolean; zoneError: string | null }>

export const zoneAccountOf = (model: Model): ZoneAccount | null => {
	const status = dataOf(model.status.data)
	if (status === null) return null
	const accounts = status.accounts ?? []
	const account = accounts.find((a) => a.zones.some((zone) => zone.name === model.zoneName))
	if (account === undefined) return null
	return {
		id: account.accountId,
		name: account.accountName ?? account.accountId,
		multi: accounts.length > 1,
		zoneError: account.zones.find((zone) => zone.name === model.zoneName)?.lastError ?? null,
	}
}

const ZONE_HEALTH_DOT = {
	serving5xx: "bg-severity-error",
	mostly4xx: "bg-severity-warn",
	ok: "bg-severity-info",
	lowVolume: "bg-muted-foreground",
} as const satisfies Record<ZoneHealth, string>

/** `zoneSeverityClass`: the header dot. */
export const severityOf = (model: Model): string | null => {
	const detail = dataOf(model.detail.data)
	if (detail === null) return null
	const totals = zoneSignalTotals(detail.statusBuckets, detail.cacheBuckets)
	return ZONE_HEALTH_DOT[classifyZone(totals.requests, totals.serverErrorRate, totals.clientErrorRate)]
}
