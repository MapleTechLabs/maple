import { Option, Tuple } from "effect"
import { shownDataOf } from "../data/shown"
import type { Model } from "../model"
import { canGoBack } from "../navigation"
import type { AppRoute } from "../route"
import { ApplicationDefinition } from "./application-definition"
import type { PageContext } from "./contract"
import type { PageModel } from "./page-model"
import { ErrorsBlock } from "./errors"
import { LogsBlock } from "./logs"
import { MetricDetailBlock } from "./metric-detail"
import { MetricsBlock } from "./metrics"
import { QueryBlock } from "./query"
import { ServiceDetailBlock } from "./service-detail"
import { ServiceMapPageBlock } from "./service-map"
import { ServicesBlock } from "./services"
import { SessionDetailBlock } from "./session-detail"
import { SessionsBlock } from "./sessions"
import { TraceDetailBlock } from "./trace-detail"
import { TracesBlock } from "./traces"

// Every page as a Binding on the root's `page` slot: the slot's tag says which page is open, and
// a page's Messages reach it only while it is (a late answer for another is dropped).

const { makeStep, makeNoopStep } = ApplicationDefinition

/** What every page reads from the root (see `PageContext`). */
export const pageContextOf = (model: Model): PageContext => ({
	env: model.env,
	location: model.location,
	rememberedRange: model.rememberedRange,
	timeFormat: model.timeFormat,
	canGoBack: canGoBack(model.visited),
})

/** The page slot after a page step; a result on hand keeps the views through a server outage. */
const writePage = (model: Model, page: PageModel): Model => ({
	...model,
	page,
	hasCache: model.hasCache || shownDataOf(page, 0).hasData,
})

/** Each page's update reads the root's context at delivery. */
const delivery = { toUpdateContext: (model: Model) => Tuple.make(pageContextOf(model)) }

export const TracesBinding = ApplicationDefinition.makeBinding(TracesBlock, {
	read: (model) => (model.page._tag === "TracesPage" ? Option.some(model.page) : Option.none()),
	write: writePage,
	delivery,
})

export const TraceDetailBinding = ApplicationDefinition.makeBinding(TraceDetailBlock, {
	read: (model) => (model.page._tag === "TraceDetailPage" ? Option.some(model.page) : Option.none()),
	write: writePage,
	delivery,
})

export const LogsBinding = ApplicationDefinition.makeBinding(LogsBlock, {
	read: (model) => (model.page._tag === "LogsPage" ? Option.some(model.page) : Option.none()),
	write: writePage,
	delivery,
})

export const MetricsBinding = ApplicationDefinition.makeBinding(MetricsBlock, {
	read: (model) => (model.page._tag === "MetricsPage" ? Option.some(model.page) : Option.none()),
	write: writePage,
	delivery,
})

export const MetricDetailBinding = ApplicationDefinition.makeBinding(MetricDetailBlock, {
	read: (model) => (model.page._tag === "MetricDetailPage" ? Option.some(model.page) : Option.none()),
	write: writePage,
	delivery,
})

export const ServicesBinding = ApplicationDefinition.makeBinding(ServicesBlock, {
	read: (model) => (model.page._tag === "ServicesPage" ? Option.some(model.page) : Option.none()),
	write: writePage,
	delivery,
})

export const ServiceDetailBinding = ApplicationDefinition.makeBinding(ServiceDetailBlock, {
	read: (model) => (model.page._tag === "ServiceDetailPage" ? Option.some(model.page) : Option.none()),
	write: writePage,
	delivery,
})

export const ServiceMapBinding = ApplicationDefinition.makeBinding(ServiceMapPageBlock, {
	read: (model) => (model.page._tag === "ServiceMapPage" ? Option.some(model.page) : Option.none()),
	write: writePage,
	delivery,
})

export const ErrorsBinding = ApplicationDefinition.makeBinding(ErrorsBlock, {
	read: (model) => (model.page._tag === "ErrorsPage" ? Option.some(model.page) : Option.none()),
	write: writePage,
	delivery,
})

export const SessionsBinding = ApplicationDefinition.makeBinding(SessionsBlock, {
	read: (model) => (model.page._tag === "SessionsPage" ? Option.some(model.page) : Option.none()),
	write: writePage,
	delivery,
})

