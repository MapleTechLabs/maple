import { DEFAULT_LIST_LIMIT, type DashboardDocument } from "@maple/domain/http"
import { createQueryDraft } from "@maple/query-engine/query-builder"
import { makeQueryDataSource, makeRouteDataSource } from "@maple/widgets/dashboard"
import type { EditorState, ListColumn, ListDataSource } from "./editor-state"
import { buildListLogsParams } from "./list-logs-params"

// The list widget's halves: configured by `ListConfigPanel`, not the
// query builder, so it owns its whole display.

type Widget = DashboardDocument["widgets"][number]
type Display = Widget["display"]
type DataSource = Widget["dataSource"]

/** `parsePositiveNumber`. */
export const parsePositiveNumber = (raw: string): number | undefined => {
	const parsed = Number.parseInt(raw.trim(), 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

const LIST_DATA_SOURCES: ReadonlyArray<ListDataSource> = ["traces", "logs", "product_events"]

export const toListDataSource = (value: unknown): ListDataSource =>
	LIST_DATA_SOURCES.find((candidate) => candidate === value) ?? "traces"

/** The columns a new list widget starts with. */
export const DEFAULT_LIST_COLUMNS = {
	traces: [
		{ field: "serviceName", header: "Service" },
		{ field: "spanName", header: "Span" },
		{ field: "durationMs", header: "Duration", unit: "duration_ms", align: "right" },
		{ field: "statusCode", header: "Status" },
	],
	logs: [
		{ field: "timestamp", header: "Time" },
		{ field: "severityText", header: "Severity" },
		{ field: "serviceName", header: "Service" },
		{ field: "body", header: "Message" },
	],
	product_events: [
		{ field: "timestamp", header: "Time" },
		{ field: "eventName", header: "Event" },
		{ field: "userId", header: "User" },
		{ field: "pagePath", header: "Page" },
		{ field: "source", header: "Source" },
	],
} satisfies Readonly<Record<ListDataSource, ReadonlyArray<ListColumn>>>

const copyColumn = (column: ListColumn): ListColumn => ({ ...column })

/** The list fields every editor state carries: the stored list's, or the traces defaults. */
export const listInitialState = (
	widget: Widget | null,
): Pick<EditorState, "listDataSource" | "listWhereClause" | "listLimit" | "listColumns" | "listRootOnly"> => {
	if (widget === null)
		return {
			listDataSource: "traces",
			listWhereClause: "",
			listLimit: "",
			listColumns: DEFAULT_LIST_COLUMNS.traces.map(copyColumn),
			listRootOnly: true,
		}
	const source = toListDataSource(widget.display.listDataSource)
	return {
		listDataSource: source,
		listWhereClause: widget.display.listWhereClause ?? "",
		listLimit: typeof widget.display.listLimit === "number" ? String(widget.display.listLimit) : "",
		listColumns: (widget.display.columns ?? DEFAULT_LIST_COLUMNS[source]).map(copyColumn),
		listRootOnly: widget.display.listRootOnly ?? true,
	}
}

/** `listWidgetType.buildDataSource`: logs on `list_logs`, the rest through the query engine. */
export const listDataSourceOf = (state: EditorState): DataSource => {
	const limit = parsePositiveNumber(state.listLimit) ?? DEFAULT_LIST_LIMIT
	if (state.listDataSource === "logs")
		return makeRouteDataSource("list_logs", buildListLogsParams(state.listWhereClause, limit).params)
	const effectiveWhereClause =
		state.listDataSource === "traces" && state.listRootOnly
			? state.listWhereClause.trim()
				? `root_only = true AND ${state.listWhereClause}`
				: "root_only = true"
			: state.listWhereClause
	const columnFields = state.listColumns.flatMap((column) => (column.field ? [column.field] : []))
	return makeQueryDataSource({
		resultShape: "list",
		queries: [
			{
				...createQueryDraft(0),
				// The editor's own draft id, so the preview's request key holds still between edits.
				...(state.queries[0] === undefined ? undefined : { id: state.queries[0].id }),
				dataSource: state.listDataSource,
				whereClause: effectiveWhereClause,
				aggregation: "count",
			},
		],
		limit,
		...(columnFields.length > 0 ? { columns: columnFields } : undefined),
	})
}

/** `listWidgetType.buildDisplay`: built from scratch, so nothing of the previous type survives. */
export const listDisplayOf = (state: EditorState): Display => ({
	title: state.title.trim() || undefined,
	description: state.description.trim() || undefined,
	listDataSource: state.listDataSource,
	listWhereClause: state.listWhereClause,
	listLimit: parsePositiveNumber(state.listLimit) ?? DEFAULT_LIST_LIMIT,
	listRootOnly: state.listRootOnly,
	columns: state.listColumns.length > 0 ? state.listColumns.map(copyColumn) : undefined,
})
