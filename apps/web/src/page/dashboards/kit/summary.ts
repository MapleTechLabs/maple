import type { DashboardDocument } from "@maple/domain/http"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { dataSourceEndpoint, dataSourceQuerySet, dataSourceRawSql } from "@maple/widgets/dashboard"
import { DateTime, Option } from "effect"

export type DashboardDomain = "Traces" | "Logs" | "Errors" | "Metrics" | "Raw SQL"

export type DashboardSortOption = "updated" | "created" | "name-asc" | "name-desc" | "widgets"

export const DASHBOARD_SORT_OPTIONS = [
	"updated",
	"created",
	"name-asc",
	"name-desc",
	"widgets",
] as const satisfies ReadonlyArray<DashboardSortOption>

export const isDashboardSortOption = (value: string): value is DashboardSortOption =>
	DASHBOARD_SORT_OPTIONS.some((option) => option === value)

const ENDPOINT_DOMAIN = new Map<string, DashboardDomain>([
	["list_traces", "Traces"],
	["traces_facets", "Traces"],
	["traces_duration_stats", "Traces"],
	["service_overview", "Traces"],
	["service_overview_time_series", "Traces"],
	["service_apdex_time_series", "Traces"],
	["services_facets", "Traces"],
	["service_usage", "Traces"],
	["list_logs", "Logs"],
	["logs_count", "Logs"],
	["logs_facets", "Logs"],
	["errors_summary", "Errors"],
	["errors_by_type", "Errors"],
	["error_detail_traces", "Errors"],
	["errors_facets", "Errors"],
	["error_rate_by_service", "Errors"],
	["list_metrics", "Metrics"],
	["metrics_summary", "Metrics"],
	["custom_timeseries", "Metrics"],
	["custom_breakdown", "Metrics"],
])

const DRAFT_SOURCE_DOMAIN = new Map<string, DashboardDomain>([
	["traces", "Traces"],
	["logs", "Logs"],
	["metrics", "Metrics"],
])

const DEFAULT_QUERY_DOMAIN: DashboardDomain = "Traces"
const DOMAIN_ORDER: ReadonlyArray<DashboardDomain> = ["Traces", "Logs", "Errors", "Metrics", "Raw SQL"]
const MAX_DOMAIN_TERMS = 2

const widgetDomains = (dataSource: unknown): ReadonlyArray<DashboardDomain> => {
	if (dataSourceRawSql(dataSource) !== null) return ["Raw SQL"]
	const querySet = dataSourceQuerySet(dataSource)
	if (querySet !== null && querySet.queries.length > 0) {
		return querySet.queries.flatMap((query) => {
			const domain = DRAFT_SOURCE_DOMAIN.get(query?.dataSource ?? "")
			return domain === undefined ? [] : [domain]
		})
	}
	const endpoint = dataSourceEndpoint(dataSource)
	if (endpoint !== null) {
		const domain = ENDPOINT_DOMAIN.get(endpoint)
		if (domain !== undefined) return [domain]
	}
	return querySet === null ? [] : [DEFAULT_QUERY_DOMAIN]
}

export const dashboardDomains = (dashboard: DashboardDocument): ReadonlyArray<DashboardDomain> => {
	const found = new Set(dashboard.widgets.flatMap((widget) => widgetDomains(widget.dataSource)))
	return DOMAIN_ORDER.filter((domain) => found.has(domain))
}

export const readsFromLabel = (dashboard: DashboardDocument): { short: string; full: string } => {
	if (dashboard.widgets.length === 0) return { short: EMPTY_VALUE, full: "No widgets" }
	const domains = dashboardDomains(dashboard)
	if (domains.length === 0) return { short: "static only", full: "Static content only" }
	const full = domains.join(" · ")
	if (domains.length <= MAX_DOMAIN_TERMS) return { short: full, full }
	const shown = domains.slice(0, MAX_DOMAIN_TERMS).join(" · ")
	return { short: `${shown} +${domains.length - MAX_DOMAIN_TERMS}`, full }
}

/** `Date.parse` (lint-banned): NaN for an unparseable value, as the comparators expect. */
export const epochOf = (iso: string): number =>
	Option.match(DateTime.make(iso), { onNone: () => Number.NaN, onSome: DateTime.toEpochMillis })
