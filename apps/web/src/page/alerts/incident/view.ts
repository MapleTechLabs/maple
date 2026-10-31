import type { AlertIncidentDocument, AlertRulePreviewResponse, AlertRuleDocument } from "@maple/domain/http"
import type { AlertRuleStateRow } from "@maple/web-data/collections/alerts"
import type { V2Investigation } from "@maple/domain/http/v2"
import {
	formatAlertDuration,
	formatSignalValue,
	ruleToFormState,
	signalLabels,
} from "@maple/web-data/alerts/form-utils"
import {
	buildIncidentTimeline,
	conditionPhrase,
	holdReasonLabel,
	incidentGroup,
	type IncidentTimelineEntry,
	signalTitle,
} from "@maple/web-data/alerts/incident-timeline"
import { incidentTitle, isQueryIncident } from "@maple/web-data/alerts/overview-derive"
import { formatDateInTimezone, formatTimeInTimezone } from "@maple/web-data/lib/timezone-format"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Chart from "../../../charts/chart"
import { isChartRuntimeReady } from "../../../charts/chart-runtime"
import { ResolveThemeColors, type ThemeColors } from "../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "../../../ui/button"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { pageTitle } from "../../../ui/page-layout"
import { skeleton } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { resourceNotFound } from "../../kit/resource-not-found"
import { severityBadge } from "../shared/badges"
import { alertsHref } from "../shared/links"
import { previewIssue, previewStateOf } from "../shared/preview"
import { providerOf } from "../shared/providers"
import { RULE_CHART_TOKENS, ruleChart } from "../shared/rule-chart"
import { msIso } from "../shared/time"
import { groupPreviewOf, type IncidentView, incidentViewOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { incidentRail } from "./view-rail"
import { incidentTimeline } from "./view-timeline"

type H = HtmlBuilder<Message>

const statusLine = (incident: AlertIncidentDocument, now: number, timeZone: string): string => {
	const at = (iso: string) =>
		formatDateInTimezone(iso, { timeZone }) === formatDateInTimezone(now, { timeZone })
			? formatTimeInTimezone(iso, { timeZone })
			: `${formatDateInTimezone(iso, { timeZone })} ${formatTimeInTimezone(iso, { timeZone })}`
	if (incident.status === "resolved")
		return `Resolved ${incident.resolvedAt ? at(incident.resolvedAt) : ""} · lasted ${formatAlertDuration(incident.firstTriggeredAt, incident.resolvedAt)}`
	if (incident.holdReason != null) return `Waiting on data · ${holdReasonLabel[incident.holdReason]}`
	return `Open ${formatAlertDuration(incident.firstTriggeredAt, msIso(now))} · since ${at(incident.firstTriggeredAt)}`
}

/** `IncidentHeader`'s title side. */
export const headerTitle = <M>(
	h: HtmlBuilder<M>,
	incident: AlertIncidentDocument,
	rule: AlertRuleDocument | null,
	now: number,
	timeZone: string,
) => {
	const group = incidentGroup(incident)
	const isUptime = incident.signalType === "uptime"
	const isQuery = isQueryIncident(incident)
	// An uptime incident names its monitor and a query incident its rule; neither has a signal to spell out.
	const title =
		isUptime || isQuery
			? incidentTitle(incident)
			: `${signalTitle(incident.signalType)} ${formatSignalValue(incident.signalType, incident.lastObservedValue)}${group != null ? ` on ${group}` : ""}`
	const subline = (
		isUptime
			? ["Uptime check", group]
			: [
					isQuery ? group : `Rule ${rule?.name ?? incident.ruleName}`,
					`${isQuery ? "value" : signalLabels[incident.signalType].toLowerCase()} ${conditionPhrase(incident)}${rule != null ? ` over ${rule.windowMinutes}m` : ""}`,
					rule != null && rule.environments.length > 0 ? rule.environments.join(", ") : null,
				]
	)
		.filter((part) => part != null)
		.join(" · ")
	return h.div(
		[h.Class("min-w-0 space-y-2")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-2.5")],
				[
					severityBadge(h, incident.severity),
					h.span([h.Class("text-muted-foreground text-xs")], [statusLine(incident, now, timeZone)]),
				],
			),
			pageTitle(h, { title }, [title]),
			h.p([h.Class("truncate text-muted-foreground text-xs")], [subline]),
		],
	)
}

