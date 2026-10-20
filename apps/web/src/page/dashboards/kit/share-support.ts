import { Option, Schema } from "effect"
import { PRODUCT_EVENTS_FUNNEL_ENDPOINT, PRODUCT_EVENTS_PATHS_ENDPOINT } from "@maple/widgets/dashboard"

// Which widgets a shared view can render, judged
// ahead of time so the share dialog and the embed item can say so. The server stays the authority.

const SUPPORTED_ROUTE_ENDPOINTS = new Set([
	"errors_by_type",
	"errors_summary",
	"service_overview",
	"service_usage",
	"list_logs",
	PRODUCT_EVENTS_FUNNEL_ENDPOINT,
	PRODUCT_EVENTS_PATHS_ENDPOINT,
])

/** Prose for the dialog, so the copy and the list cannot disagree. */
export const SHAREABLE_WIDGET_KINDS =
	"query-builder charts, raw SQL, markdown, funnels, paths, and the errors, service and logs tiles"

interface WidgetLike {
	readonly id: string
	readonly display?: { readonly title?: string }
	readonly dataSource?: unknown
}

const WidgetSource = Schema.Struct({
	kind: Schema.optionalKey(Schema.String),
	endpoint: Schema.optionalKey(Schema.String),
})
const decodeSource = Schema.decodeUnknownOption(WidgetSource)

export const isShareSupported = (dataSource: unknown): boolean => {
	return Option.match(decodeSource(dataSource), {
		onNone: () => false,
		onSome: ({ kind, endpoint }) =>
			kind === "query" || kind === "raw_sql" || kind === "static"
				? true
				: endpoint !== undefined && SUPPORTED_ROUTE_ENDPOINTS.has(endpoint),
	})
}

export interface UnsupportedShareWidget {
	readonly id: string
	readonly title: string
}

/** Widgets that will render as unavailable tiles for a viewer. */
export const unsupportedShareWidgets = (widgets: ReadonlyArray<WidgetLike>): ReadonlyArray<UnsupportedShareWidget> =>
	widgets
		.filter((widget) => !isShareSupported(widget.dataSource))
		.map((widget) => ({ id: widget.id, title: widget.display?.title ?? widget.id }))
