import type { Resources } from "../platform/resources"
import { Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { AppRoute } from "../route"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Lane } from "../data/lanes"
import type { PageContext, PageOutMessage } from "./contract"
import type { PageViewInputs } from "./kit/inputs"
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

// Every page: its Model in the root, its Messages lifted, one entry per route.

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

export const PageMessage = defineMessageUnion({
	GotTracesMessage: { message: Traces.Message },
	GotTraceDetailMessage: { message: TraceDetail.Message },
	GotLogsMessage: { message: Logs.Message },
	GotMetricsMessage: { message: Metrics.Message },
	GotMetricDetailMessage: { message: MetricDetail.Message },
	GotServicesMessage: { message: Services.Message },
	GotServiceDetailMessage: { message: ServiceDetail.Message },
	GotServiceMapMessage: { message: ServiceMap.Message },
	GotErrorsMessage: { message: Errors.Message },
	GotSessionsMessage: { message: Sessions.Message },
	GotSessionDetailMessage: { message: SessionDetail.Message },
	GotQueryMessage: { message: Query.Message },
})
export type PageMessage = typeof PageMessage.Type

export type PageReturn = Update.ReturnWithOutMessage<PageModel, PageMessage, PageOutMessage, Resources>

/** The page instance survives while this is unchanged; a search change arrives as `locationChanged`. */
export const pageKeyOf = (route: AppRoute): string => JSON.stringify(route)

const lift = <M>(
	result: Readonly<{
		model: PageModel
		commands?: ReadonlyArray<Command.Command<M, never, Resources>>
		outMessage?: PageOutMessage
	}>,
	toMessage: (message: M) => PageMessage,
): PageReturn => ({
	model: result.model,
	commands: Command.mapMessages(result.commands ?? [], toMessage),
	outMessage: result.outMessage,
})

const toTraces = (message: Traces.Message) => PageMessage.GotTracesMessage({ message })
const toTraceDetail = (message: TraceDetail.Message) => PageMessage.GotTraceDetailMessage({ message })
const toLogs = (message: Logs.Message) => PageMessage.GotLogsMessage({ message })
const toMetrics = (message: Metrics.Message) => PageMessage.GotMetricsMessage({ message })
const toMetricDetail = (message: MetricDetail.Message) => PageMessage.GotMetricDetailMessage({ message })
const toServices = (message: Services.Message) => PageMessage.GotServicesMessage({ message })
const toServiceDetail = (message: ServiceDetail.Message) => PageMessage.GotServiceDetailMessage({ message })
const toServiceMap = (message: ServiceMap.Message) => PageMessage.GotServiceMapMessage({ message })
const toErrors = (message: Errors.Message) => PageMessage.GotErrorsMessage({ message })
const toSessions = (message: Sessions.Message) => PageMessage.GotSessionsMessage({ message })
const toSessionDetail = (message: SessionDetail.Message) => PageMessage.GotSessionDetailMessage({ message })
const toQuery = (message: Query.Message) => PageMessage.GotQueryMessage({ message })

export const initPage = (route: AppRoute, context: PageContext): PageReturn =>
	AppRoute.match<PageReturn>(route, {
		Traces: () => lift(Traces.init(context), toTraces),
		TraceDetail: ({ traceId }) => lift(TraceDetail.init(context, traceId), toTraceDetail),
		Logs: () => lift(Logs.init(context), toLogs),
		Metrics: () => lift(Metrics.init(context), toMetrics),
		MetricDetail: ({ metricName }) => lift(MetricDetail.init(context, metricName), toMetricDetail),
		Services: () => lift(Services.init(context), toServices),
		ServiceDetail: ({ serviceName }) => lift(ServiceDetail.init(context, serviceName), toServiceDetail),
		ServiceMap: () => lift(ServiceMap.init(context), toServiceMap),
		Errors: () => lift(Errors.init(context), toErrors),
		Sessions: () => lift(Sessions.init(context), toSessions),
		SessionDetail: ({ sessionId }) => lift(SessionDetail.init(context, sessionId), toSessionDetail),
		Query: () => lift(Query.init(context), toQuery),
	})

