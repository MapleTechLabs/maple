import { type DashboardDocument, PortableDashboardDocument } from "@maple/domain/http"
import type { V2DashboardCreateParams } from "@maple/domain/http/v2"
import { Effect, Schema } from "effect"

// The portable dashboard format and `importDashboard`'s payload. Stored widgets always carry a
// valid layout, so normalisation is a copy.

type Widget = DashboardDocument["widgets"][number]

export type PortableDashboard = Readonly<{
	name: string
	description?: string
	tags?: ReadonlyArray<string>
	timeRange: DashboardDocument["timeRange"]
	widgets: ReadonlyArray<Widget>
	sections?: DashboardDocument["sections"]
	variables?: DashboardDocument["variables"]
	refreshIntervalSeconds?: DashboardDocument["refreshIntervalSeconds"]
}>

/** `toPortableDashboard`: what Export writes and Duplicate re-imports. */
export const toPortable = (document: DashboardDocument): PortableDashboard => ({
	name: document.name,
	...(document.description === undefined ? undefined : { description: document.description }),
	...(document.tags === undefined ? undefined : { tags: [...document.tags] }),
	timeRange: document.timeRange,
	widgets: document.widgets,
	...(document.sections === undefined ? undefined : { sections: document.sections }),
	...(document.variables === undefined ? undefined : { variables: document.variables }),
	...(document.refreshIntervalSeconds === undefined
		? undefined
		: { refreshIntervalSeconds: document.refreshIntervalSeconds }),
})

/** `importDashboard`'s create body: name, description, tags, range, widgets, variables. */
export const createPayload = (portable: PortableDashboard): V2DashboardCreateParams => ({
	name: portable.name,
	...(portable.description === undefined ? undefined : { description: portable.description }),
	...(portable.tags === undefined ? undefined : { tags: portable.tags }),
	timeRange: portable.timeRange,
	widgets: portable.widgets,
	...(portable.variables === undefined ? undefined : { variables: portable.variables }),
})

/** The import file is not a portable dashboard. */
export class PortableDashboardParseError extends Schema.TaggedError<PortableDashboardParseError>()(
	"@maple/web/dashboards/PortableDashboardParseError",
	{ message: Schema.String },
) {}

const decodePortable = Schema.decodeUnknownEffect(PortableDashboardDocument)

/** `stripWidgetTimeParams`: a route arm's params lose any baked absolute window. */
const stripWidgetTimeParams = (widget: Widget): Widget => {
	const dataSource = widget.dataSource
	if (dataSource.kind !== "route") return widget
	const params = dataSource.params
	if (params === undefined || !("startTime" in params || "endTime" in params)) return widget
	const { startTime: _startTime, endTime: _endTime, ...rest } = params
	return { ...widget, dataSource: { ...dataSource, params: rest } }
}

/** `parsePortableDashboardJson` over an already-parsed value. */
export const parsePortable = (parsed: unknown) =>
	Effect.map(
		Effect.mapError(
			decodePortable(parsed),
			(error) => new PortableDashboardParseError({ message: error.message }),
		),
		(decoded): PortableDashboard => ({
			name: decoded.name,
			...(decoded.description === undefined ? undefined : { description: decoded.description }),
			...(decoded.tags === undefined ? undefined : { tags: [...decoded.tags] }),
			...(decoded.variables === undefined ? undefined : { variables: decoded.variables }),
			...(decoded.sections === undefined ? undefined : { sections: decoded.sections }),
			...(decoded.refreshIntervalSeconds === undefined
				? undefined
				: { refreshIntervalSeconds: decoded.refreshIntervalSeconds }),
			timeRange: decoded.timeRange,
			widgets: decoded.widgets.map(stripWidgetTimeParams),
		}),
	)

/** `isPersesDashboardJson`. */
export const isPersesDashboardJson = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	"kind" in value &&
	value.kind === "Dashboard" &&
	"spec" in value &&
	typeof value.spec === "object" &&
	value.spec !== null

const sanitizeFilenameSegment = (value: string): string => {
	const sanitized = value.replace(/[^a-zA-Z0-9-_ ]/g, "").trim()
	return sanitized.length > 0 ? sanitized : "dashboard"
}

/** `downloadPortableDashboard`: the JSON file through a temporary anchor. */
export const downloadPortable = (document: DashboardDocument) =>
	Effect.sync(() => {
		const json = JSON.stringify(toPortable(document), null, 2)
		const url = URL.createObjectURL(new Blob([json], { type: "application/json" }))
		const anchor = window.document.createElement("a")
		anchor.href = url
		anchor.download = `${sanitizeFilenameSegment(document.name)}.json`
		window.document.body.appendChild(anchor)
		anchor.click()
		window.document.body.removeChild(anchor)
		URL.revokeObjectURL(url)
	})