export const SessionDetailBinding = ApplicationDefinition.makeBinding(SessionDetailBlock, {
	read: (model) => (model.page._tag === "SessionDetailPage" ? Option.some(model.page) : Option.none()),
	write: writePage,
	delivery,
})

export const QueryBinding = ApplicationDefinition.makeBinding(QueryBlock, {
	read: (model) => (model.page._tag === "QueryPage" ? Option.some(model.page) : Option.none()),
	write: writePage,
	delivery,
})

/** A new route builds its page in the slot; the previous page's occurrence ends. */
export const initPageStep = (route: AppRoute) =>
	makeStep((model: Model) => {
		const context = pageContextOf(model)
		const toParentModel = (page: PageModel) => writePage(model, page)
		if (route._tag === "Traces") return TracesBinding.init({ args: [context], toParentModel })
		if (route._tag === "TraceDetail")
			return TraceDetailBinding.init({ args: [context, route.traceId], toParentModel })
		if (route._tag === "Logs") return LogsBinding.init({ args: [context], toParentModel })
		if (route._tag === "Metrics") return MetricsBinding.init({ args: [context], toParentModel })
		if (route._tag === "MetricDetail")
			return MetricDetailBinding.init({ args: [context, route.metricName], toParentModel })
		if (route._tag === "Services") return ServicesBinding.init({ args: [context], toParentModel })
		if (route._tag === "ServiceDetail")
			return ServiceDetailBinding.init({ args: [context, route.serviceName], toParentModel })
		if (route._tag === "ServiceMap") return ServiceMapBinding.init({ args: [context], toParentModel })
		if (route._tag === "Errors") return ErrorsBinding.init({ args: [context], toParentModel })
		if (route._tag === "Sessions") return SessionsBinding.init({ args: [context], toParentModel })
		if (route._tag === "SessionDetail")
			return SessionDetailBinding.init({ args: [context, route.sessionId], toParentModel })
		return QueryBinding.init({ args: [context], toParentModel })
	})

/** The notice's Try again: the open page's own refresh, where it has one. */
export const refreshPageStep = makeStep((model: Model) => {
	const context = pageContextOf(model)
	const tag = model.page._tag
	if (tag === "TracesPage") return TracesBinding.requestRefresh(context)
	if (tag === "TraceDetailPage") return TraceDetailBinding.requestRefresh(context)
	if (tag === "LogsPage") return LogsBinding.requestRefresh(context)
	if (tag === "MetricsPage") return MetricsBinding.requestRefresh(context)
	if (tag === "MetricDetailPage") return MetricDetailBinding.requestRefresh(context)
	if (tag === "ServicesPage") return ServicesBinding.requestRefresh(context)
	if (tag === "ServiceDetailPage") return ServiceDetailBinding.requestRefresh(context)
	if (tag === "ServiceMapPage") return ServiceMapBinding.requestRefresh(context)
	if (tag === "ErrorsPage") return ErrorsBinding.requestRefresh(context)
	if (tag === "SessionsPage") return SessionsBinding.requestRefresh(context)
	if (tag === "SessionDetailPage") return SessionDetailBinding.requestRefresh(context)
	return makeNoopStep()
})

/** The open page sees a new fragment (filters, range, selection) without being rebuilt. */
export const locationChangedStep = makeStep((model: Model) => {
	const context = pageContextOf(model)
	const tag = model.page._tag
	if (tag === "TracesPage") return TracesBinding.informLocationChanged(context)
	if (tag === "TraceDetailPage") return TraceDetailBinding.informLocationChanged(context)
	if (tag === "LogsPage") return LogsBinding.informLocationChanged(context)
	if (tag === "MetricsPage") return MetricsBinding.informLocationChanged(context)
	if (tag === "MetricDetailPage") return MetricDetailBinding.informLocationChanged(context)
	if (tag === "ServicesPage") return ServicesBinding.informLocationChanged(context)
	if (tag === "ServiceDetailPage") return ServiceDetailBinding.informLocationChanged(context)
	if (tag === "ServiceMapPage") return ServiceMapBinding.informLocationChanged(context)
	if (tag === "ErrorsPage") return ErrorsBinding.informLocationChanged(context)
	if (tag === "SessionsPage") return SessionsBinding.informLocationChanged(context)
	if (tag === "SessionDetailPage") return SessionDetailBinding.informLocationChanged(context)
	if (tag === "QueryPage") return QueryBinding.informLocationChanged(context)
	return makeNoopStep()
})
