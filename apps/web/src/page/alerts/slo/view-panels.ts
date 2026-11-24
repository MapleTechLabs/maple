import type { AlertSeverity } from "@maple/domain/http"
import { SLO_BURN_WINDOWS_MINUTES, windowLabel } from "@maple/domain/slo"
import type { AlertIncidentRow } from "@maple/web-data/collections/alerts"
import { makeClientErrorBody } from "@maple/web-data/lib/error-messages"
import type { Tone } from "@maple/ui/lib/tone"
import { Option, Array as Arr, String as Str } from "effect"
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
import { severityBadge, ALERT_SEVERITY_LABEL } from "../shared/badges"
import { incidentHref } from "../../kit/alert-links"
import {
	burnOf,
	burnTone,
	budgetToneOf,
	formatBudget,
	formatBurn,
	formatEventCount,
	formatEvents,
	formatSli,
	formatTarget,
	formatWindow,
	type Slo,
	type SloStatus,
	sliTone,
	factorOf,
	formatFactor,
	hasNoData,
	holdReason,
	holdingLine,
	isBudgetIncidentRow,
	isBudgetSpent,
	isCapped,
	isSpent,
	maxBurnLine,
	NO_DATA_HINT,
	sloIncidents,
	type TierReading,
	tierStates,
	overspentText,
} from "../shared/slo-derive"
import { toneText } from "../shared/slo-view"
import { Message } from "./message"
import { type Model } from "./model"
import { canManageAlerts } from "../../kit/session-grants"
import { gatedSwitch } from "../../kit/gated-controls"
import { toEpochMs } from "@maple/ui/lib/time-format"

type H = HtmlBuilder<Message>

/** The tokens the charts resolve: their series and chrome, the 0% line and the target line. */
export const CHART_TOKENS = AreaChart.AREA_CHART_TOKENS

export type ChartContext = Readonly<{ theme: ThemeColors; timeZone: string; nowMs: number }>

const INCIDENT_ROWS = 5

/** The budget tile: "No data" with no events, and no verdict on a handful of them. */
const budgetFigure = (
	slo: Slo,
	status: SloStatus,
): Readonly<{ value: string; tone: Tone; subline: string; eyebrowTooltip?: string }> => {
	if (hasNoData(status))
		return {
			value: "No data",
			tone: "neutral",
			subline: "No events to measure it against",
			eyebrowTooltip: NO_DATA_HINT,
		}
	const budget = status.budget_remaining
	const figure = { value: formatBudget(budget), tone: budgetToneOf(slo, status) }
	if (!isBudgetSpent(budget)) return { ...figure, subline: `Of the ${slo.window_days}-day budget` }
	// One failure in a handful of requests overspends any budget: the evaluator does not call it spent.
	if (!isSpent(slo, status)) return { ...figure, subline: "Too few events to judge" }
	return { ...figure, subline: budget < 0 ? `Spent: ${overspentText(budget)}` : "Fully spent" }
}

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
					compact: true,
					...budgetFigure(slo, status),
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
	failureTitle: string,
	draw: (points: NonNullable<ReturnType<typeof historyPoints>>, context: ChartContext) => Html,
): Html => {
	const data = model.history.data
	if (AsyncData.isFailure(data))
		return errorState(h, {
			failure: data.error,
			title: failureTitle,
			onRetry: Message.ClickedRetryHistory(),
			className: "py-8",
		})
	const points = historyPoints(model)
	// One point per hour comes back either way; a window with no events has no SLI in any of them.
	if (points !== null && Arr.every(points, (point) => point.sli === null))
		return emptyMessage(h, { className: "py-16 text-center" }, ["No events in this window"])
	if (points === null || context === null)
		return model.chartRuntime._tag === "Failed"
			? emptyMessage(h, { className: "py-16 text-center" }, [
					"The chart couldn't load. Reload the page to try again.",
				])
			: h.div([h.Class("h-56")], [chartSkeleton(h, "line")])
	return draw(points, context)
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
			historyBody(h, model, context, "Couldn't load the budget history", (points, ready) =>
				chartSlot(h, {
					slotId: "slo-budget-chart",
					chartId: "slo-budget",
					chart: model.budgetChart,
					rows: Arr.map(points, (point) => ({
						bucket: point.at,
						"Budget left": point.budget_remaining,
					})),
					// Budget never passes 100% but can go negative: cap the top, leave the floor free.
					axis: {
						...thresholdAxis(0, resolveColor(ready.theme, "var(--severity-error)"), "0%", false),
						max: 1,
						zeroLabel: "0%",
					},
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
			historyBody(h, model, context, "Couldn't load the SLI history", (points, ready) =>
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

const TIER_ROLE = { critical: "pages", warning: "opens a ticket" } as const satisfies Record<
	AlertSeverity,
	string
>

const burnWindowRow = (h: H, slo: Slo, status: SloStatus, minutes: number): Html => {
	const rate = burnOf(status, minutes)
	const window = Arr.findFirst(status.burn_windows, (entry) => entry.window_minutes === minutes)
	return h.div(
		[h.Key(String(minutes)), h.Class(stripClass("row"))],
		[
			hstack(h, { gap: "3", justify: "between" }, [
				typography(h, { size: "sm" }, [`Last ${windowLabel(minutes)}`]),
				hstack(h, { gap: "3" }, [
					typography(h, { size: "xs", tone: "muted", numeric: true }, [
						Option.match(window, {
							onNone: () => "–",
							onSome: (entry) => formatEventCount(entry.total_events),
						}),
					]),
					typography(
						h,
						{
							size: "sm",
							numeric: true,
							weight: "medium",
							tone: toneText(burnTone(slo, rate)),
						},
						[formatBurn(rate)],
					),
				]),
			]),
		],
	)
}

/** "Would fire" while both windows burn, "Holding" on nothing or too little to judge, else "Quiet". */
const tierVerdict = (h: H, reading: TierReading): Html => {
	const { tier, state } = reading
	if (state === "clear") return typography(h, { size: "xs", tone: "muted" }, ["Quiet"])
	const isCritical = tier.severity === "critical"
	return hstack(h, { gap: "1.5", as: "span", className: "shrink-0" }, [
		statusDot(h, { tone: state === "hold" ? "neutral" : isCritical ? "crit" : "warn" }),
		typography(
			h,
			{
				size: "xs",
				weight: "medium",
				tone: state === "hold" ? "soft" : isCritical ? "error" : "warning",
			},
			[state === "hold" ? "Holding" : "Would fire"],
		),
	])
}

/** What a tier reads now and when it fires; a capped factor says what lowered it. */
const tierLine = (slo: Slo, status: SloStatus, reading: TierReading): string => {
	const { tier, state } = reading
	if (state === "hold") return `${holdingLine(tier, holdReason(status, tier))}.`
	const long = `${windowLabel(tier.longWindowMinutes)} at ${formatBurn(burnOf(status, tier.longWindowMinutes))}`
	const short = `${windowLabel(tier.shortWindowMinutes)} at ${formatBurn(burnOf(status, tier.shortWindowMinutes))}`
	const fires = `${ALERT_SEVERITY_LABEL[tier.severity]} ${TIER_ROLE[tier.severity]} when both reach ${formatFactor(factorOf(slo, tier))}`
	return isCapped(slo, tier)
		? `${long}, ${short}. ${fires}, not ${formatFactor(tier.factor)}: ${Str.uncapitalize(maxBurnLine(slo))}.`
		: `${long}, ${short}. ${fires}.`
}

const tierRow = (h: H, slo: Slo, status: SloStatus, reading: TierReading): Html => {
	const { tier } = reading
	return h.div(
		[h.Key(`${tier.severity}-${tier.longWindowMinutes}`), h.Class(stripClass("row"))],
		[
			vstack(h, { gap: "1.5" }, [
				hstack(h, { gap: "2", justify: "between" }, [
					hstack(h, { gap: "2" }, [
						severityBadge(h, tier.severity),
						typography(h, { size: "xs", tone: "muted" }, [
							`${formatFactor(factorOf(slo, tier))} over ${windowLabel(tier.longWindowMinutes)} and ${windowLabel(tier.shortWindowMinutes)}`,
						]),
					]),
					tierVerdict(h, reading),
				]),
				typography(h, { size: "xs", tone: "muted", as: "p" }, [tierLine(slo, status, reading)]),
			]),
		],
	)
}

/** Each window's burn rate, then each tier against its factor for this target and whether it would fire. */
export const burnPanel = (h: H, model: Model, slo: Slo): Html =>
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
						...Arr.map(SLO_BURN_WINDOWS_MINUTES, (minutes) =>
							burnWindowRow(h, slo, status, minutes),
						),
						...Arr.map(tierStates(slo, status), (state) => tierRow(h, slo, status, state)),
					],
				),
		}),
	])

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
				...gatedSwitch(
					h,
					model,
					"alerts:manage",
					switchControl(h, {
						id: "slo-alerting",
						inputId: "slo-alerting-input",
						isChecked: slo.alerting.enabled,
						isDisabled: !canManageAlerts(model) || model.isTogglingAlerting,
						ariaLabel: "Burn-rate alerting",
						onToggle: Message.ClickedToggleAlerting(),
					}),
				),
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
						"Burn-rate alerts are off: no incident opens however fast the budget burns",
					]),
				]),
	])

