import { buildAlertsLabFixture, type AlertsLabFixture } from "../alerts-fixture"
import { buildIncidentTimeline } from "@maple/web-data/alerts/incident-timeline"
import type { Html, HtmlBuilder } from "foldkit/html"
import { isChartRuntimeReady } from "@maple/views/charts/chart-runtime"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import { acknowledgeAction, headerTitle, incidentBody } from "../../page/alerts/incident/view"
import { AlertIncidentDocument, IsoDateTimeString } from "@maple/domain/http"
import { V2AlertIncidentEvent } from "@maple/domain/http/v2"
import { Array as Arr, Schema } from "effect"
import { hstack } from "@maple/views/ui/stack"
import { providerOf } from "../../page/alerts/shared/providers"
import { RULE_CHART_TOKENS } from "../../page/alerts/shared/rule-chart"
import { isoMs } from "../../page/alerts/shared/time"
import { dashboardPage, pageHeader } from "../../page/kit/dashboard-page"
import { AppRoute, hrefOf } from "../../route"
import { linkButton } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import { labShellView } from "../app-shell"
import { Message, type Model } from "./model"
import { FRAME_CLASS, hubSections, section } from "./view"

type H = HtmlBuilder<Message>

/** The fixture incident as Dana acknowledged it from Slack, a minute after its last notification. */
const acknowledgedByDana = (
	fixture: AlertsLabFixture,
): Readonly<{ incident: AlertIncidentDocument; activity: ReadonlyArray<V2AlertIncidentEvent> }> => {
	const { incident, deliveries } = fixture.incident
	const lastNotifiedMs = Arr.reduce(deliveries, isoMs(incident.firstTriggeredAt), (latest, delivery) =>
		Math.max(latest, isoMs(delivery.attemptedAt ?? delivery.scheduledAt)),
	)
	const acknowledgedAt = new Date(lastNotifiedMs + 60_000).toISOString()
	return {
		incident: new AlertIncidentDocument({
			...incident,
			acknowledgedAt: Schema.decodeSync(IsoDateTimeString)(acknowledgedAt),
			acknowledgedByUserId: null,
			acknowledgedByName: "Dana Kim",
			acknowledgedVia: "slack",
		}),
		activity: [
			Schema.decodeSync(V2AlertIncidentEvent)({
				id: "evt_tC4d9V79DCDzgbGKhAnff9",
				object: "alert_incident_event",
				incident_id: "inc_tC4d9V79DCDzgbGKhAnff9",
				type: "acknowledged",
				actor: { user_id: null, name: "Dana Kim" },
				source: "slack",
				created_at: acknowledgedAt,
			}),
		],
	}
}

/** `IncidentFrame`: `IncidentHeader` (a page header) over `IncidentBody`, from the fixture. */
const incidentFrame = (h: H, model: Model, fixture: AlertsLabFixture, isAcknowledged: boolean): Html => {
	const { rule, ruleIncidents, states, preview, range, deliveries, investigation } = fixture.incident
	const { incident, activity } = isAcknowledged
		? acknowledgedByDana(fixture)
		: { incident: fixture.incident.incident, activity: [] }
	const entries = buildIncidentTimeline({
		activity,
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
						hstack(h, { gap: "2", wrap: true }, [
							// The lab has no API: the button shows its state and its click goes nowhere.
							...acknowledgeAction(h, {
								incident,
								isLoading: false,
								onAcknowledge: () =>
									Message.ResolvedThemeColors({ colors: model.themeColors ?? {} }),
							}),
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
						]),
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
						checks: [],
						isPreviewLoading: !isChartReady,
						previewError: null,
						range,
						now: model.nowMs,
						timeZone: model.timeZone,
						entries,
						isEntriesLoading: false,
						isEntriesFailed: false,
						chartId: isAcknowledged
							? "alerts-lab-incident-chart-acknowledged"
							: "alerts-lab-incident-chart",
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
							incidentFrame(h, model, fixture, false),
						]),
						section(h, "incident-acknowledged", "Incident: acknowledged from Slack", [
							incidentFrame(h, model, fixture, true),
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
