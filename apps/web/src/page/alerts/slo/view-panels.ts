import type { AlertSeverity } from "@maple/domain/http"
import type { AlertIncidentRow } from "@maple/web-data/collections/alerts"
import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as AreaChart from "@maple/views/charts/area-chart"
import type * as Chart from "@maple/views/charts/chart"
import type { TimeseriesAxisSpec } from "@maple/views/charts/chart-spec"
import { resolveColor, type ThemeColors } from "@maple/views/charts/theme-colors"
import { chartFrameClass } from "@maple/views/ui/chart-frame"
import { chartSkeleton } from "@maple/views/ui/chart-skeleton"
import { emptyMessage } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { listRow } from "@maple/views/ui/list-row"
import { panel, panelBody, panelChartBody, panelHeader } from "@maple/views/ui/panel"
import { stripClass } from "@maple/views/ui/rule"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { switchControl } from "@maple/views/ui/switch"
import { typography } from "@maple/views/ui/typography"
import { relativeTime } from "../../kit/relative-time"
import { statRail, statRailItem, statRailLoading } from "../../kit/stat-rail"
import { severityBadge } from "../shared/badges"
import { incidentHref } from "../shared/links"
import {
	burnOf,
	burnTone,
	budgetTone,
	formatBudget,
	formatBurn,
	formatEvents,
	formatSli,
	formatTarget,
	formatWindow,
	type Slo,
	type SloStatus,
	sliTone,
	sloIncidents,
	tierStates,
	windowLabel,
} from "../shared/slo-derive"
import { toneText } from "../shared/slo-view"
import { isoMs } from "../shared/time"
import { Message } from "./message"
import { canManage, type Model } from "./model"

// The SLO page's panels: the figures, the two charts, the burn windows, alerting and incidents.

type H = HtmlBuilder<Message>

/** The tokens the charts resolve: their series and chrome, the 0% line and the target line. */
export const CHART_TOKENS = AreaChart.AREA_CHART_TOKENS

export type ChartContext = Readonly<{ theme: ThemeColors; timeZone: string; nowMs: number }>

const INCIDENT_ROWS = 5

// FIGURES

/** Current SLI against the target, the budget left and the events the window counted. */
export const figures = (h: H, model: Model, slo: Slo): Html => {
	const data = model.status.data
	if (AsyncData.isFailure(data))
		// The error card stands on its own: a panel's overflow would clip its icon and button.
		return errorState(h, {
			failure: data.error,
			title: "Couldn't read the SLO's status",
			onRetry: Message.ClickedRetryStatus(),
			className: "py-8",
		})
	return Option.match(AsyncData.getData(data), {
		onNone: () => statRailLoading(h, 3, 3),
		onSome: (status) => {
			const bad = Math.max(0, status.total_events - status.good_events)
			return statRail(h, { columns: 3 }, [
				statRailItem(h, {
					eyebrow: "Current SLI",
					value: formatSli(status.sli),
					tone: sliTone(slo, status.sli),
					compact: true,
					subline: `Target ${formatTarget(slo)} over ${formatWindow(slo.window_days)}`,
				}),
				statRailItem(h, {
					eyebrow: "Error budget left",
					value: formatBudget(status.budget_remaining),
					tone: budgetTone(status.budget_remaining),
					compact: true,
					subline:
						status.budget_remaining <= 0
							? `Spent: ${formatBudget(-status.budget_remaining)} over budget`
							: `Of the ${slo.window_days}-day budget`,
				}),
				statRailItem(h, {
					eyebrow: "Events counted",
					value: formatEvents(status.total_events),
					compact: true,
					subline:
						status.total_events === 0
							? "No entry-point spans in this window"
							: `${formatEvents(bad)} bad, ${formatEvents(status.good_events)} good`,
				}),
			])
		},
	})
}

// CHARTS

type Row = Readonly<Record<string, string | number | boolean>>

