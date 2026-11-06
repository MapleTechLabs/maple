import type { V2AnomalyServiceCount } from "@maple/domain/http/v2"
import { formatErrorRate, formatLatency, formatThroughput } from "@maple/ui/lib/format"
import { latencyToneClass } from "@maple/ui/lib/latency-tone"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { HEALTH_TONE, primaryServiceHealthCause } from "../../components/dashboard/service-health"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyOnFailure } from "../../data/enrichment"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { AppRoute, hrefOf } from "../../route"
import { card } from "@maple/views/ui/card"
import { badge } from "@maple/views/ui/display"
import { errorState } from "@maple/views/ui/error-state"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { listRow } from "@maple/views/ui/list-row"
import { skeletonList } from "@maple/views/ui/skeleton"
import { statusDot } from "@maple/views/ui/status-dot"
import { serviceDot } from "@maple/views/ui/values"
import {
	countByHealth,
	type EnrichedService,
	enrichServices,
	type ServiceHealth,
	type ServiceHealthCause,
} from "./derive"
import type { HealthSnapshot, Incident, Model } from "./model"
import { alertFiringHero } from "./view-hero"
import { statRail, statRailItem, statRailLoading } from "../kit/stat-rail"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr, Option } from "effect"

// The service health overview: the alerts banner and
// the health summary rail above the usage cards.

export type HealthData = readonly [
	ReadonlyArray<HealthSnapshot>,
	ReadonlyArray<V2AnomalyServiceCount>,
	ReadonlyArray<Incident>,
]

/** `Result.all([snapshot, anomalies, alertIncidents])`. */
export const healthData = (model: Model): AsyncData.AsyncData<HealthData, LoadFailure> =>
	AsyncData.all([
		model.snapshot.data,
		emptyOnFailure(model.anomalies.data),
		emptyOnFailure(model.incidents),
	])

export type SliceSearch = Readonly<{
	startTime: string | undefined
	endTime: string | undefined
	timePreset: string
	environments: ReadonlyArray<string> | undefined
}>

/** `servicesLinkSearch`: the dashboard's slice carried over to `/services`. */
export const servicesHref = (slice: SliceSearch, health?: ServiceHealth): string =>
	hrefOf(
		AppRoute.Services({
			search: {
				startTime: slice.startTime,
				endTime: slice.endTime,
				timePreset: slice.timePreset,
				environments: slice.environments,
				health,
			},
		}),
	)

const railAction = <M>(h: HtmlBuilder<M>, slice: SliceSearch, health?: ServiceHealth): Html =>
	h.a(
		[
			h.Href(servicesHref(slice, health)),
			h.AriaLabel(health === undefined ? "View all services" : `View ${health} services`),
			h.Class("text-foreground-faint hover:text-foreground active:text-foreground"),
		],
		[icon(h, "ArrowRightIcon", { className: "size-3" })],
	)

const section = <M>(
	h: HtmlBuilder<M>,
	className: string,
	isWaiting: boolean,
	children: ReadonlyArray<Html>,
) =>
	h.section(
		[h.Class(cn(className, refreshingClass(isWaiting))), ...(isWaiting ? [h.AriaBusy(true)] : [])],
		children,
	)

export type HealthOverviewInputs = Readonly<{
	model: Model
	slice: SliceSearch
	nowMs: number
}>

