import { OrgId } from "@maple/domain"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { Command, Subscription, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { Message as HubMessage } from "../page/alerts/hub/message"
import { Model as HubModel } from "../page/alerts/hub/model"
import { subscriptions as hubSubscriptions } from "../page/alerts/hub/subscription"
import { update as hubUpdate } from "../page/alerts/hub/update"
import { view as hubView } from "../page/alerts/hub/view"
import { Message as DashboardsMessage } from "../page/dashboards/list/message"
import { Model as DashboardsModel } from "../page/dashboards/list/model"
import { subscriptions as dashboardsSubscriptions } from "../page/dashboards/list/subscription"
import { update as dashboardsUpdate } from "../page/dashboards/list/update"
import { view as dashboardsView } from "../page/dashboards/list/view"
import { Message as InvestigationsMessage } from "../page/investigations/list/message"
import { Model as InvestigationsModel } from "../page/investigations/list/model"
import { subscriptions as investigationsSubscriptions } from "../page/investigations/list/subscription"
import { update as investigationsUpdate } from "../page/investigations/list/update"
import { view as investigationsView } from "../page/investigations/list/view"
import { Message as MetricsMessage } from "../page/metrics/browse/message"
import { Model as MetricsModel } from "../page/metrics/browse/model"
import { subscriptions as metricsSubscriptions } from "../page/metrics/browse/subscription"
import { update as metricsUpdate } from "../page/metrics/browse/update"
import { view as metricsView } from "../page/metrics/browse/view"
import { Message as ServicesMessage } from "../page/services/list/message"
import { Model as ServicesModel } from "../page/services/list/model"
import { subscriptions as servicesSubscriptions } from "../page/services/list/subscription"
import { update as servicesUpdate } from "../page/services/list/update"
import { view as servicesView } from "../page/services/list/view"
import { LoadChartRuntime } from "@maple/views/charts/chart-runtime"
import type { PageContext } from "../page/contract"
import { ORG } from "../page/kit/alert-test-rows"
import type { Resources } from "../platform/resources"
import { readEffectiveTimeZone } from "../platform/time-zone"
import {
	alertsFixture,
	dashboardsFixture,
	investigationsFixture,
	metricsFixture,
	servicesFixture,
} from "./list-keys-fixture"

// `/lab/list-keys`: the list pages that take the row keys (J / K / arrows, Enter, Escape), each
// mounted over fixture rows with its own key subscription. `?page=` picks one: services, metrics,
// investigations, dashboards, alerts. Reads, writes and URL changes are dropped, so Enter and the
// filters go nowhere here.

export const LabPage = Schema.Literals(["services", "metrics", "investigations", "dashboards", "alerts"])
export type LabPage = typeof LabPage.Type

export const Flags = Schema.Struct({ page: LabPage, timeZone: Schema.String })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.map(readEffectiveTimeZone, (timeZone) => ({
	page: Option.getOrElse(
		Schema.decodeUnknownOption(LabPage)(new URLSearchParams(window.location.search).get("page")),
		(): LabPage => "services",
	),
	timeZone,
}))

export const Model = Schema.Struct({
	page: LabPage,
	timeZone: Schema.String,
	services: ServicesModel,
	metrics: MetricsModel,
	investigations: InvestigationsModel,
	dashboards: DashboardsModel,
	alerts: HubModel,
})
export type Model = typeof Model.Type

/** The dashboards Message can carry a browser `File`, which has no codec: held as it is. */
const DashboardsMessageValue = Schema.declare(Schema.is(DashboardsMessage))

export const Message = defineMessageUnion({
	GotServicesMessage: { message: ServicesMessage },
	GotMetricsMessage: { message: MetricsMessage },
	GotInvestigationsMessage: { message: InvestigationsMessage },
	GotDashboardsMessage: { message: DashboardsMessageValue },
	GotAlertsMessage: { message: HubMessage },
})
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const LAB_ORG = Schema.decodeSync(OrgId)(ORG)
const contextOf = (timeZone: string): PageContext => ({ orgId: LAB_ORG, pinnedNamespace: null, timeZone })

/** A page's reads, writes and clock are dropped: the fixture is all the data there is. */
const DATA_COMMAND =
	/^(Resolve|Fetch|Load(?!ChartRuntime)|Read|Create|Duplicate|Export|Import|Delete|Save|Toggle|End|Push|Dismiss)/

const keepLocal = <M, Lifted>(
	commands: ReadonlyArray<Command.Command<M, never, Resources>> | undefined,
	lift: (message: M) => Lifted,
) =>
	Command.mapMessages(
		Arr.filter(commands ?? [], (command) => !DATA_COMMAND.test(command.name)),
		lift,
	)

const toServices = (message: ServicesMessage) => Message.GotServicesMessage({ message })
const toMetrics = (message: MetricsMessage) => Message.GotMetricsMessage({ message })
const toInvestigations = (message: InvestigationsMessage) => Message.GotInvestigationsMessage({ message })
const toDashboards = (message: DashboardsMessage) => Message.GotDashboardsMessage({ message })
const toAlerts = (message: HubMessage) => Message.GotAlertsMessage({ message })

export const init = (flags: Flags): Return => {
	const context = contextOf(flags.timeZone)
	return {
		model: {
			page: flags.page,
			timeZone: flags.timeZone,
			services: servicesFixture(context),
			metrics: metricsFixture(context),
			investigations: investigationsFixture(context),
			dashboards: dashboardsFixture(context),
			alerts: alertsFixture(context),
		},
		// The services table paints once the chart runtime is in.
		commands: Command.mapMessages([LoadChartRuntime()], toServices),
	}
}

export const update = (model: Model, message: Message): Return => {
	const context = contextOf(model.timeZone)
	return Message.match<Return>(message, {
		GotServicesMessage: ({ message: inner }) => {
			const next = servicesUpdate(model.services, inner, context)
			return {
				model: { ...model, services: next.model },
				commands: keepLocal(next.commands, toServices),
			}
		},
		GotMetricsMessage: ({ message: inner }) => {
			const next = metricsUpdate(model.metrics, inner, context)
			return { model: { ...model, metrics: next.model }, commands: keepLocal(next.commands, toMetrics) }
		},
		GotInvestigationsMessage: ({ message: inner }) => {
			const next = investigationsUpdate(model.investigations, inner, context)
			return {
				model: { ...model, investigations: next.model },
				commands: keepLocal(next.commands, toInvestigations),
			}
		},
		GotDashboardsMessage: ({ message: inner }) => {
			const next = dashboardsUpdate(model.dashboards, inner, context)
			return {
				model: { ...model, dashboards: next.model },
				commands: keepLocal(next.commands, toDashboards),
			}
		},
		GotAlertsMessage: ({ message: inner }) => {
			const next = hubUpdate(model.alerts, inner, context)
			return { model: { ...model, alerts: next.model }, commands: keepLocal(next.commands, toAlerts) }
		},
	})
}

const LABEL = {
	services: "Services",
	metrics: "Metrics",
	investigations: "Investigations",
	dashboards: "Dashboards",
	alerts: "Alerts",
} satisfies Record<LabPage, string>

export const breadcrumbs = (model: Model) => [{ label: LABEL[model.page], isPageHeading: true }]

/** The page's own path, so the sidebar marks it. */
export const currentPath = (model: Model): string => `/${model.page}`

export const view = (model: Model, h: HtmlBuilder<Message>): Html => {
	const viewInputs = { context: contextOf(model.timeZone) }
	switch (model.page) {
		case "services":
			return h.submodel({
				slotId: "lab-list-keys-services",
				model: model.services,
				view: servicesView,
				viewInputs,
				toParentMessage: toServices,
			})
		case "metrics":
			return h.submodel({
				slotId: "lab-list-keys-metrics",
				model: model.metrics,
				view: metricsView,
				viewInputs,
				toParentMessage: toMetrics,
			})
		case "investigations":
			return h.submodel({
				slotId: "lab-list-keys-investigations",
				model: model.investigations,
				view: investigationsView,
				viewInputs,
				toParentMessage: toInvestigations,
			})
		case "dashboards":
			return h.submodel({
				slotId: "lab-list-keys-dashboards",
				model: model.dashboards,
				view: dashboardsView,
				viewInputs,
				toParentMessage: toDashboards,
			})
		case "alerts":
			return h.submodel({
				slotId: "lab-list-keys-alerts",
				model: model.alerts,
				view: hubView,
				viewInputs,
				toParentMessage: toAlerts,
			})
	}
}

/** A page's `{ model, context }` while it is the one on screen. */
const shown = <PageModel>(model: Model, page: LabPage, pageModel: PageModel) =>
	model.page === page
		? Option.some({ model: pageModel, context: contextOf(model.timeZone) })
		: Option.none()

/** Only each page's key stream: its live collections have nothing to sync here. */
export const subscriptions = Subscription.aggregate<Model, Message, Resources>()(
	Subscription.lift({ servicesKeys: servicesSubscriptions.listKeys })<Model, Message>({
		read: (model) => shown(model, "services", model.services),
		toParentMessage: toServices,
	}),
	Subscription.lift({ metricsKeys: metricsSubscriptions.listKeys })<Model, Message>({
		read: (model) => shown(model, "metrics", model.metrics),
		toParentMessage: toMetrics,
	}),
	Subscription.lift({ investigationsKeys: investigationsSubscriptions.listKeys })<Model, Message>({
		read: (model) => shown(model, "investigations", model.investigations),
		toParentMessage: toInvestigations,
	}),
	Subscription.lift({ dashboardsKeys: dashboardsSubscriptions.listKeys })<Model, Message>({
		read: (model) => shown(model, "dashboards", model.dashboards),
		toParentMessage: toDashboards,
	}),
	Subscription.lift({ alertsKeys: hubSubscriptions.listKeys })<Model, Message>({
		read: (model) => shown(model, "alerts", model.alerts),
		toParentMessage: toAlerts,
	}),
)