const thresholdAxis = (value: number, color: string, label: string, fit: boolean): TimeseriesAxisSpec => ({
	thresholds: [{ value, color, label }],
	logScale: false,
	softMin: null,
	softMax: null,
	fitYAxisToData: fit,
})

const chartSlot = (
	h: H,
	options: Readonly<{
		slotId: string
		chartId: string
		chart: Chart.Model
		rows: ReadonlyArray<Row>
		axis: TimeseriesAxisSpec
		context: ChartContext
		toMessage: (message: Chart.Message) => Message
	}>,
): Html =>
	h.div(
		[h.Class("h-56")],
		[
			h.submodel({
				slotId: options.slotId,
				model: options.chart,
				view: AreaChart.view,
				toParentMessage: options.toMessage,
				viewInputs: {
					chartId: options.chartId,
					data: options.rows,
					theme: options.context.theme,
					unit: "percent",
					timeZone: options.context.timeZone,
					nowMs: options.context.nowMs,
					className: chartFrameClass("fill"),
					showTooltip: true,
					legend: "hidden",
					mark: "line",
					axis: options.axis,
				},
			}),
		],
	)

/** The history's state as a panel body: a skeleton, the failure, nothing yet, or the chart. */
const historyBody = (
	h: H,
	model: Model,
	context: ChartContext | null,
	draw: (points: NonNullable<ReturnType<typeof historyPoints>>, context: ChartContext) => Html,
): Html => {
	const data = model.history.data
	if (AsyncData.isFailure(data))
		return errorState(h, {
			failure: data.error,
			title: "Couldn't load the budget history",
			onRetry: Message.ClickedRetryHistory(),
			className: "py-8",
		})
	const points = historyPoints(model)
	if (points === null || context === null)
		return model.chartRuntime._tag === "Failed"
			? emptyMessage(h, { className: "py-16 text-center" }, [
					"The chart couldn't load. Reload the page to try again.",
				])
			: h.div([h.Class("h-56")], [chartSkeleton(h, "line")])
	return points.length === 0
		? emptyMessage(h, { className: "py-16 text-center" }, ["No events in this window"])
		: draw(points, context)
}

const historyPoints = (model: Model) =>
	Option.getOrNull(Option.map(AsyncData.getData(model.history.data), (history) => history.points))

/** Budget left over the window, hour by hour, against the 0% line it must stay above. */
export const budgetPanel = (h: H, model: Model, slo: Slo, context: ChartContext | null): Html =>
	panel(h, { attributes: [h.AriaLabel("Error budget")] }, [
		panelHeader(h, {
			title: "Error budget",
			divided: false,
			action: typography(h, { size: "xs", tone: "muted" }, [
				`Budget left over the trailing ${formatWindow(slo.window_days)}, hourly`,
			]),
		}),
		panelChartBody(h, [
			historyBody(h, model, context, (points, ready) =>
				chartSlot(h, {
					slotId: "slo-budget-chart",
					chartId: "slo-budget",
					chart: model.budgetChart,
					rows: Arr.map(points, (point) => ({
						bucket: point.at,
						"Budget left": point.budget_remaining,
					})),
					axis: thresholdAxis(0, resolveColor(ready.theme, "var(--severity-error)"), "0%", false),
					context: ready,
					toMessage: (message) => Message.GotBudgetChartMessage({ message }),
				}),
			),
		]),
	])

/** The SLI of each hour against the target; hours without events leave a gap. */
export const sliPanel = (h: H, model: Model, slo: Slo, context: ChartContext | null): Html =>
	panel(h, { attributes: [h.AriaLabel("SLI")] }, [
		panelHeader(h, {
			title: "SLI",
			divided: false,
			action: typography(h, { size: "xs", tone: "muted" }, [`Hourly, target ${formatTarget(slo)}`]),
		}),
		panelChartBody(h, [
			historyBody(h, model, context, (points, ready) =>
				chartSlot(h, {
					slotId: "slo-sli-chart",
					chartId: "slo-sli",
					chart: model.sliChart,
					rows: Arr.flatMap(points, (point) =>
						point.sli === null ? [] : [{ bucket: point.at, SLI: point.sli }],
					),
					axis: thresholdAxis(
						slo.target_percent / 100,
						resolveColor(ready.theme, "var(--severity-warn)"),
						`Target ${formatTarget(slo)}`,
						true,
					),
					context: ready,
					toMessage: (message) => Message.GotSliChartMessage({ message }),
				}),
			),
		]),
	])