/** `ServiceHealthOverview`: the banner once alerts are known; the rail loading, absent on error, counted on success. */
export const healthOverview = <M>(h: HtmlBuilder<M>, { model, slice, nowMs }: HealthOverviewInputs): Html => {
	const incidents = AsyncData.getOrElse(model.incidents, () => [])
	const open = Arr.filter(incidents, (incident) => incident.status === "open")
	const rules = AsyncData.getOrElse(model.rules, () => [])
	// "All clear" claims to know: without live alerts (loading or sync down) the banner stays out.
	const isAlertsKnown = AsyncData.isSuccess(model.incidents) && AsyncData.isSuccess(model.rules)
	const banner = !isAlertsKnown
		? []
		: [
				alertFiringHero(h, {
					openCount: open.length,
					criticalCount: Arr.filter(open, (incident) => incident.severity === "critical").length,
					warningCount: Arr.filter(open, (incident) => incident.severity === "warning").length,
					rulesEnabled: Arr.filter(rules, (enabled) => enabled).length,
					rulesTotal: rules.length,
				}),
			]
	const data = healthData(model)
	return AsyncData.matchData(data, {
		onEmpty: () => section(h, "mb-4 space-y-3", false, [...banner, statRailLoading(h, 4)]),
		// An empty section keeps no margin, or the page strip's gap above the usage rail doubles.
		onFailure: () => section(h, banner.length > 0 ? "mb-4 space-y-3" : "space-y-3", false, banner),
		onData: ([snapshot, anomalies, alerts]) => {
			const counts = countByHealth(
				enrichServices(
					snapshot,
					Arr.filter(alerts, (incident) => incident.status === "open"),
					anomalies,
					nowMs,
				),
			)
			const tone = (health: ServiceHealth, active: "ok" | "warn" | "crit") =>
				counts[health] > 0 ? active : "neutral"
			return section(h, "mb-4 space-y-3", AsyncData.isRefreshing(data), [
				...banner,
				statRail(h, {}, [
					statRailItem(h, {
						eyebrow: "Services",
						value: String(snapshot.length),
						action: railAction(h, slice),
					}),
					statRailItem(h, {
						eyebrow: "Healthy",
						value: String(counts.healthy),
						tone: tone("healthy", "ok"),
						action: railAction(h, slice, "healthy"),
					}),
					statRailItem(h, {
						eyebrow: "Degraded",
						value: String(counts.degraded),
						tone: tone("degraded", "warn"),
						action: railAction(h, slice, "degraded"),
					}),
					statRailItem(h, {
						eyebrow: "Unhealthy",
						value: String(counts.unhealthy),
						tone: tone("unhealthy", "crit"),
						action: railAction(h, slice, "unhealthy"),
					}),
				]),
			])
		},
	})
}

const listHeader = <M>(h: HtmlBuilder<M>, slice: SliceSearch): Html =>
	hstack(h, { justify: "between" }, [
		h.div(
			[],
			[
				eyebrow(h, { variant: "label", as: "h2" }, ["Services"]),
				h.p(
					[h.Class("mt-0.5 font-prose text-2xs text-foreground-subtle")],
					["Status reflects active alerts and baseline anomalies."],
				),
			],
		),
		h.a(
			[
				h.Href(servicesHref(slice)),
				h.Class(
					"text-xs font-medium text-muted-foreground hover:text-foreground active:text-foreground",
				),
			],
			["View all services →"],
		),
	])

const MAX_ROWS = 7

export type HealthListInputs = HealthOverviewInputs &
	Readonly<{
		/** The services empty state, with its presence-driven copy. */
		emptyState: Html
		/** The org never sent traces: the empty state shows without waiting on the snapshot. */
		isNeverReceived: boolean
	}>

/** `ServiceHealthList`: up to seven rows, worst first, under the section header. */
export const healthList = <M>(
	h: HtmlBuilder<M>,
	{ model, slice, nowMs, emptyState, isNeverReceived }: HealthListInputs,
): Html => {
	const data = healthData(model)
	return AsyncData.matchData(data, {
		onEmpty: () =>
			isNeverReceived
				? section(h, "mt-4 space-y-3", false, [
						listHeader(h, slice),
						card(h, [emptyState], "overflow-hidden p-0"),
					])
				: section(h, "mt-4 space-y-3", false, [
						listHeader(h, slice),
						card(
							h,
							[skeletonList(h, { rows: 4, rowClassName: "h-6", gap: "2", className: "p-4" })],
							"overflow-hidden p-0",
						),
					]),
		onFailure: (failure) =>
			section(h, "mt-4 space-y-3", false, [listHeader(h, slice), errorState(h, { failure })]),
		onData: ([snapshot, anomalies, alerts]) => {
			const rows = enrichServices(
				snapshot,
				Arr.filter(alerts, (incident) => incident.status === "open"),
				anomalies,
				nowMs,
			).slice(0, MAX_ROWS)
			return section(h, "mt-4 space-y-3", AsyncData.isRefreshing(data), [
				listHeader(h, slice),
				card(
					h,
					[
						rows.length === 0
							? emptyState
							: h.ul(
									[h.Class("divide-y divide-border")],
									Arr.map(rows, (row) => serviceRow(h, row, slice)),
								),
					],
					"overflow-hidden p-0",
				),
			])
		},
	})
}

