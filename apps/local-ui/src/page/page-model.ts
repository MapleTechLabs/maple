import { Schema } from "effect"
import type { Lane } from "../data/lanes"
import type { AppRoute } from "../route"
import * as Errors from "./errors"
import * as Logs from "./logs"
import * as MetricDetail from "./metric-detail"
import * as Metrics from "./metrics"
import * as Query from "./query"
import * as ServiceDetail from "./service-detail"
import * as ServiceMap from "./service-map"
import * as Services from "./services"
import * as SessionDetail from "./session-detail"
import * as Sessions from "./sessions"
import * as TraceDetail from "./trace-detail"
import * as Traces from "./traces"

// The root's page slot: one page Model at a time. Kept apart from the Bindings (registry.ts) so
// the root Model can import it without a cycle through the Application Definition.

/** Before the first route resolves, the page slot holds this. */
export const PlaceholderPage = Schema.TaggedStruct("PlaceholderPage", { route: Schema.String })
export type PlaceholderPage = typeof PlaceholderPage.Type

export const placeholder = (route: string): PlaceholderPage => ({ _tag: "PlaceholderPage", route })

export const PageModel = Schema.Union([
	Traces.Model,
	TraceDetail.Model,
	Logs.Model,
	Metrics.Model,
	MetricDetail.Model,
	Services.Model,
	ServiceDetail.Model,
	ServiceMap.Model,
	Errors.Model,
	Sessions.Model,
	SessionDetail.Model,
	Query.Model,
	PlaceholderPage,
])
export type PageModel = typeof PageModel.Type

/** The page instance survives while this is unchanged; a search change arrives as `informLocationChanged`. */
export const pageKeyOf = (route: AppRoute): string => JSON.stringify(route)

/** The requests the page may have in flight; the root stops those a step supersedes or abandons. */
export const lanesOf = (page: PageModel): ReadonlyArray<Lane> => {
	if (page._tag === "TracesPage") return Traces.lanes(page)
	if (page._tag === "TraceDetailPage") return TraceDetail.lanes(page)
	if (page._tag === "LogsPage") return Logs.lanes(page)
	if (page._tag === "MetricsPage") return Metrics.lanes(page)
	if (page._tag === "MetricDetailPage") return MetricDetail.lanes(page)
	if (page._tag === "ServicesPage") return Services.lanes(page)
	if (page._tag === "ServiceDetailPage") return ServiceDetail.lanes(page)
	if (page._tag === "ServiceMapPage") return ServiceMap.lanes(page)
	if (page._tag === "ErrorsPage") return Errors.lanes(page)
	if (page._tag === "SessionsPage") return Sessions.lanes(page)
	if (page._tag === "SessionDetailPage") return SessionDetail.lanes(page)
	if (page._tag === "QueryPage") return Query.lanes(page)
	return []
}