// BURN RATES

const BURN_WINDOWS = [5, 30, 60, 360] as const

const SEVERITY_LABEL = { critical: "Critical", warning: "Warning" } as const satisfies Record<
	AlertSeverity,
	string
>
const TIER_ROLE = { critical: "pages", warning: "opens a ticket" } as const satisfies Record<
	AlertSeverity,
	string
>

const burnWindowRow = (h: H, status: SloStatus, minutes: number): Html => {
	const rate = burnOf(status, minutes)
	const window = Arr.findFirst(status.burn_windows, (entry) => entry.window_minutes === minutes)
	return h.div(
		[h.Key(String(minutes)), h.Class(stripClass("row"))],
		[
			hstack(h, { gap: "3", justify: "between" }, [
				typography(h, { size: "sm" }, [`Last ${windowLabel(minutes)}`]),
				hstack(h, { gap: "3" }, [
					typography(h, { size: "xs", tone: "muted", mono: true, numeric: true }, [
						Option.match(window, {
							onNone: () => "–",
							onSome: (entry) => `${formatEvents(entry.total_events)} events`,
						}),
					]),
					typography(
						h,
						{
							size: "sm",
							mono: true,
							numeric: true,
							weight: "medium",
							tone: toneText(burnTone(rate)),
						},
						[formatBurn(rate)],
					),
				]),
			]),
		],
	)
}

const tierRow = (h: H, status: SloStatus, state: ReturnType<typeof tierStates>[number]): Html => {
	const { tier, isFiring } = state
	const long = burnOf(status, tier.longWindowMinutes)
	const short = burnOf(status, tier.shortWindowMinutes)
	return h.div(
		[h.Key(tier.severity), h.Class(stripClass("row"))],
		[
			vstack(h, { gap: "1.5" }, [
				hstack(h, { gap: "2", justify: "between" }, [
					hstack(h, { gap: "2" }, [
						severityBadge(h, tier.severity),
						typography(h, { size: "xs", tone: "muted" }, [
							`${tier.factor}x over ${windowLabel(tier.longWindowMinutes)} and ${windowLabel(tier.shortWindowMinutes)}`,
						]),
					]),
					isFiring
						? hstack(h, { gap: "1.5", as: "span", className: "shrink-0" }, [
								statusDot(h, { tone: tier.severity === "critical" ? "crit" : "warn" }),
								typography(
									h,
									{
										size: "xs",
										weight: "medium",
										tone: tier.severity === "critical" ? "error" : "warning",
									},
									["Would fire"],
								),
							])
						: typography(h, { size: "xs", tone: "muted" }, ["Quiet"]),
				]),
				typography(h, { size: "xs", tone: "muted", mono: true, numeric: true, as: "p" }, [
					`${windowLabel(tier.longWindowMinutes)} at ${formatBurn(long)}, ${windowLabel(tier.shortWindowMinutes)} at ${formatBurn(short)}. ${SEVERITY_LABEL[tier.severity]} ${TIER_ROLE[tier.severity]} when both reach ${tier.factor}x.`,
				]),
			]),
		],
	)
}

/** Each window's burn rate, then the two tiers against their factors and whether they would fire. */
export const burnPanel = (h: H, model: Model): Html =>
	panel(h, { attributes: [h.AriaLabel("Burn rate")] }, [
		panelHeader(h, { title: "Burn rate" }),
		Option.match(AsyncData.getData(model.status.data), {
			onNone: () =>
				AsyncData.isFailure(model.status.data)
					? emptyMessage(h, { className: "px-4 py-6" }, ["No burn rates without the status"])
					: panelBody(h, [chartSkeleton(h, "bar")]),
			onSome: (status) =>
				h.div(
					[],
					[
						...Arr.map(BURN_WINDOWS, (minutes) => burnWindowRow(h, status, minutes)),
						...Arr.map(tierStates(status), (state) => tierRow(h, status, state)),
					],
				),
		}),
	])