const headerAction = (h: H, model: Model, investigation: V2Investigation | null): Html =>
	investigation !== null
		? linkButton(
				h,
				{
					variant: "outline",
					size: "sm",
					href: hrefOf(AppRoute.Investigation({ id: String(investigation.id), search: {} })),
				},
				[icon(h, "ChatBubbleSparkleIcon"), "Open investigation"],
			)
		: button(
				h,
				{
					variant: "outline",
					size: "sm",
					isDisabled:
						model.isStartingInvestigation ||
						AsyncData.isLoading(model.investigation.data) ||
						AsyncData.isIdle(model.investigation.data),
					attributes: [h.OnClick(Message.ClickedInvestigate())],
				},
				[icon(h, "ChatBubbleSparkleIcon"), "Investigate"],
			)

/** What `IncidentBody` renders, from props (the page reads them off its Model, the lab off a fixture). */
export type IncidentBodyInputs<M> = Readonly<{
	incident: AlertIncidentDocument
	rule: AlertRuleDocument | null
	ruleIncidents: ReadonlyArray<AlertIncidentDocument>
	states: ReadonlyArray<AlertRuleStateRow>
	preview: AlertRulePreviewResponse | null
	isPreviewLoading: boolean
	previewError: string | null
	range: Readonly<{ start: number; end: number }>
	now: number
	timeZone: string
	entries: ReadonlyArray<IncidentTimelineEntry>
	isEntriesLoading: boolean
	isEntriesFailed: boolean
	chartId: string
	chart: Chart.Model
	toChartMessage: (message: Chart.Message) => M
	colors: ThemeColors
}>

/** `IncidentBody`: signal chart, timeline and rail. */
export const incidentBody = <M>(h: HtmlBuilder<M>, inputs: IncidentBodyInputs<M>): Html => {
	const { incident, rule } = inputs
	const group = incidentGroup(incident)
	return h.div(
		[h.Class("grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]")],
		[
			h.div(
				[h.Class("min-w-0 space-y-8")],
				[
					h.section(
						[h.Class("space-y-3")],
						[
							eyebrow(h, { as: "h2" }, [
								signalTitle(incident.signalType),
								...(group != null ? [` · ${group}`] : []),
							]),
							incident.signalType === "uptime"
								? h.p(
										[h.Class("text-muted-foreground text-sm")],
										[
											"This incident follows an uptime monitor: it opened when the monitor's checks went down and resolves when one passes again. The monitor's page lists each check with its failing trace.",
										],
									)
								: rule === null
									? h.p(
											[h.Class("text-muted-foreground text-sm")],
											[
												"The rule behind this incident was deleted, so its signal cannot be replayed.",
											],
										)
									: ruleChart(h, {
											chartId: inputs.chartId,
											chart: inputs.chart,
											toChartMessage: inputs.toChartMessage,
											colors: inputs.colors,
											timeZone: inputs.timeZone,
											preview: inputs.preview,
											incidents: [incident],
											threshold: incident.threshold,
											thresholdUpper: incident.thresholdUpper,
											comparator: incident.comparator,
											signalType: incident.signalType,
											window: { min: inputs.range.start, max: inputs.range.end },
											source: "preview",
											isLoading: inputs.isPreviewLoading,
											error: inputs.previewError,
										}),
						],
					),
					incidentTimeline(h, {
						entries: inputs.entries,
						timeZone: inputs.timeZone,
						isLoading: inputs.isEntriesLoading,
						isFailed: inputs.isEntriesFailed,
					}),
				],
			),
			incidentRail(h, {
				rule,
				incident,
				states: inputs.states,
				ruleIncidents: inputs.ruleIncidents,
				window: inputs.range,
				now: inputs.now,
			}),
		],
	)
}