/** A burn incident reads "Open" in red; the spent-budget one names itself and stays amber. */
const incidentRow = (h: H, row: AlertIncidentRow, nowMs: number, timeZone: string): Html => {
	const isOpen = row.status === "open"
	const isBudget = isBudgetIncidentRow(row)
	return listRow(h, {
		href: incidentHref(row.id),
		divided: true,
		density: "compact",
		leading: statusDot(h, { tone: isOpen ? (isBudget ? "warn" : "crit") : "neutral" }),
		title: isBudget ? (isOpen ? "Budget spent" : "Budget spent, resolved") : isOpen ? "Open" : "Resolved",
		meta: relativeTime(h, {
			value: toEpochMs(row.first_triggered_at),
			nowMs,
			timeZone,
			prefix: "Opened",
		}),
		trailing: severityBadge(h, row.severity === "critical" ? "critical" : "warning"),
	})
}

/** `SyncUnavailable`: the incidents stream stopped before its first answer. */
const SYNC_UNAVAILABLE = makeClientErrorBody({
	_tag: "@maple/web/errors/SyncUnavailable",
	code: "sync_unavailable",
	title: "Couldn't load incidents",
	message: "Live sync is unavailable.",
	retryable: false,
	recovery: "retry",
})

/** The incidents of the SLO's burn-rate rule, newest first, each linking to its page. */
export const incidentsPanel = (h: H, model: Model, slo: Slo, timeZone: string): Html => {
	const rows = sloIncidents(slo, model.incidents ?? [])
	return panel(h, { attributes: [h.AriaLabel("Incidents")] }, [
		panelHeader(h, { title: "Incidents" }),
		model.incidents === null
			? model.isIncidentsLoadFailed
				? errorState(h, {
						failure: SYNC_UNAVAILABLE,
						title: "Couldn't load incidents",
						onRetry: Message.ClickedRetryIncidents(),
						className: "py-8",
					})
				: panelBody(h, [chartSkeleton(h, "bar")])
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