/** A page's Message reaches it only while it is the open page (a late answer for another is dropped). */
export const updatePage = (page: PageModel, message: PageMessage, context: PageContext): PageReturn => {
	const unchanged: PageReturn = { model: page }
	return PageMessage.match<PageReturn>(message, {
		GotTracesMessage: ({ message: m }) =>
			page._tag === "TracesPage" ? lift(Traces.update(page, m, context), toTraces) : unchanged,
		GotTraceDetailMessage: ({ message: m }) =>
			page._tag === "TraceDetailPage" ? lift(TraceDetail.update(page, m, context), toTraceDetail) : unchanged,
		GotLogsMessage: ({ message: m }) => (page._tag === "LogsPage" ? lift(Logs.update(page, m, context), toLogs) : unchanged),
		GotMetricsMessage: ({ message: m }) =>
			page._tag === "MetricsPage" ? lift(Metrics.update(page, m, context), toMetrics) : unchanged,
		GotMetricDetailMessage: ({ message: m }) =>
			page._tag === "MetricDetailPage" ? lift(MetricDetail.update(page, m, context), toMetricDetail) : unchanged,
		GotServicesMessage: ({ message: m }) =>
			page._tag === "ServicesPage" ? lift(Services.update(page, m, context), toServices) : unchanged,
		GotServiceDetailMessage: ({ message: m }) =>
			page._tag === "ServiceDetailPage" ? lift(ServiceDetail.update(page, m, context), toServiceDetail) : unchanged,
		GotServiceMapMessage: ({ message: m }) =>
			page._tag === "ServiceMapPage" ? lift(ServiceMap.update(page, m, context), toServiceMap) : unchanged,
		GotErrorsMessage: ({ message: m }) =>
			page._tag === "ErrorsPage" ? lift(Errors.update(page, m, context), toErrors) : unchanged,
		GotSessionsMessage: ({ message: m }) =>
			page._tag === "SessionsPage" ? lift(Sessions.update(page, m, context), toSessions) : unchanged,
		GotSessionDetailMessage: ({ message: m }) =>
			page._tag === "SessionDetailPage" ? lift(SessionDetail.update(page, m, context), toSessionDetail) : unchanged,
		GotQueryMessage: ({ message: m }) => (page._tag === "QueryPage" ? lift(Query.update(page, m, context), toQuery) : unchanged),
	})
}

/** The notice's Try again: the open page's own refresh, where it has one. */
export const refreshPage = (page: PageModel, context: PageContext): PageReturn => {
	if (page._tag === "TracesPage") return updatePage(page, PageMessage.GotTracesMessage({ message: Traces.Message.ClickedRefresh() }), context)
	if (page._tag === "TraceDetailPage")
		return updatePage(page, PageMessage.GotTraceDetailMessage({ message: TraceDetail.Message.ClickedRefresh() }), context)
	if (page._tag === "LogsPage") return updatePage(page, PageMessage.GotLogsMessage({ message: Logs.Message.ClickedRefresh() }), context)
	if (page._tag === "MetricsPage") return updatePage(page, PageMessage.GotMetricsMessage({ message: Metrics.Message.ClickedRefresh() }), context)
	if (page._tag === "MetricDetailPage")
		return updatePage(page, PageMessage.GotMetricDetailMessage({ message: MetricDetail.Message.ClickedRefresh() }), context)
	if (page._tag === "ServicesPage") return updatePage(page, PageMessage.GotServicesMessage({ message: Services.Message.ClickedRefresh() }), context)
	if (page._tag === "ServiceDetailPage")
		return updatePage(page, PageMessage.GotServiceDetailMessage({ message: ServiceDetail.Message.ClickedRefresh() }), context)
	if (page._tag === "ServiceMapPage")
		return updatePage(page, PageMessage.GotServiceMapMessage({ message: ServiceMap.Message.ClickedRefresh() }), context)
	if (page._tag === "ErrorsPage") return updatePage(page, PageMessage.GotErrorsMessage({ message: Errors.Message.ClickedRefresh() }), context)
	if (page._tag === "SessionsPage") return updatePage(page, PageMessage.GotSessionsMessage({ message: Sessions.Message.ClickedRefresh() }), context)
	if (page._tag === "SessionDetailPage")
		return updatePage(page, PageMessage.GotSessionDetailMessage({ message: SessionDetail.Message.ClickedRefresh() }), context)
	return { model: page }
}

