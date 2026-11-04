/**
 * How a widget's data source is served, and which telemetry families that reads, so
 * a scoped API key is served only the tiles it could have queried itself. The scope
 * gate and the executor both branch on `widgetReadPath`, so a source can never be
 * gated as one path and run as another.
 */
import { TELEMETRY_READ_FAMILIES } from "@maple/domain/http/v2"
import {
	dataSourceQuerySet,
	MARKDOWN_STATIC_ENDPOINT,
	QUERY_RESULT_ENDPOINTS,
	RAW_SQL_ENDPOINT,
	toWidgetRequest,
	type WidgetQuerySet,
	type WidgetRequest,
} from "@maple/widgets/dashboard"
import type { DashboardDocument } from "@maple/domain/http"
import { Array as Arr } from "effect"
import { routeEndpointPlan, type RouteEndpointPlan, type TelemetryReadFamily } from "./route-endpoint-plans"

export type { TelemetryReadFamily }

type WidgetDataSource = DashboardDocument["widgets"][number]["dataSource"]

const ALL_FAMILIES: ReadonlyArray<TelemetryReadFamily> = TELEMETRY_READ_FAMILIES

const isFamily = (value: unknown): value is TelemetryReadFamily =>
	Arr.some(ALL_FAMILIES, (family) => family === value)

export type WidgetReadPath =
	| { readonly _tag: "Static" }
	| { readonly _tag: "QuerySet"; readonly request: WidgetRequest; readonly querySet: WidgetQuerySet }
	| { readonly _tag: "RawSql"; readonly request: WidgetRequest }
	| { readonly _tag: "Route"; readonly request: WidgetRequest; readonly plan: RouteEndpointPlan }
	| { readonly _tag: "Unservable"; readonly request: WidgetRequest }

/**
 * Classified from the lowered request, not the stored shape: a route-shaped
 * `raw_sql_chart` source lowers to raw SQL and is gated as raw SQL.
 */
export const widgetReadPath = (dataSource: WidgetDataSource | undefined): WidgetReadPath => {
	const request = dataSource === undefined ? null : toWidgetRequest(dataSource)
	if (request === null || request.endpoint === MARKDOWN_STATIC_ENDPOINT) return { _tag: "Static" }
	if (request.endpoint === RAW_SQL_ENDPOINT) return { _tag: "RawSql", request }
	const querySet = dataSourceQuerySet(dataSource)
	if (querySet !== null && request.endpoint === QUERY_RESULT_ENDPOINTS[querySet.resultShape]) {
		return { _tag: "QuerySet", request, querySet }
	}
	const plan = routeEndpointPlan(request.endpoint)
	return plan === undefined ? { _tag: "Unservable", request } : { _tag: "Route", request, plan }
}

/** Raw SQL and query sets on other sources need all three; a route with no plan is refused as unsupported. */
export const readPathFamilies = (path: WidgetReadPath): ReadonlyArray<TelemetryReadFamily> => {
	switch (path._tag) {
		case "Static":
		case "Unservable":
			return []
		case "RawSql":
			return ALL_FAMILIES
		case "QuerySet":
			return Arr.dedupe(
				Arr.flatMap(path.querySet.queries, (query) =>
					isFamily(query.dataSource) ? [query.dataSource] : ALL_FAMILIES,
				),
			)
		case "Route":
			return path.plan.families
	}
}

export const widgetReadFamilies = (
	dataSource: WidgetDataSource | undefined,
): ReadonlyArray<TelemetryReadFamily> => readPathFamilies(widgetReadPath(dataSource))
