import type {
	AlertCheckDocument,
	AlertIncidentDocument,
	AlertRulePreviewResponse,
	AlertRuleDocument,
} from "@maple/domain/http"
import type { AlertRuleStateRow } from "@maple/web-data/collections/alerts"
import type { V2Investigation } from "@maple/domain/http/v2"
import {
	formatAlertDuration,
	formatSignalValue,
	ruleToFormState,
	signalLabels,
} from "@maple/web-data/alerts/form-utils"
import {
	acknowledgedLine,
	buildIncidentTimeline,
	conditionPhrase,
	holdReasonLabel,
	incidentGroup,
	type IncidentTimelineEntry,
	signalTitle,
} from "@maple/web-data/alerts/incident-timeline"
import { incidentTitle, isQueryIncident } from "@maple/web-data/alerts/overview-derive"
import { formatDateInTimezone, formatTimeInTimezone } from "@maple/web-data/lib/timezone-format"
import { Option, Array as Arr, String as Str } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Chart from "@maple/views/charts/chart"
import { isChartRuntimeReady } from "@maple/views/charts/chart-runtime"
import { ResolveThemeColors, type ThemeColors } from "@maple/views/charts/theme-colors"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "@maple/views/ui/button"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { pageTitle } from "@maple/views/ui/page-layout"
import { skeleton } from "@maple/views/ui/skeleton"
import { vstack } from "@maple/views/ui/stack"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { resourceNotFound } from "../../kit/resource-not-found"
import { severityBadge } from "../shared/badges"
import { alertsHref } from "../shared/links"
import { sloHref, slosTabHref } from "../shared/slo-commands"
import { monitorHref, uptimeTabHref } from "../shared/uptime-commands"
import { incidentChecksOf, summaryChecksOf } from "../shared/check-summary"
import { previewIssue, previewStateOf } from "../shared/preview"
import { providerOf } from "../shared/providers"
import { RULE_CHART_TOKENS, ruleChart } from "../shared/rule-chart"
import { msIso } from "../shared/time"
import { groupPreviewOf, type IncidentView, incidentViewOf, ruleStatesOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { type EscalationData, incidentRail } from "./view-rail"
import { incidentTimeline } from "./view-timeline"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"

type H = HtmlBuilder<Message>

const statusLine = (incident: AlertIncidentDocument, now: number, timeZone: string): string => {
	const at = (iso: string) =>
		formatDateInTimezone(iso, { timeZone }) === formatDateInTimezone(now, { timeZone })
			? formatTimeInTimezone(iso, { timeZone })
			: `${formatDateInTimezone(iso, { timeZone })} ${formatTimeInTimezone(iso, { timeZone })}`
	if (incident.status === "resolved")
		return `Resolved ${incident.resolvedAt ? at(incident.resolvedAt) : ""} · lasted ${formatAlertDuration(incident.firstTriggeredAt, incident.resolvedAt)}`
	const acked = acknowledgedLine(incident)
	const ackSuffix =
		acked === null || incident.acknowledgedAt === null
			? ""
			: ` · ${acked} at ${at(incident.acknowledgedAt)}`
	if (incident.holdReason != null)
		return `Waiting on data · ${holdReasonLabel[incident.holdReason]}${ackSuffix}`
	return `Open ${formatAlertDuration(incident.firstTriggeredAt, msIso(now))} · since ${at(incident.firstTriggeredAt)}${ackSuffix}`
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
	const isSlo = incident.signalType === "slo_burn_rate"
	const isQuery = isQueryIncident(incident)
	// An uptime or SLO incident names its monitor or SLO and a query incident its rule.
	const title =
		isUptime || isSlo || isQuery
			? incidentTitle(incident)
			: `${signalTitle(incident.signalType)} ${formatSignalValue(incident.signalType, incident.lastObservedValue)}${group != null ? ` on ${group}` : ""}`
	const subline = Arr.join(
		Arr.filter(
			isUptime
				? ["Uptime check", group]
				: isSlo
					? [
							"SLO burn rate",
							// A resolved incident's last value is the healthy burn it ended on.
							incident.status === "resolved"
								? null
								: `now ${formatSignalValue(incident.signalType, incident.lastObservedValue)}`,
							group,
						]
					: [
							isQuery ? group : `Rule ${rule?.name ?? incident.ruleName}`,
							`${isQuery ? "value" : Str.toLowerCase(signalLabels[incident.signalType])} ${conditionPhrase(incident)}${rule != null ? ` over ${rule.windowMinutes}m` : ""}`,
							rule != null && rule.environments.length > 0
								? Arr.join(rule.environments, ", ")
								: null,
						],
			(part) => part != null,
		),
		" · ",
	)
	return h.div(
		[h.Class("min-w-0 space-y-2")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-2.5")],
				[
					severityBadge(h, incident.severity),
					typography(h, { size: "xs", tone: "muted" }, [statusLine(incident, now, timeZone)]),
				],
			),
			pageTitle(h, { title }, [title]),
			typography(h, { size: "xs", tone: "muted", truncate: true, as: "p" }, [subline]),
		],
	)
}

/** `IncidentHeader`'s Acknowledge or Unacknowledge button; nothing once the incident resolved. */
export const acknowledgeAction = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		incident: AlertIncidentDocument
		isLoading: boolean
		onAcknowledge: (acknowledged: boolean) => M
	}>,
): ReadonlyArray<Html> => {
	if (options.incident.status !== "open") return []
	const acknowledged = options.incident.acknowledgedAt !== null
	return [
		button(
			h,
			{
				variant: acknowledged ? "outline" : "default",
				size: "sm",
				isLoading: options.isLoading,
				attributes: [h.OnClick(options.onAcknowledge(!acknowledged))],
			},
			acknowledged ? ["Unacknowledge"] : [icon(h, "CheckIcon"), "Acknowledge"],
		),
	]
}

