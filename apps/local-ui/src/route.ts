import { trySync } from "@maple/ui/lib/try-sync"
import { Option, Schema, String as Str } from "effect"
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
	const [rawPath, rawSearch = ""] = Str.split("?")(hash)
	return { path: Str.startsWith("/")(rawPath) ? rawPath : "/traces", search: rawSearch }
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
	Option.map(
		Option.flatMapNullishOr(Str.match(new RegExp(`^/${prefix}/(.+)$`))(path), (match) => match[1]),
		decodeSegment,
	)

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
	if (Str.startsWith("/errors")(path)) return AppRoute.Errors()
	if (Str.startsWith("/logs")(path)) return AppRoute.Logs()
	if (Str.startsWith("/metrics")(path)) return AppRoute.Metrics()
	if (Str.startsWith("/service-map")(path)) return AppRoute.ServiceMap()
	if (Str.startsWith("/services")(path)) return AppRoute.Services()
	if (Str.startsWith("/sessions")(path)) return AppRoute.Sessions()
	if (Str.startsWith("/query")(path)) return AppRoute.Query()
	return AppRoute.Traces()
}