// ALERTING

const destinationNames = (model: Model, ids: ReadonlyArray<string>): string => {
	if (ids.length === 0) return "Nobody, the incident still opens in the inbox"
	const fallback = model.destinations === null ? "Destination" : "Unavailable destination"
	return Arr.join(
		Arr.map(ids, (id) =>
			Option.getOrElse(
				Option.map(
					Arr.findFirst(model.destinations ?? [], (row) => row.id === id),
					(row) => row.name,
				),
				() => fallback,
			),
		),
		", ",
	)
}

const tierDestinations = (h: H, label: string, names: string): Html =>
	h.div(
		[h.Class(stripClass("row"))],
		[
			vstack(h, { gap: "0.5" }, [
				typography(h, { size: "xs", tone: "muted" }, [label]),
				typography(h, { size: "sm" }, [names]),
			]),
		],
	)

/** Whether the burn-rate alert runs, with its switch for managers, and who each tier notifies. */
export const alertingPanel = (h: H, model: Model, slo: Slo): Html =>
	panel(h, { attributes: [h.AriaLabel("Alerting")] }, [
		panelHeader(h, {
			title: "Alerting",
			action: hstack(h, { gap: "2" }, [
				typography(h, { size: "xs", tone: "muted" }, [slo.alerting.enabled ? "On" : "Off"]),
				...switchControl(h, {
					id: "slo-alerting",
					inputId: "slo-alerting-input",
					isChecked: slo.alerting.enabled,
					isDisabled: !canManage(model) || model.isTogglingAlerting,
					ariaLabel: "Burn-rate alerting",
					onToggle: Message.ClickedToggleAlerting(),
				}),
			]),
		}),
		...(slo.alerting.enabled
			? [
					tierDestinations(
						h,
						"Critical notifies",
						destinationNames(model, slo.alerting.critical_destination_ids),
					),
					tierDestinations(
						h,
						"Warning notifies",
						destinationNames(model, slo.alerting.warning_destination_ids),
					),
				]
			: [
					emptyMessage(h, { className: "px-4 py-4" }, [
						"Burn-rate alerts are off: no incident opens however fast the budget burns.",
					]),
				]),
	])

// INCIDENTS

const incidentRow = (h: H, row: AlertIncidentRow, nowMs: number, timeZone: string): Html =>
	listRow(h, {
		href: incidentHref(row.id),
		divided: true,
		density: "compact",
		leading: statusDot(h, { tone: row.status === "open" ? "crit" : "neutral" }),
		title: row.status === "open" ? "Open" : "Resolved",
		meta: relativeTime(h, {
			value: isoMs(row.first_triggered_at),
			nowMs,
			timeZone,
			tooltip: "title",
			prefix: "Opened",
		}),
		trailing: severityBadge(h, row.severity === "critical" ? "critical" : "warning"),
	})

/** The incidents of the SLO's burn-rate rule, newest first, each linking to its page. */
export const incidentsPanel = (h: H, model: Model, slo: Slo, timeZone: string): Html => {
	const rows = sloIncidents(slo, model.incidents ?? [])
	return panel(h, { attributes: [h.AriaLabel("Incidents")] }, [
		panelHeader(h, { title: "Incidents" }),
		model.incidents === null
			? panelBody(h, [chartSkeleton(h, "bar")])
			: rows.length === 0
				? emptyMessage(h, { className: "px-4 py-4" }, [
						slo.alerting.enabled ? "No incidents yet" : "No incidents: alerting is off",
					])
				: h.div(
						[],
						Arr.map(rows.slice(0, INCIDENT_ROWS), (row) =>
							incidentRow(h, row, model.nowMs ?? 0, timeZone),
						),
					),
	])
}
