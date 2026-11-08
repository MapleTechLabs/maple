import { formatTimeInTimezone } from "@maple/web-data/lib/timezone-format"
import { Option, Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "@maple/views/ui/button"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { alert, alertAction, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { skeleton } from "@maple/views/ui/skeleton"
import { timestamp } from "@maple/views/ui/timestamp"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { detailActions, detailTitle, detailTitleSkeleton } from "../../kit/detail-header"
import { resourceNotFound } from "../../kit/resource-not-found"
import { incidentHref } from "../shared/links"
import { editMonitorHref, traceHref, uptimeTabHref } from "../shared/uptime-commands"
import {
	displayStatus,
	formatEvery,
	KIND_LABEL,
	requestLine,
	type UptimeMonitor,
} from "../shared/uptime-derive"
import { uptimeStatusChip } from "../shared/uptime-view"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { monitorOf } from "./update"
import { isChartRuntimeReady } from "@maple/views/charts/chart-runtime"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import {
	CHART_TOKENS,
	type ChartContext,
	checksPanel,
	checksScatterPanel,
	heartbeatPanel,
	kpiRail,
	lastCheckPanel,
	phaseBreakdownPanel,
	responseTimePanel,
	setupPanel,
} from "./view-panels"
import { typography } from "@maple/views/ui/typography"
import { vstack } from "@maple/views/ui/stack"

// `/alerts/uptime/$monitorId`: the header, the incident block when down, then the panels.

type H = HtmlBuilder<Message>

/** "expects 2xx under 2000 ms", from the status and latency assertions. */
const expectation = (monitor: UptimeMonitor): string | null => {
	if (monitor.config.type !== "http") return null
	const assertions = monitor.config.assertions ?? []
	const status = Arr.flatMap(assertions, (assertion) =>
		assertion.type === "status" && assertion.op === "is" ? [assertion.value] : [],
	)[0]
	const latency = Arr.flatMap(assertions, (assertion) =>
		assertion.type === "latency" ? [assertion.under_ms] : [],
	)[0]
	if (status === undefined && latency === undefined) return null
	return Arr.join(
		Arr.filter(
			["expects", status ?? "", latency === undefined ? "" : `under ${latency} ms`],
			(part) => part !== "",
		),
		" ",
	)
}

const eyebrowLine = (monitor: UptimeMonitor): string =>
	monitor.kind === "heartbeat"
		? "Heartbeat monitor"
		: `${KIND_LABEL[monitor.kind]} monitor · every ${formatEvery(monitor.interval_seconds)}`

const headerActions = (h: H, model: Model, monitor: UptimeMonitor): Html =>
	detailActions(h, [
		...(canManage(model)
			? [
					button(
						h,
						{
							size: "sm",
							variant: "outline",
							isLoading: model.isToggling,
							attributes: [h.OnClick(Message.ClickedToggle())],
						},
						[
							icon(h, monitor.enabled ? "MediaPauseIcon" : "MediaPlayIcon"),
							monitor.enabled ? "Pause" : "Resume",
						],
					),
					linkButton(h, { size: "sm", variant: "outline", href: editMonitorHref(monitor.id) }, [
						icon(h, "PencilIcon"),
						"Edit",
					]),
				]
			: []),
		...(monitor.config.type === "http" && canManage(model)
			? [
					button(
						h,
						{
							size: "sm",
							isLoading: model.isChecking,
							attributes: [h.OnClick(Message.ClickedCheckNow())],
						},
						[icon(h, "ArrowRotateClockwiseIcon"), "Check now"],
					),
				]
			: []),
	])

/** The open incident of the monitor's backing alert rule. */
const openIncidentId = (model: Model, monitor: UptimeMonitor): string | null =>
	monitor.alert_rule_id === null
		? null
		: Arr.findFirst(
				model.incidents ?? [],
				(row) => row.rule_id === monitor.alert_rule_id && row.status === "open",
			).pipe(
				Option.flatMapNullishOr((found) => found.id),
				Option.getOrNull,
			)

/** "Returning 503 since 14:02:18", the check's error, and the way to the failing trace. */
const incidentBlock = (h: H, model: Model, monitor: UptimeMonitor, timeZone: string): Html => {
	const last = monitor.state.last_check
	const changed = monitor.state.status_changed_at
	const since: ReadonlyArray<Html | string> =
		changed === null
			? []
			: [
					" since ",
					timestamp(h, {
						value: changed,
						timeZone,
						label: formatTimeInTimezone(changed, { timeZone, withSeconds: true }),
					}),
				]
	const headline = [
		last?.status_code === null || last === null ? "Failing" : `Returning ${last.status_code}`,
		...since,
	]
	const incidentId = openIncidentId(model, monitor)
	const actions = [
		...(incidentId === null
			? []
			: [
					linkButton(h, { size: "sm", variant: "outline", href: incidentHref(incidentId) }, [
						"Open incident",
					]),
				]),
		...(last?.trace_id === null || last === null
			? []
			: [
					linkButton(h, { size: "sm", variant: "outline", href: traceHref(last.trace_id) }, [
						"Open failing trace",
						icon(h, "ArrowRightIcon"),
					]),
				]),
	]
	// An alert, not a panel: an overflow-hidden panel in the page column shrinks to its border.
	return alert(h, { variant: "crit" }, [
		icon(h, "CircleXmarkIcon"),
		alertTitle(h, headline),
		...(last?.error === null || last === null ? [] : [alertDescription(h, [last.error])]),
		...(actions.length === 0 ? [] : [alertAction(h, actions)]),
	])
}

const serviceHrefOf = (monitor: UptimeMonitor): string | null =>
	monitor.service_name === null
		? null
		: hrefOf(AppRoute.Service({ serviceName: monitor.service_name, search: {} }))

const body = (
	h: H,
	model: Model,
	monitor: UptimeMonitor,
	timeZone: string,
	nowMs: number,
): ReadonlyArray<Html> => {
	const chartContext: ChartContext | null =
		model.themeColors !== null && isChartRuntimeReady(model.chartRuntime)
			? { theme: model.themeColors, timeZone, nowMs }
			: null
	return [
		...(displayStatus(monitor) === "down" ? [incidentBlock(h, model, monitor, timeZone)] : []),
		kpiRail(h, model, monitor, nowMs, timeZone),
		h.div(
			[h.Class("grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]")],
			[
				vstack(h, { gap: "4", shrink: true }, [
					...(monitor.heartbeat_url === null
						? []
						: [heartbeatPanel(h, model, monitor.heartbeat_url)]),
					...(monitor.kind === "heartbeat" ? [] : [responseTimePanel(h, model, chartContext)]),
					...(monitor.config.type === "http" ? [phaseBreakdownPanel(h, model, chartContext)] : []),
					...Arr.flatMap([checksScatterPanel(h, model, timeZone)], (panel) =>
						panel === null ? [] : [panel],
					),
					checksPanel(h, monitor, timeZone),
				]),
				vstack(h, { gap: "4" }, [
					lastCheckPanel(h, monitor),
					setupPanel(h, model, monitor, serviceHrefOf(monitor)),
				]),
			],
		),
	]
}

const loadingPage = (h: H): Html =>
	dashboardPage(h, { titleContent: detailTitleSkeleton(h) }, [
		skeleton(h, "h-40 w-full"),
		skeleton(h, "h-64 w-full"),
	])

const notFound = (h: H, model: Model): Html =>
	dashboardPage(h, {}, [
		resourceNotFound(h, {
			title: "Monitor not found",
			description: [
				"No uptime monitor has the id ",
				h.code([h.Class("font-mono")], [model.rawMonitorId]),
				".",
			],
			back: { href: uptimeTabHref(), label: "Back to uptime" },
		}),
	])

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: CHART_TOKENS }))],
		[page(h, model, inputs)],
	),
)

