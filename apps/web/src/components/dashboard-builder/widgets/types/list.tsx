import { DEFAULT_LIST_LIMIT, WIDGET_TYPES } from "@maple/domain/http"
import { makeQueryDataSource, makeRouteDataSource } from "@maple/widgets/dashboard"

import { MenuIcon } from "@/components/icons"
import {
	DEFAULT_LIST_COLUMNS,
	toListDataSource,
	type ListColumnDraft,
} from "@/lib/query-builder/list-widget-config"
import { ListWidget } from "@/components/dashboard-builder/widgets/list-widget"
import { listPresets } from "@/components/dashboard-builder/widgets/widget-definitions"
import type { WidgetTypeDefinition } from "@/components/dashboard-builder/widgets/widget-type-registry"
import { createQueryDraft, type QueryBuilderQueryDraft } from "@maple/query-engine/query-builder"
import { buildListEndpointParams, parsePositiveNumber } from "@/lib/query-builder/widget-builder-shared"
import { rowsPresetPreview } from "@/components/dashboard-builder/widgets/types/preset-preview"

/**
 * Raw trace or log rows. The only type that doesn't use the query builder: it is
 * configured by `ListConfigPanel`, so it owns its whole display and its editor
 * state carries a placeholder query the builder never sees.
 */
export const listWidgetType: WidgetTypeDefinition = {
	meta: WIDGET_TYPES.list,
	icon: MenuIcon,
	Renderer: ListWidget,
	queryEditor: "list",
	// Everything a list can be configured with lives in `ListConfigPanel`, beside
	// the preview rather than in the rail.
	ConfigPanel: () => null,
	presets: listPresets,
	PresetPreview: rowsPresetPreview({
		"list-traces": [
			{ serviceName: "api-gw", spanName: "GET /api/users", durationMs: 142, statusCode: "Ok" },
			{ serviceName: "order-svc", spanName: "POST /api/orders", durationMs: 891, statusCode: "Error" },
			{ serviceName: "api-gw", spanName: "GET /api/health", durationMs: 3, statusCode: "Ok" },
		],
		"list-error-traces": [
			{ serviceName: "order-svc", spanName: "POST /api/orders", durationMs: 891, statusCode: "Error" },
			{ serviceName: "auth-svc", spanName: "GET /api/auth", durationMs: 2301, statusCode: "Error" },
			{ serviceName: "item-svc", spanName: "PUT /api/items", durationMs: 445, statusCode: "Error" },
		],
		"list-logs": [
			{
				timestamp: "12:04:23",
				severityText: "ERROR",
				serviceName: "api-gw",
				body: "Connection refused",
			},
			{ timestamp: "12:04:21", severityText: "WARN", serviceName: "user-svc", body: "Slow query" },
			{ timestamp: "12:04:19", severityText: "INFO", serviceName: "api-gw", body: "Request handled" },
		],
		"list-product-events": [
			{
				timestamp: "12:04:23",
				eventName: "signup_completed",
				userId: "user_8f2",
				pagePath: "/signup",
				source: "browser",
			},
			{
				timestamp: "12:04:21",
				eventName: "plan_started",
				userId: "user_8f2",
				pagePath: "",
				source: "server",
			},
			{
				timestamp: "12:04:19",
				eventName: "$pageview",
				userId: "",
				pagePath: "/pricing",
				source: "browser",
			},
		],
	}),

	initialState: (widget) => {
		const source = toListDataSource(widget.display.listDataSource)
		return {
			listDataSource: source,
			listWhereClause: widget.display.listWhereClause ?? "",
			listLimit: typeof widget.display.listLimit === "number" ? String(widget.display.listLimit) : "",
			listColumns: (widget.display.columns ?? DEFAULT_LIST_COLUMNS[source]) as ListColumnDraft[],
			listRootOnly: widget.display.listRootOnly ?? true,
		}
	},

	buildDataSource: ({ state }) => {
		const limit = parsePositiveNumber(state.listLimit) ?? DEFAULT_LIST_LIMIT

		// Logs without rich filtering fall back to the simple list_logs endpoint.
		if (state.listDataSource === "logs") {
			return makeRouteDataSource(
				"list_logs",
				buildListEndpointParams(state.listDataSource, state.listWhereClause, limit),
			)
		}

		// Traces and product events go through the query engine, which supports
		// full attr.* filtering. `root_only` is injected as a filter rather than a
		// param so a traces query can use the root-span MV.
		const effectiveWhereClause =
			state.listDataSource === "traces" && state.listRootOnly
				? state.listWhereClause.trim()
					? `root_only = true AND ${state.listWhereClause}`
					: "root_only = true"
				: state.listWhereClause

		const queryForEngine: QueryBuilderQueryDraft = {
			...createQueryDraft(0),
			dataSource: state.listDataSource,
			whereClause: effectiveWhereClause,
			aggregation: "count", // required by the spec builder but unused for list
		}
		const columnFields = state.listColumns.flatMap((column) => (column.field ? [column.field] : []))

		return makeQueryDataSource({
			resultShape: "list",
			queries: [queryForEngine],
			limit,
			...(columnFields.length > 0 ? { columns: columnFields } : undefined),
		})
	},

	// Built from scratch, not from `base`: a list has no chart presentation, no
	// unit and no axes, so carrying the previous type's display forward would
	// leave dead keys behind. It also keeps whatever title the user typed rather
	// than deriving one from queries it doesn't have.
	buildDisplay: ({ state }) => ({
		title: state.title.trim() || undefined,
		description: state.description.trim() || undefined,
		listDataSource: state.listDataSource,
		listWhereClause: state.listWhereClause,
		listLimit: parsePositiveNumber(state.listLimit) ?? DEFAULT_LIST_LIMIT,
		listRootOnly: state.listRootOnly,
		columns: state.listColumns.length > 0 ? state.listColumns : undefined,
	}),
}