/** The open page sees a new fragment (filters, range, selection) without being rebuilt. */
export const locationChanged = (page: PageModel, context: PageContext): PageReturn => {
	if (page._tag === "TracesPage") return lift(Traces.locationChanged(page, context), toTraces)
	if (page._tag === "TraceDetailPage") return lift(TraceDetail.locationChanged(page, context), toTraceDetail)
	if (page._tag === "LogsPage") return lift(Logs.locationChanged(page, context), toLogs)
	if (page._tag === "MetricsPage") return lift(Metrics.locationChanged(page, context), toMetrics)
	if (page._tag === "MetricDetailPage") return lift(MetricDetail.locationChanged(page, context), toMetricDetail)
	if (page._tag === "ServicesPage") return lift(Services.locationChanged(page, context), toServices)
	if (page._tag === "ServiceDetailPage") return lift(ServiceDetail.locationChanged(page, context), toServiceDetail)
	if (page._tag === "ServiceMapPage") return lift(ServiceMap.locationChanged(page, context), toServiceMap)
	if (page._tag === "ErrorsPage") return lift(Errors.locationChanged(page, context), toErrors)
	if (page._tag === "SessionsPage") return lift(Sessions.locationChanged(page, context), toSessions)
	if (page._tag === "SessionDetailPage") return lift(SessionDetail.locationChanged(page, context), toSessionDetail)
	if (page._tag === "QueryPage") return lift(Query.locationChanged(page, context), toQuery)
	return { model: page }
}

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

/** The open page as a Submodel view; its Messages arrive lifted into `PageMessage`. */
export const viewPage = <P>(
	h: HtmlBuilder<P>,
	page: PageModel,
	viewInputs: PageViewInputs,
	toParent: (message: PageMessage) => P,
): Html => {
	const slot = <M>(slotId: string, toPage: (message: M) => PageMessage) => ({
		slotId,
		viewInputs,
		toParentMessage: (message: M) => toParent(toPage(message)),
	})
	if (page._tag === "TracesPage") return h.submodel({ ...slot("page:traces", toTraces), model: page, view: Traces.view })
	if (page._tag === "TraceDetailPage")
		return h.submodel({ ...slot("page:trace-detail", toTraceDetail), model: page, view: TraceDetail.view })
	if (page._tag === "LogsPage") return h.submodel({ ...slot("page:logs", toLogs), model: page, view: Logs.view })
	if (page._tag === "MetricsPage") return h.submodel({ ...slot("page:metrics", toMetrics), model: page, view: Metrics.view })
	if (page._tag === "MetricDetailPage")
		return h.submodel({ ...slot("page:metric-detail", toMetricDetail), model: page, view: MetricDetail.view })
	if (page._tag === "ServicesPage") return h.submodel({ ...slot("page:services", toServices), model: page, view: Services.view })
	if (page._tag === "ServiceDetailPage")
		return h.submodel({ ...slot("page:service-detail", toServiceDetail), model: page, view: ServiceDetail.view })
	if (page._tag === "ServiceMapPage")
		return h.submodel({ ...slot("page:service-map", toServiceMap), model: page, view: ServiceMap.view })
	if (page._tag === "ErrorsPage") return h.submodel({ ...slot("page:errors", toErrors), model: page, view: Errors.view })
	if (page._tag === "SessionsPage") return h.submodel({ ...slot("page:sessions", toSessions), model: page, view: Sessions.view })
	if (page._tag === "SessionDetailPage")
		return h.submodel({ ...slot("page:session-detail", toSessionDetail), model: page, view: SessionDetail.view })
	if (page._tag === "QueryPage") return h.submodel({ ...slot("page:query", toQuery), model: page, view: Query.view })
	return h.div([], [])
}