const page = (h: H, model: Model, inputs: PageViewInputs): Html => {
	if (model.monitorId === null) return notFound(h, model)
	const data = model.monitor.data
	if (AsyncData.isFailure(data))
		return data.error.code === "uptime_monitor_not_found"
			? notFound(h, model)
			: dashboardPage(h, {}, [
					errorState(h, {
						failure: data.error,
						title: "Couldn't load the monitor",
						onRetry: Message.ClickedRetry(),
					}),
				])
	const nowMs = model.nowMs ?? 0
	const timeZone = inputs.context.timeZone
	return Option.match(monitorOf(model), {
		onNone: () => loadingPage(h),
		onSome: (monitor) => {
			const expects = expectation(monitor)
			return dashboardPage(
				h,
				{
					titleContent: detailTitle(h, {
						kind: [eyebrowLine(monitor)],
						title: [monitor.name],
						adornment: uptimeStatusChip(h, monitor, nowMs),
						meta: [
							typography(h, { size: "xs", tone: "muted", mono: true }, [
								requestLine(monitor),
								...(expects === null ? [] : [` · ${expects}`]),
							]),
						],
					}),
					actions: headerActions(h, model, monitor),
					gap: "md",
				},
				body(h, model, monitor, timeZone, nowMs),
			)
		},
	})
}

/** The H1 names the monitor, so the trail stops at the tab. */
export const breadcrumbsOf = () => [
	{ label: "Alerts", href: "/alerts" },
	{ label: "Uptime", href: uptimeTabHref() },
]