const body = (h: H, model: Model, view: IncidentView, timeZone: string, now: number): Html => {
	const { incident, rule } = view
	const previewState = previewStateOf(
		model.preview,
		Option.isSome(view.payload),
		previewIssue(rule === null ? null : ruleToFormState(rule)),
	)
	const deliveries = AsyncData.getOrElse(model.deliveries.data, () => [])
	const investigation = AsyncData.getOrElse(model.investigation.data, () => null)
	const isChartReady = model.themeColors !== null && isChartRuntimeReady(model.chartRuntime)
	return incidentBody(h, {
		incident,
		rule,
		ruleIncidents: view.ruleIncidents,
		states: (model.states ?? []).filter((row) => row.rule_id === incident.ruleId),
		preview: groupPreviewOf(previewState.preview, incident),
		isPreviewLoading: previewState.isLoading || !isChartReady,
		previewError: previewState.error,
		range: view.range,
		now,
		timeZone,
		entries: buildIncidentTimeline({
			incident,
			deliveries,
			investigation,
			renotifyIntervalMinutes:
				rule != null && rule.destinationIds.length > 0 ? rule.renotifyIntervalMinutes : null,
			destinationTypeLabel: (type) => providerOf(type).label,
		}),
		isEntriesLoading:
			AsyncData.isLoading(model.deliveries.data) || AsyncData.isIdle(model.deliveries.data),
		isEntriesFailed: AsyncData.isFailure(model.deliveries.data),
		chartId: "alert-incident-chart",
		chart: model.chart,
		toChartMessage: (message) => Message.GotChartMessage({ message }),
		colors: model.themeColors ?? {},
	})
}

const loading = (h: H): Html =>
	dashboardPage(
		h,
		{
			titleContent: h.div(
				[h.Class("min-w-0 space-y-2.5"), h.AriaBusy(true)],
				[skeleton(h, "h-3 w-32"), skeleton(h, "h-7 w-3/4"), skeleton(h, "h-5 w-48")],
			),
		},
		[skeleton(h, "h-[300px] w-full"), skeleton(h, "h-40 w-full")],
	)

const notFound = (h: H): Html =>
	dashboardPage(h, {}, [
		resourceNotFound(h, {
			title: "Incident not found",
			description: "It may have been pruned, or the link is stale.",
			back: { href: alertsHref({}), label: "Back to alerts" },
		}),
	])

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const timeZone = inputs.context.timeZone
	const page = Option.match(incidentViewOf(model), {
		onNone: () => (model.incidents === null || model.nowMs === null ? loading(h) : notFound(h)),
		onSome: (view) => {
			const now = model.nowMs ?? 0
			return dashboardPage(
				h,
				{
					titleContent: headerTitle(h, view.incident, view.rule, now, timeZone),
					actions: headerAction(
						h,
						model,
						AsyncData.getOrElse(model.investigation.data, () => null),
					),
				},
				[body(h, model, view, timeZone, now)],
			)
		},
	})
	return h.div([h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: RULE_CHART_TOKENS }))], [page])
})

/** `DashboardPage`'s breadcrumbs per state. */
export const breadcrumbsOf = (model: Model) =>
	Option.match(incidentViewOf(model), {
		onNone: () => [
			{ label: "Alerts", href: "/alerts" },
			{ label: model.incidents === null || model.nowMs === null ? "Loading" : "Not found" },
		],
		onSome: ({ incident, rule }) => [
			{ label: "Alerts", href: "/alerts" },
			{ label: rule?.name ?? incident.ruleName, href: `/alerts/${incident.ruleId}` },
			{ label: "Incident" },
		],
	})
