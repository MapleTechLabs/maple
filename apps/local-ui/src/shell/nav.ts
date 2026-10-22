import type { IconName } from "@maple/web/ui/icon"
import { AppRoute } from "../route"

// The sidebar nav: grouped and iconed like apps/web's sidebar.

export type Section =
	| "traces"
	| "logs"
	| "metrics"
	| "services"
	| "service-map"
	| "errors"
	| "sessions"
	| "query"

export interface NavItem {
	readonly section: Section
	readonly label: string
	readonly icon: IconName
}

export const NAV_GROUPS: ReadonlyArray<Readonly<{ label: string; items: ReadonlyArray<NavItem> }>> = [
	{
		label: "Monitor",
		items: [
			{ section: "services", label: "Services", icon: "ServerIcon" },
			{ section: "service-map", label: "Service map", icon: "NetworkNodesIcon" },
		],
	},
	{
		label: "Explore",
		items: [
			{ section: "traces", label: "Traces", icon: "PulseIcon" },
			{ section: "logs", label: "Logs", icon: "FileIcon" },
			{ section: "metrics", label: "Metrics", icon: "ChartLineIcon" },
			{ section: "sessions", label: "Sessions", icon: "PlayRotateClockwiseIcon" },
			{ section: "query", label: "Query", icon: "UiLayersIcon" },
		],
	},
	{ label: "Triage", items: [{ section: "errors", label: "Errors", icon: "CircleWarningIcon" }] },
]

/** `activeSection`: a detail page lights its list's row. */
export const activeSection = (route: AppRoute): Section =>
	AppRoute.match<Section>(route, {
		Traces: () => "traces",
		TraceDetail: () => "traces",
		Logs: () => "logs",
		Metrics: () => "metrics",
		MetricDetail: () => "metrics",
		Services: () => "services",
		ServiceDetail: () => "services",
		ServiceMap: () => "service-map",
		Errors: () => "errors",
		Sessions: () => "sessions",
		SessionDetail: () => "sessions",
		Query: () => "query",
	})
