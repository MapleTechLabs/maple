import { GCP_INFRA_SERVICES, type GcpInfraServiceId } from "@maple/domain/gcp-infra"
import { formatWarehouseDateTime } from "@maple/query-engine/datetime"
import { GCP_GKE_NODE_CHARTS, GCP_INFRA_CHARTS } from "../../../../components/infra/gcp/charts"
import { gcpSqlEngine, gcpSqlSize } from "../../../../components/infra/gcp/cloud-sql-signals"
import { gcpConsoleLinks, gcpExplorerWhere } from "../../../../components/infra/gcp/inventory"
import {
	gcpWorkloadLocation,
	gcpWorkloadName,
	gcpWorkloadNoun,
	gcpWorkloadProject,
} from "../../../../components/infra/gcp/tabs"
import type { GcpTraceGap } from "../../../../components/infra/gcp/workload-signals"
import type { ErrorRateLevel } from "@maple/ui/lib/error-rate"
import { formatNumber } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { INFRA_CHART_TOKENS } from "../../../../charts/infra-metric-series"
import { ResolveThemeColors } from "../../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../../route"
import { chartLoading } from "../../../../ui/chart-state"
import { emptyMessage } from "../../../../ui/empty"
import { errorState } from "../../../../ui/error-state"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { CHART_HEIGHT } from "../../kit/chart-card"
import { heroChip } from "../../../infra/kit/hero-chip"
import { pageHero } from "../../../infra/kit/page-parts"
import { pageTime } from "../../kit/page-time"
import { sectionHeading } from "../../../kit/section-heading"
import { gcpServiceIcon } from "../service-icon"
import { type PageData, pageOf } from "./derive"
import { Message, type Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { type ChartsContext, correlationStrips, workloadCharts } from "./view-charts"
import { resolveQueryPeek } from "./peek"
import { workloadRail } from "./view-rail"
import { appWaitCallout, figure, topQueries } from "./view-sql"
import { queryPeekSheet } from "./view-sql-peek"

// `GcpWorkloadPage`.

type H = HtmlBuilder<Message>
type TimeSearch = Readonly<{ startTime?: string; endTime?: string; timePreset?: string }>

const SERVICE_KIND = {
	cloudRun: "cloud run",
	cloudFunctions: "function 1st gen",
	gke: "gke container",
	computeEngine: "vm instance",
	cloudSql: "cloud sql",
	pubsub: "pub/sub subscription",
	loadBalancing: "load balancer",
} as const satisfies Record<GcpInfraServiceId, string>

const HEALTH_DOT = {
	crit: "bg-severity-error",
	warn: "bg-severity-warn",
	neutral: "bg-severity-info",
} as const satisfies Record<ErrorRateLevel, string>

const BARE_IDENTITY = ["Region", "Zone", "Location"]
const RAIL_IDENTITY = ["Project"]

/** `GcpWorkloadHeader`, with `GcpCloudSqlChips` as a Cloud SQL instance's meta. */
const header = (h: H, model: Model, data: PageData): Html => {
	const service = model.service
	const keys = data.keys
	const engine = gcpSqlEngine(data.databaseVersion ?? null)
	const services = data.traceSide?.services
	const machine = [
		keys[2] || undefined,
		data.instance === undefined ? undefined : gcpSqlSize(data.instance),
		data.instance?.availabilityType === "REGIONAL" ? "HA" : undefined,
	].filter((part): part is string => part !== undefined)
	const meta = data.isCloudSql
		? [
				heroChip(h, engine?.toLowerCase() ?? SERVICE_KIND.cloudSql),
				...(services === undefined || services === 0
					? []
					: [heroChip(h, `queried by ${services} ${services === 1 ? "service" : "services"}`)]),
				...(machine.length === 0 ? [] : [heroChip(h, machine.join(" · "))]),
			]
		: [
				heroChip(h, SERVICE_KIND[service]),
				...GCP_INFRA_SERVICES[service].identity.slice(1).flatMap(([label], index) => {
					const value = keys[index + 1]
					if (!value || RAIL_IDENTITY.includes(label)) return []
					return [
						heroChip(
							h,
							BARE_IDENTITY.includes(label) ? value : `${label.toLowerCase()} ${value}`,
						),
					]
				}),
			]
	return pageHero(h, {
		title: h.span(
			[h.Class("flex items-center gap-3")],
			[
				h.span(
					[h.Class("relative")],
					[
						gcpServiceIcon(h, { service, databaseVersion: data.databaseVersion, size: "lg" }),
						...(data.health === null
							? []
							: [
									h.span([
										h.AriaHidden(true),
										h.Class(
											cn(
												"absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background",
												HEALTH_DOT[data.health],
											),
										),
									]),
								]),
					],
				),
				h.span([h.Class("font-mono")], [gcpWorkloadName(service, keys)]),
			],
		),
		meta,
	})
}

const GAP_COPY = {
	cloudRun: {
		counted: "5xx Cloud Run returned",
		platform: "Cloud Run",
		why: (name: string) =>
			`Cloud Run answered them before ${name}'s code ran: its own 503 when no instance was free, or a request timeout.`,
	},
	cloudFunctions: {
		counted: "failed executions Cloud Functions counted",
		platform: "Cloud Functions",
		why: (name: string) =>
			`They most likely failed before ${name} exported a span: a timeout, a crash, or memory running out.`,
	},
} as const

/** `GcpTraceGapCallout`: Google counted clearly more server errors than the spans did. */
const traceGapCallout = (
	h: H,
	service: "cloudRun" | "cloudFunctions",
	gap: GcpTraceGap,
	tracedService: string,
	logsService: string,
	timeZone: string,
): Html => {
	const copy = GAP_COPY[service]
	const time = (ms: number) =>
		new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit" }).format(ms)
	return h.div(
		[h.Class("@container rounded-lg border border-severity-error/40")],
		[
			h.div(
				[h.Class("flex flex-col @2xl:flex-row @2xl:items-center")],
				[
					h.div(
						[h.Class("flex-1 space-y-1 px-4 py-3")],
						[
							h.p(
								[h.Class("text-sm font-medium text-foreground")],
								[
									formatNumber(gap.platformErrors),
									" ",
									copy.counted,
									",",
									" ",
									gap.tracedErrors === 0 ? "none" : formatNumber(gap.tracedErrors),
									" in your traces",
								],
							),
							h.p(
								[h.Class("max-w-prose text-xs text-muted-foreground")],
								[
									"The other ",
									formatNumber(gap.platformErrors - gap.tracedErrors),
									" came back",
									" ",
									time(gap.fromMs),
									"–",
									time(gap.untilMs),
									gap.peakInstances === undefined
										? ""
										: ` while instances were at their peak of ${gap.peakInstances}`,
									". ",
									copy.why(tracedService),
								],
							),
						],
					),
					h.div(
						[
							h.Class(
								"flex items-center gap-6 border-t px-4 py-3 @2xl:self-stretch @2xl:border-t-0 @2xl:border-l @2xl:px-5",
							),
						],
						[
							figure(h, formatNumber(gap.platformErrors), copy.platform, "text-severity-error"),
							figure(h, formatNumber(gap.tracedErrors), "traces"),
							h.a(
								[
									h.Class(
										"ml-auto font-mono text-xs text-primary hover:text-primary/80 @2xl:ml-0",
									),
									h.Href(
										hrefOf(
											AppRoute.Logs({
												search: {
													services: [logsService],
													startTime: formatWarehouseDateTime(gap.fromMs),
													endTime: formatWarehouseDateTime(gap.untilMs),
												},
											}),
										),
									),
								],
								["Logs at those times"],
							),
						],
					),
				],
			),
		],
	)
}

const loadingGrid = (h: H, service: GcpInfraServiceId): Html =>
	h.div(
		[h.Class("grid grid-cols-1 gap-4 lg:grid-cols-2")],
		GCP_INFRA_CHARTS[service].map(() => chartLoading(h, { variant: "line", height: CHART_HEIGHT })),
	)

const body = (h: H, model: Model, data: PageData, timeSearch: TimeSearch, ctx: ChartsContext): Html => {
	const window = model.window
	const slot = model.timeseries.data
	if (AsyncData.isIdle(slot) || AsyncData.isLoading(slot) || window === null)
		return loadingGrid(h, model.service)
	const failure = AsyncData.getError(slot)
	if (failure._tag === "Some" && data.points.length === 0) {
		return errorState(h, {
			failure: failure.value,
			title: "Failed to load workload metrics",
			onRetry: Message.ClickedRetryTimeseries(),
		})
	}
	if (data.points.length === 0) {
		return emptyMessage(h, { dashed: true, className: "py-12" }, [
			`No metrics arrived for this ${gcpWorkloadNoun(model.service)} in the selected window.`,
		])
	}
	const isWaiting = AsyncData.isRefreshing(slot)
	const range = { ...window, bucketSeconds: data.bucketSeconds }
	const service = model.service
	const sql = data.sql
	return h.div(
		[h.Class(cn("space-y-6", refreshingClass(isWaiting))), ...(isWaiting ? [h.AriaBusy(true)] : [])],
		[
			...(data.gap === null ||
			data.tracedService === null ||
			(service !== "cloudRun" && service !== "cloudFunctions")
				? []
				: [
						traceGapCallout(
							h,
							service,
							data.gap,
							data.tracedService,
							data.telemetry.logsService,
							ctx.timeZone,
						),
					]),
			...(sql === undefined || sql.wait === null
				? []
				: [appWaitCallout(h, sql.wait, sql.peak, gcpWorkloadName(service, data.keys), timeSearch)]),
			h.div(
				[h.Class("space-y-6")],
				[
					correlationStrips(
						h,
						model,
						service,
						data.points,
						range,
						data.instance?.maxConnections ?? null,
						ctx,
					),
					...(sql === undefined
						? []
						: [
								topQueries(h, {
									slot: model.topQueries.data,
									rows: data.statements,
									unavailableReason: data.unavailableReason,
									traced: sql.traced,
									showAll: model.showAllQueries,
									peekHash: model.search.peek,
								}),
							]),
					h.section(
						[h.Class("space-y-3")],
						[
							sectionHeading(h, {
								title: "All charts",
								hint: "each opens in the metrics explorer",
							}),
							workloadCharts(
								h,
								model,
								{
									charts: GCP_INFRA_CHARTS[service],
									points: data.points,
									range,
									where: gcpExplorerWhere(service, data.keys),
									timeSearch,
									idPrefix: "gcp-chart",
								},
								ctx,
							),
						],
					),
				],
			),
		],
	)
}

const nodesSection = (
	h: H,
	model: Model,
	data: PageData,
	timeSearch: TimeSearch,
	ctx: ChartsContext,
): ReadonlyArray<Html> => {
	const slot = model.nodes.data
	const points = AsyncData.isSuccess(slot) || AsyncData.isRefreshing(slot) ? slot.data : []
	const window = model.window
	if (model.service !== "gke" || points.length === 0 || window === null) return []
	const keys = data.keys.slice(2)
	const isWaiting = AsyncData.isRefreshing(slot)
	return [
		h.section(
			[h.Class(cn("space-y-3", refreshingClass(isWaiting))), ...(isWaiting ? [h.AriaBusy(true)] : [])],
			[
				sectionHeading(h, {
					title: `Nodes of ${keys[0] ?? ""}`,
					hint: "share of allocatable, averaged over the cluster's nodes",
				}),
				workloadCharts(
					h,
					model,
					{
						charts: GCP_GKE_NODE_CHARTS,
						points,
						range: { ...window, bucketSeconds: data.bucketSeconds },
						where: gcpExplorerWhere("gkeNodes", keys),
						timeSearch,
						idPrefix: "gcp-nodes",
					},
					ctx,
				),
			],
		),
	]
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	workloadPageView(h, model, pageOf(model), {
		timeZone: inputs.context.timeZone,
		defaultPreset: DEFAULT_PRESET,
	}),
)

/** `GcpWorkloadPage` over its derived data: the route reads it off its slots, the lab off fixtures. */
export const workloadPageView = (
	h: H,
	model: Model,
	data: PageData,
	options: Readonly<{ timeZone: string; defaultPreset: string }>,
): Html => {
	const timeSearch = {
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		timePreset: model.search.timePreset,
	}
	const theme = model.themeColors
	const isReady = theme !== null && model.chartRuntime._tag !== "Loading"
	const ctx = theme === null ? null : { theme, timeZone: options.timeZone }
	const service = model.service
	const databases = data.traceSide?.databases ?? []
	const peek =
		data.sql === undefined
			? null
			: resolveQueryPeek(data.statements, data.sql.traced, databases, model.search.peek)
	const instanceName = gcpWorkloadName(service, data.keys)
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: INFRA_CHART_TOKENS }))],
		[
			...(data.sql === undefined
				? []
				: [
						queryPeekSheet(h, model, {
							peek,
							where:
								databases.length === 1 ? `${instanceName} / ${databases[0]}` : instanceName,
							spans: model.statementSpans.data,
							// The lab hands the trace side over in `data`, not in its slot.
							traceSide:
								data.traceSide === undefined
									? model.traceSide.data
									: AsyncData.Success({ data: data.traceSide }),
							timeSearch,
							timeZone: options.timeZone,
						}),
					]),
			dashboardPage(
				h,
				{
					scrollClassName: "gap-6",
					titleContent: header(h, model, data),
					actions: pageTime(h, {
						search: model.search,
						defaultPreset: options.defaultPreset,
						window: model.window,
						picker: model.timePicker,
						toPickerMessage: (message) => Message.GotTimePickerMessage({ message }),
						onReset: Message.ClickedResetTimeRange(),
						onReload: Message.ClickedReload(),
						isReloading: model.isReloading,
					}),
					rightPanel: workloadRail(h, {
						service,
						project: gcpWorkloadProject(service, data.keys) || undefined,
						location: gcpWorkloadLocation(service, data.keys) || undefined,
						resource: data.resource,
						facts: data.facts,
						health: data.sql?.health ?? [],
						traced:
							data.telemetry.traced && data.overviewLoaded
								? { name: data.telemetry.serviceName, service: data.tracedService }
								: undefined,
						logs: { service: data.telemetry.logsService, attrs: data.telemetry.logAttrs },
						serviceMap:
							data.sql === undefined ? undefined : { focusService: data.sql.focusService },
						consoleLinks: gcpConsoleLinks(service, data.keys),
						timeSearch,
					}),
				},
				!isReady || ctx === null
					? [loadingGrid(h, service)]
					: [
							body(h, model, data, timeSearch, ctx),
							...nodesSection(h, model, data, timeSearch, ctx),
						],
			),
		],
	)
}
