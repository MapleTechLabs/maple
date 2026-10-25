import { trySync } from "@maple/ui/lib/try-sync"
import { Option, Schema } from "effect"
import { defineRouteUnion } from "foldkit/route"

// Routes live in the fragment,
// `#/<path>?<filters>`, so every view is reload-safe and shareable.

export const AppRoute = defineRouteUnion({
	Traces: {},
	TraceDetail: { traceId: Schema.String },
	Logs: {},
	Metrics: {},
	MetricDetail: { metricName: Schema.String },
	Services: {},
	ServiceDetail: { serviceName: Schema.String },
	ServiceMap: {},
	Errors: {},
	Sessions: {},
	SessionDetail: { sessionId: Schema.String },
	Query: {},
})
export type AppRoute = typeof AppRoute.Type

/** The parsed fragment: its path (always starting with `/`) and its query string. */
export const Location = Schema.Struct({ path: Schema.String, search: Schema.String })
export type Location = typeof Location.Type

/** `parseLocation`: `#/sessions?range=1h` without its `#`. */
export const parseLocation = (hash: string): Location => {
	const [rawPath = "", rawSearch = ""] = hash.split("?")
	return { path: rawPath.startsWith("/") ? rawPath : "/traces", search: rawSearch }
}

export const queryOf = (location: Location): URLSearchParams => new URLSearchParams(location.search)

/** A `#/path?query` href, for real links (keyboard focus, cmd-click, copy link). */
export const hrefFor = (path: string, query?: URLSearchParams): string => {
	const search = query?.toString()
	return `#${path}${search ? `?${search}` : ""}`
}

/** `decodeURIComponent` that keeps a malformed segment as is instead of throwing. */
export const decodeSegment = (segment: string): string =>
	Option.getOrElse(
		trySync(() => decodeURIComponent(segment)),
		() => segment,
	)

const detail = (path: string, prefix: string): Option.Option<string> =>
	Option.map(Option.fromNullishOr(path.match(new RegExp(`^/${prefix}/(.+)$`))?.[1]), decodeSegment)

/** `parseRoute`: details first, then section prefixes; anything else is the traces list. */
export const parseRoute = (path: string): AppRoute => {
	const traceId = detail(path, "traces")
	if (Option.isSome(traceId)) return AppRoute.TraceDetail({ traceId: traceId.value })
	const metricName = detail(path, "metrics")
	if (Option.isSome(metricName)) return AppRoute.MetricDetail({ metricName: metricName.value })
	const serviceName = detail(path, "services")
	if (Option.isSome(serviceName)) return AppRoute.ServiceDetail({ serviceName: serviceName.value })
	const sessionId = detail(path, "sessions")
	if (Option.isSome(sessionId)) return AppRoute.SessionDetail({ sessionId: sessionId.value })
	if (path.startsWith("/errors")) return AppRoute.Errors()
	if (path.startsWith("/logs")) return AppRoute.Logs()
	if (path.startsWith("/metrics")) return AppRoute.Metrics()
	if (path.startsWith("/service-map")) return AppRoute.ServiceMap()
	if (path.startsWith("/services")) return AppRoute.Services()
	if (path.startsWith("/sessions")) return AppRoute.Sessions()
	if (path.startsWith("/query")) return AppRoute.Query()
	return AppRoute.Traces()
}