type MetricTone = "ok" | "warn" | "crit"

const metricTone = (cause: ServiceHealthCause | undefined): MetricTone =>
	cause === undefined ? "ok" : cause.severity === "critical" ? "crit" : "warn"

/** `Metric`: a right-aligned value over its eyebrow; `valueClassName` wins over the tone. */
const metric = <M>(
	h: HtmlBuilder<M>,
	label: string,
	value: string,
	tone: MetricTone,
	valueClassName?: string,
): Html =>
	h.div(
		[h.Class("flex w-16 flex-col items-end gap-0.5")],
		[
			h.span([h.Class(cn("leading-none", TONE_TEXT[tone], valueClassName))], [value]),
			eyebrow(h, {}, [label]),
		],
	)

const causeBadge = <M>(h: HtmlBuilder<M>, cause: ServiceHealthCause): Html => {
	const direction = cause.direction
	const description =
		direction === "up"
			? `${cause.label}: increased above baseline`
			: direction === "down"
				? `${cause.label}: decreased below baseline`
				: cause.label
	return badge(
		h,
		{
			variant: cause.severity === "critical" ? "crit" : "warn",
			size: "sm",
			className: cn("shrink-0", direction !== undefined && "pr-1 pl-0.5"),
			attributes: [h.Title(description), h.AriaLabel(description)],
		},
		[
			...(direction === undefined
				? []
				: [
						icon(h, direction === "up" ? "ArrowTrendUpIcon" : "ArrowTrendDownIcon", {
							size: 12,
							attributes: [h.AriaHidden(true)],
						}),
					]),
			cause.label,
		],
	)
}

/** `serviceDetailSearch` plus the row's environment: the service page scoped to it. */
const serviceHref = (slice: SliceSearch, service: HealthSnapshot): string =>
	hrefOf(
		AppRoute.Service({
			serviceName: service.serviceName,
			search: {
				startTime: slice.startTime,
				endTime: slice.endTime,
				timePreset: slice.timePreset,
				environments: [service.environment],
			},
		}),
	)

/** `ServiceHealthRow`. */
const serviceRow = <M>(
	h: HtmlBuilder<M>,
	{ service, health, causes }: EnrichedService,
	slice: SliceSearch,
): Html => {
	const primary = primaryServiceHealthCause(causes)
	const causeOf = (kind: ServiceHealthCause["metric"]) =>
		Option.getOrUndefined(Arr.findFirst(causes, (cause) => cause.metric === kind))
	const latencyCause = causeOf("latency")
	return h.li(
		[h.Key(`${service.serviceName}:${service.environment}`)],
		[
			listRow(h, {
				href: serviceHref(slice, service),
				leading: statusDot(h, { tone: HEALTH_TONE[health], size: "lg" }),
				title: hstack(h, { gap: "2", shrink: true, as: "span" }, [
					serviceDot(h, { serviceName: service.serviceName, size: "sm" }),
					h.span([h.Class("truncate text-sm font-medium text-foreground")], [service.serviceName]),
					badge(h, { variant: "muted", size: "xs", className: "shrink-0" }, [service.environment]),
					...(primary === undefined ? [] : [causeBadge(h, primary)]),
				]),
				trailing: h.div(
					[h.Class("flex shrink-0 items-center gap-5 font-mono text-xs tabular-nums")],
					[
						metric(h, "err", formatErrorRate(service.errorRate), metricTone(causeOf("error"))),
						metric(
							h,
							"p95",
							formatLatency(service.p95LatencyMs),
							metricTone(latencyCause),
							latencyCause === undefined
								? latencyToneClass(service.p95LatencyMs, "p95")
								: undefined,
						),
						metric(
							h,
							"rps",
							formatThroughput(service.throughput, "/s"),
							metricTone(causeOf("traffic")),
						),
					],
				),
			}),
		],
	)
}
