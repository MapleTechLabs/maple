import type { ValueUnit } from "@/components/dashboard-builder/types"

export const LIST_DATA_SOURCES = ["traces", "logs", "product_events"] as const
export type ListDataSource = (typeof LIST_DATA_SOURCES)[number]

export const toListDataSource = (value: unknown): ListDataSource =>
	LIST_DATA_SOURCES.find((candidate) => candidate === value) ?? "traces"

export const LIST_DATA_SOURCE_LABEL = {
	traces: "Traces",
	logs: "Logs",
	product_events: "Product events",
} satisfies Record<ListDataSource, string>

export interface ListColumnDraft {
	field: string
	header: string
	unit?: ValueUnit
	align?: "left" | "center" | "right"
}

export const TRACE_DEFAULT_COLUMNS: ListColumnDraft[] = [
	{ field: "serviceName", header: "Service" },
	{ field: "spanName", header: "Span" },
	{ field: "durationMs", header: "Duration", unit: "duration_ms", align: "right" },
	{ field: "statusCode", header: "Status" },
]

export const LOG_DEFAULT_COLUMNS: ListColumnDraft[] = [
	{ field: "timestamp", header: "Time" },
	{ field: "severityText", header: "Severity" },
	{ field: "serviceName", header: "Service" },
	{ field: "body", header: "Message" },
]

export const PRODUCT_EVENT_DEFAULT_COLUMNS: ListColumnDraft[] = [
	{ field: "timestamp", header: "Time" },
	{ field: "eventName", header: "Event" },
	{ field: "userId", header: "User" },
	{ field: "pagePath", header: "Page" },
	{ field: "source", header: "Source" },
]

export const DEFAULT_LIST_COLUMNS = {
	traces: TRACE_DEFAULT_COLUMNS,
	logs: LOG_DEFAULT_COLUMNS,
	product_events: PRODUCT_EVENT_DEFAULT_COLUMNS,
} satisfies Record<ListDataSource, ListColumnDraft[]>