const investigateAction = (h: H, model: Model, investigation: V2Investigation | null): Html =>
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
	/** The evaluator's recorded checks: the line when the preview has none, else its dashed comparison. */
	checks: ReadonlyArray<AlertCheckDocument>
	isPreviewLoading: boolean
	previewError: string | null
	range: Readonly<{ start: number; end: number }>
	now: number
	timeZone: string
	entries: ReadonlyArray<IncidentTimelineEntry>
	isEntriesLoading: boolean
	isEntriesFailed: boolean
	/** The read of the incident's latest escalation run; a success of `null` means it has none. */
	escalation?: EscalationData
	/** An SLO or uptime incident's SLO or monitor page; its tab stands in until it is known. */
	sourceHref?: string | null
	chartId: string
	chart: Chart.Model
	toChartMessage: (message: Chart.Message) => M
	colors: ThemeColors
}>

/** A managed incident's note on what opened it, and a link to its SLO or monitor (its tab until known). */
const sourceNote = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		text: string
		href: string | null
		label: string
		fallback: Readonly<{ href: string; label: string }>
	}>,
): Html =>
	vstack(h, { gap: "3", align: "start" }, [
		typography(h, { size: "sm", tone: "muted", as: "p" }, [options.text]),
		linkButton(h, { size: "sm", variant: "outline", href: options.href ?? options.fallback.href }, [
			options.href === null ? options.fallback.label : options.label,
			icon(h, "ArrowRightIcon"),
		]),
	])

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
								? sourceNote(h, {
										text: "This incident follows an uptime monitor: it opened when the monitor's checks went down and resolves when one passes again. The monitor's page lists each check with its failing trace.",
										href: inputs.sourceHref ?? null,
										label: "Open monitor",
										fallback: { href: uptimeTabHref(), label: "Open monitors" },
									})
								: incident.signalType === "slo_burn_rate"
									? sourceNote(h, {
											text: "This incident follows an SLO burning its error budget: it opened when the burn rate held at a tier's factor over both of its windows, and resolves when the short window cools. The SLO's page charts the budget and each window's burn rate.",
											href: inputs.sourceHref ?? null,
											label: "Open SLO",
											fallback: { href: slosTabHref(), label: "Open SLOs" },
										})
									: rule === null
										? typography(h, { size: "sm", tone: "muted", as: "p" }, [
												"The rule behind this incident was deleted, so its signal cannot be replayed.",
											])
										: ruleChart(h, {
												chartId: inputs.chartId,
												chart: inputs.chart,
												toChartMessage: inputs.toChartMessage,
												colors: inputs.colors,
												timeZone: inputs.timeZone,
												preview: inputs.preview,
												checks: inputs.checks,
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
				escalation: inputs.escalation ?? AsyncData.succeed(null),
				timeZone: inputs.timeZone,
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
	const checkSummary = AsyncData.getOrElse(model.checks.data, () => null)
	const deliveries = AsyncData.getOrElse(model.deliveries.data, () => [])
	const investigation = AsyncData.getOrElse(model.investigation.data, () => null)
	const isChartReady = model.themeColors !== null && isChartRuntimeReady(model.chartRuntime)
	const sloLink = Option.flatMap(AsyncData.getData(model.slos.data), (slos) =>
		Option.map(
			Arr.findFirst(slos, (slo) => slo.alert_rule_id === incident.ruleId),
			(slo) => sloHref(slo.id),
		),
	)
	const monitorLink = Option.flatMap(AsyncData.getData(model.monitors.data), (monitors) =>
		Option.map(
			Arr.findFirst(monitors, (monitor) => monitor.alert_rule_id === incident.ruleId),
			(monitor) => monitorHref(monitor.id),
		),
	)
	return incidentBody(h, {
		incident,
		rule,
		sourceHref: Option.getOrNull(incident.signalType === "uptime" ? monitorLink : sloLink),
		escalation: model.escalation.data,
		ruleIncidents: view.ruleIncidents,
		states: ruleStatesOf(model, incident.ruleId),
		preview: groupPreviewOf(previewState.preview, incident),
		checks:
			rule === null || checkSummary === null
				? []
				: incidentChecksOf(summaryChecksOf(rule, checkSummary), incident),
		// A raw SQL rule may only chart from its checks, so it waits for them instead of flashing the error.
		isPreviewLoading:
			previewState.isLoading ||
			!isChartReady ||
			(incident.signalType === "raw_query" &&
				(AsyncData.isIdle(model.checks.data) || AsyncData.isLoading(model.checks.data))),
		previewError: previewState.error,
		range: view.range,
		now,
		timeZone,
		entries: buildIncidentTimeline({
			incident,
			deliveries,
			activity: AsyncData.getOrElse(model.activity.data, () => []),
			investigation,
			renotifyIntervalMinutes:
				rule != null && rule.destinationIds.length > 0 ? rule.renotifyIntervalMinutes : null,
			destinationTypeLabel: (type) => providerOf(type).label,
		}),
		isEntriesLoading:
			AsyncData.isLoading(model.deliveries.data) || AsyncData.isIdle(model.deliveries.data),
		isEntriesFailed:
			AsyncData.isFailure(model.deliveries.data) || AsyncData.isFailure(model.activity.data),
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
					actions: hstack(h, { gap: "2", wrap: true }, [
						...acknowledgeAction(h, {
							incident: view.incident,
							isLoading: model.isUpdatingAcknowledgement,
							onAcknowledge: (acknowledged) => Message.ClickedAcknowledge({ acknowledged }),
						}),
						investigateAction(
							h,
							model,
							AsyncData.getOrElse(model.investigation.data, () => null),
						),
					]),
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
