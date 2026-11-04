/**
 * Which telemetry families a widget's data source reads, so a scoped API key is
 * served only the tiles it could have queried itself. Raw SQL and query sets on
 * other sources need all three. A route reads what its plan declares; a route with
 * no plan reads nothing and is refused as unsupported, whatever the caller's scopes.
 */
import { TELEMETRY_READ_FAMILIES } from "@maple/domain/http/v2"
import {
	dataSourceEndpoint,
	dataSourceQuerySet,
	dataSourceRawSql,
	MARKDOWN_STATIC_ENDPOINT,
	toWidgetRequest,
} from "@maple/widgets/dashboard"
import type { DashboardDocument } from "@maple/domain/http"
import { Array as Arr } from "effect"
import { ROUTE_ENDPOINT_PLANS, type TelemetryReadFamily } from "./route-endpoint-plans"

export type { TelemetryReadFamily }

type WidgetDataSource = DashboardDocument["widgets"][number]["dataSource"]

const ALL_FAMILIES: ReadonlyArray<TelemetryReadFamily> = TELEMETRY_READ_FAMILIES

const isFamily = (value: unknown): value is TelemetryReadFamily =>
	Arr.some(ALL_FAMILIES, (family) => family === value)

export const widgetReadFamilies = (
	dataSource: WidgetDataSource | undefined,
): ReadonlyArray<TelemetryReadFamily> => {
	if (dataSource === undefined) return []
	if (dataSourceRawSql(dataSource) !== null) return ALL_FAMILIES
	const querySet = dataSourceQuerySet(dataSource)
	if (querySet !== null) {
		return Arr.dedupe(
			Arr.flatMap(querySet.queries, (query) =>
				isFamily(query.dataSource) ? [query.dataSource] : ALL_FAMILIES,
			),
		)
	}
	const lowered = toWidgetRequest(dataSource)
	if (lowered === null || lowered.endpoint === MARKDOWN_STATIC_ENDPOINT) return []
	const endpoint = dataSourceEndpoint(dataSource) ?? lowered.endpoint
	return ROUTE_ENDPOINT_PLANS[endpoint]?.families ?? []
}
