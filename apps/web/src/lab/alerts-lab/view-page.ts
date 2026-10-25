import { buildAlertsLabFixture, type AlertsLabFixture } from "../alerts-fixture"
import { buildIncidentTimeline } from "@maple/web-data/alerts/incident-timeline"
import type { Html, HtmlBuilder } from "foldkit/html"
import { isChartRuntimeReady } from "../../charts/chart-runtime"
import { ResolveThemeColors } from "../../charts/theme-colors"
import { headerTitle, incidentBody } from "../../page/alerts/incident/view"
import { providerOf } from "../../page/alerts/shared/providers"
import { RULE_CHART_TOKENS } from "../../page/alerts/shared/rule-chart"
import { dashboardPage, pageHeader } from "../../page/kit/dashboard-page"
import { AppRoute, hrefOf } from "../../route"
import { linkButton } from "../../ui/button"
import { icon } from "../../ui/icon"
import { labShellView } from "../app-shell"
import { Message, type Model } from "./model"
import { FRAME_CLASS, hubSections, section } from "./view"

type H = HtmlBuilder<Message>

/** `IncidentFrame`: `IncidentHeader` (a page header) over `IncidentBody`, from the fixture. */
const incidentFrame = (h: H, model: Model, fixture: AlertsLabFixture): Html => {
	const { incident, rule, ruleIncidents, states, preview, range, deliveries, investigation } =
		fixture.incident
	const entries = buildIncidentTimeline({
		incident,
		deliveries,
		investigation,
		renotifyIntervalMinutes: rule.renotifyIntervalMinutes,
		destinationTypeLabel: (type) => providerOf(type).label,
	})
	const isChartReady = model.themeColors !== null && isChartRuntimeReady(model.chartRuntime)
	return h.div(
		[h.Class(FRAME_CLASS)],
		[
			h.div(
				[h.Class("border-b p-4")],
				[
					pageHeader(
						h,
						headerTitle(h, incident, rule, model.nowMs, model.timeZone),
						linkButton(
							h,
							{
								variant: "outline",
								size: "sm",
								href: hrefOf(
									AppRoute.Investigation({ id: String(investigation.id), search: {} }),
								),
							},
							[icon(h, "ChatBubbleSparkleIcon"), "Open investigation"],
						),
					),
				],
			),
			h.div(
				[h.Class("p-6")],
				[
					incidentBody(h, {
						incident,
						rule,
						ruleIncidents,
						states,
						preview,
						isPreviewLoading: !isChartReady,
						previewError: null,
						range,
						now: model.nowMs,
						timeZone: model.timeZone,
						entries,
						isEntriesLoading: false,
						isEntriesFailed: false,
						chartId: "alerts-lab-incident-chart",
						chart: model.chart,
						toChartMessage: (message) => Message.GotChartMessage({ message }),
						colors: model.themeColors ?? {},
					}),
				],
			),
		],
	)
}

const pageBody = (h: H, model: Model): Html => {
	const fixture = buildAlertsLabFixture(model.nowMs)
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: RULE_CHART_TOKENS }))],
		[
			dashboardPage(h, {}, [
				h.div(
					[h.Class("space-y-12")],
					[
						h.submodel({
							slotId: "alerts-lab-hub",
							model: model.hub,
							view: hubSections,
							viewInputs: {
								fixture,
								status: model.status,
								timeZone: model.timeZone,
								nowMs: model.nowMs,
							},
							toParentMessage: (message) => Message.GotHubMessage({ message }),
						}),
						section(h, "incident", "Incident: critical error rate on maple-chat", [
							incidentFrame(h, model, fixture),
						]),
					],
				),
			]),
		],
	)
}

/** The real shell around the lab page. */
export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Id("app")],
		labShellView(h, model.shell, (message) => Message.GotShellMessage({ message }), {
			currentPath: "/lab/alerts",
			breadcrumbs: [{ label: "Lab" }, { label: "Alerts" }],
			page: () => pageBody(h, model),
		}),
	)
