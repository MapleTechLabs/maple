/**
 * Which telemetry families a widget's data source reads, so a scoped API key is
 * served only the tiles it could have queried itself. Anything not known to stay
 * inside one family (raw SQL, product events, an unlisted route) needs all three.
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

export type TelemetryReadFamily = (typeof TELEMETRY_READ_FAMILIES)[number]

type WidgetDataSource = DashboardDocument["widgets"][number]["dataSource"]

const ALL_FAMILIES: ReadonlyArray<TelemetryReadFamily> = TELEMETRY_READ_FAMILIES

// The route endpoints `ROUTE_ENDPOINT_PLANS` serves. Error events derive from spans and logs.
const ROUTE_ENDPOINT_FAMILIES = new Map<string, ReadonlyArray<TelemetryReadFamily>>([
	["errors_by_type", ["traces", "logs"]],
	["errors_summary", ["traces", "logs"]],
	["service_overview", ["traces"]],
	["service_usage", ALL_FAMILIES],
	["list_logs", ["logs"]],
])

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
	return ROUTE_ENDPOINT_FAMILIES.get(endpoint) ?? ALL_FAMILIES
}
