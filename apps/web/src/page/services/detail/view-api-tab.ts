import { ENDPOINTS_LIMIT, isTruncated } from "../../../components/services/service-endpoints"
import {
	formatBytes,
	formatBytesPerSecond,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatRate,
} from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Chart from "../../../charts/chart"
import type { ThemeColors } from "../../../charts/theme-colors"
import { errorState } from "../../../ui/error-state"
import { panel } from "../../../ui/panel"
import { searchInput } from "../../../ui/search-input"
import { skeleton } from "../../../ui/skeleton"
import { table, tableBody, tableHeader, tableRow } from "../../../ui/table"
import { docsLink } from "../../kit/signal-empty-state"
import { windowSeconds } from "./derive"
import {
	apiKpis,
	ENDPOINT_FILTER_LABELS,
	ENDPOINT_FILTERS,
	type EndpointFilter,
	isServerError,
	kpiSparks,
	matchesFilter,
	reasonPhrase,
	routeList,
	slowestEndpoint,
	type StatusCodeSummary,
	bucketAxis,
	onAxis,
	statusCodeSummaries,
	statusMix,
	type WindowMs,
	hasUnknownBuckets,
} from "./derive-api"
import { commitMarkers, markerLayout } from "./derive-markers"
import { TRACE_DETAIL_LIMIT_SECONDS } from "./derive-tables"
import { Message } from "./message"
import type { Model } from "./model"
import type { ApiBucket, ApiOverview, Endpoint, StatusRow } from "./model-tabs"
import { COLUMN, COLUMN_COUNT, groupRows, groupsOf, type RowContext } from "./view-api"
import { type ChartContext, SPARK_TOKENS, sparkline, STATUS_COLORS, statusChart } from "./view-api-charts"
import { markersOverlay } from "./view-markers"
import { headLabel, sortColumnHead } from "./view-table-cells"

// `ServiceApiTab`: the KPI strip, the responses chart beside the non-2xx breakdown, and the
// endpoint table with its filters. The endpoint drawer is the page's (`endpoint-peek`).

type H = HtmlBuilder<Message>

const toChart = (chartId: string) => (message: Chart.Message) => Message.GotChartMessage({ chartId, message })

/** The tab's charts and sparklines share one bucket size (`operationsBucketSeconds`). */
export type ApiTabInputs = Readonly<{ bucketSeconds: number; timeZone: string; window: WindowMs }>

// KPI STRIP

type Tile = Readonly<{
	label: string
	dot?: string
	value: string
	unit?: string
	valueClassName?: string
	aside: string
	asideClassName?: string
	values: ReadonlyArray<number>
	token: string
}>

const kpiTile = (h: H, tile: Tile, theme: ThemeColors | null): Html =>
	h.div(
		[
			h.Key(tile.label),
			h.Class(
				"flex min-w-0 flex-col gap-2 border-b p-4 odd:border-r last:col-span-2 last:border-b-0 last:border-r-0 md:border-r md:border-b-0 md:last:col-span-1 md:last:border-r-0",
			),
		],
		[
			h.div(
				[h.Class("flex items-center gap-1.5")],
				[
					...(tile.dot === undefined
						? []
						: [h.span([h.Class(cn("size-1.5 rounded-full", tile.dot))])]),
					h.span(
						[h.Class("text-2xs uppercase tracking-wider text-muted-foreground")],
						[tile.label],
					),
				],
			),
			h.div(
				[h.Class("flex min-w-0 items-baseline gap-2")],
				[
					h.span(
						[h.Class(cn("text-[22px] font-medium leading-7 tabular-nums", tile.valueClassName))],
						[tile.value],
					),
					...(tile.unit === undefined
						? []
						: [h.span([h.Class("text-ui text-muted-foreground")], [tile.unit])]),
					h.span(
						[
							h.Class(
								cn("ml-auto truncate text-2xs text-muted-foreground", tile.asideClassName),
							),
							h.Title(tile.aside),
						],
						[tile.aside],
					),
				],
			),
			theme === null || tile.values.length < 2
				? h.div([h.Class("h-7 w-full")])
				: sparkline(h, {
						chartId: `kpi-${tile.label}`,
						values: tile.values,
						token: tile.token,
						theme,
						className: "h-7 w-full",
						toMessage: toChart("sparkline"),
					}),
		],
	)

/** "mostly 402 (98%)": the code most of a class's responses carried; blank while it loads. */
const leadingCode = (summaries: ReadonlyArray<StatusCodeSummary> | null, isServer: boolean): string => {
	if (summaries === null) return ""
	const codes = summaries.filter((summary) => isServerError(summary.code) === isServer)
	const total = codes.reduce((sum, summary) => sum + summary.count, 0)
	const [top] = codes
	if (top === undefined || total === 0) return "none"
	const share = top.count / total
	if (codes.length === 1) return `${formatNumber(Math.round(total))} · all ${top.code}`
	return `mostly ${top.code} (${Math.round(share * 100)}%)`
}

/** "3.0 MB/s" as value and unit, so the unit sits small beside the figure like "req/s". */
const splitUnit = (text: string): Readonly<{ value: string; unit?: string }> => {
	const space = text.indexOf(" ")
	return space < 0 ? { value: text } : { value: text.slice(0, space), unit: text.slice(space + 1) }
}

/** "+12%" / "−8%"; under half a percent either way reads as unchanged. */
const formatChange = (change: number) =>
	Math.abs(change) < 0.005 ? "±0%" : `${change > 0 ? "+" : "−"}${formatErrorRate(Math.abs(change))}`

const kpiStrip = (
	h: H,
	overview: ApiOverview,
	summaries: ReadonlyArray<StatusCodeSummary> | null,
	seconds: number,
	inputs: ApiTabInputs,
	theme: ThemeColors | null,
): Html => {
	const kpis = apiKpis(overview.totals, overview.previous, seconds)
	const sparks = kpiSparks(overview.buckets, inputs.bucketSeconds, inputs.window)
	const client = kpis.mix?.client ?? null
	const server = kpis.mix?.server ?? null
	const tiles: ReadonlyArray<Tile> = [
		{
			label: "Requests",
			value: formatRate(kpis.requestsPerSecond),
			unit: "req/s",
			aside: `${formatNumber(Math.round(kpis.totalRequests))} total`,
			values: sparks.requests,
			token: SPARK_TOKENS.requests,
		},
		{
			label: "4xx responses",
			dot: "bg-warning",
			value: client === null ? "—" : formatErrorRate(client),
			valueClassName: client !== null && client > 0 ? "text-warning-foreground" : undefined,
			aside: client === null ? "no status codes" : leadingCode(summaries, false),
			asideClassName: client !== null && client > 0 ? "text-warning-foreground" : undefined,
			values: sparks.client,
			token: SPARK_TOKENS.client,
		},
		{
			label: "5xx responses",
			dot: "bg-severity-error",
			value: server === null ? "—" : formatErrorRate(server),
			valueClassName: server !== null && server > 0.01 ? "text-destructive-foreground" : undefined,
			aside: server === null ? "no status codes" : leadingCode(summaries, true),
			asideClassName: server !== null && server > 0 ? "text-destructive-foreground" : undefined,
			values: sparks.server,
			token: SPARK_TOKENS.server,
		},
		{
			label: "p95 latency",
			value: formatLatency(kpis.p95DurationMs),
			aside: kpis.p95Change === null ? "no prior data" : `${formatChange(kpis.p95Change)} vs prev`,
			asideClassName:
				kpis.p95Change === null || Math.abs(kpis.p95Change) < 0.05
					? undefined
					: kpis.p95Change < 0
						? "text-success-foreground"
						: "text-warning-foreground",
			values: sparks.p95,
			token: SPARK_TOKENS.latency,
		},
		{
			label: "Request bytes",
			...splitUnit(kpis.bytesPerSecond === null ? "—" : formatBytesPerSecond(kpis.bytesPerSecond)),
			aside:
				kpis.avgBodyBytes === null ? "no body sizes" : `avg body ${formatBytes(kpis.avgBodyBytes)}`,
			values: sparks.bytes,
			token: SPARK_TOKENS.bytes,
		},
	]
	return h.div(
		[h.Class("grid w-full grid-cols-2 overflow-hidden rounded-lg border bg-card md:grid-cols-5")],
		tiles.map((tile) => kpiTile(h, tile, theme)),
	)
}

const kpiSkeleton = (h: H): Html =>
	h.div(
		[
			h.Class("grid w-full grid-cols-2 overflow-hidden rounded-lg border bg-card md:grid-cols-5"),
			h.AriaBusy(true),
		],
		Array.from({ length: 5 }, (_, index) =>
			h.div(
				[
					h.Key(String(index)),
					h.Class(
						"flex flex-col gap-2.5 border-b p-4 md:border-r md:border-b-0 md:last:border-r-0",
					),
				],
				[skeleton(h, "h-2.5 w-20"), skeleton(h, "h-6 w-24"), skeleton(h, "h-7 w-full")],
			),
		),
	)

// RESPONSES CHART

const legendItem = (h: H, swatch: Html, label: string): Html =>
	h.div([h.Key(label), h.Class("flex items-center gap-1.5")], [swatch, h.span([], [label])])

const swatch = (h: H, color: string) =>
	h.span([h.Class("size-2 rounded-[2px]"), h.Style({ background: color })])

const responsesChart = (
	h: H,
	model: Model,
	overview: ApiOverview,
	inputs: ApiTabInputs,
	theme: ThemeColors | null,
): Html => {
	const mix = statusMix(overview.totals)
	const markers = Option.match(AsyncData.getData(model.overview.data), {
		onNone: () => [],
		onSome: (data) =>
			commitMarkers(
				data.releases,
				overview.buckets.map((bucket) => bucket.bucket),
				model.commits,
			),
	})
	const chartModel = model.charts["api-responses"]
	const overlay =
		markers.length === 0 || chartModel === undefined
			? undefined
			: Option.match(chartModel.plot, {
					onNone: () => undefined,
					onSome: (plot) => markersOverlay(h, markerLayout(markers, plot), plot),
				})
	const context: ChartContext | null =
		theme === null ? null : { theme, timeZone: inputs.timeZone, nowMs: model.nowMs ?? 0 }
	return h.div(
		[h.Class("flex min-w-0 flex-1 flex-col gap-3 rounded-lg border bg-card p-4")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center justify-between gap-x-4 gap-y-2")],
				[
					h.div(
						[h.Class("flex items-baseline gap-2")],
						[
							h.span([h.Class("text-ui font-medium")], ["Responses by status"]),
							h.span([h.Class("text-2xs text-muted-foreground")], ["req/s, all endpoints"]),
						],
					),
					h.div(
						[h.Class("flex items-center gap-4 text-2xs text-muted-foreground")],
						[
							legendItem(
								h,
								swatch(h, STATUS_COLORS["2xx"]),
								`2xx ${mix === null ? "—" : formatErrorRate(mix.ok)}`,
							),
							legendItem(
								h,
								swatch(h, STATUS_COLORS["4xx"]),
								`4xx ${mix === null ? "—" : formatErrorRate(mix.client)}`,
							),
							legendItem(
								h,
								swatch(h, STATUS_COLORS["5xx"]),
								`5xx ${mix === null ? "—" : formatErrorRate(mix.server)}`,
							),
							...(hasUnknownBuckets(overview.buckets)
								? [legendItem(h, swatch(h, STATUS_COLORS.unknown), "no status code")]
								: []),
							...(markers.length === 0
								? []
								: [
										legendItem(
											h,
											h.span([
												h.Class(
													"h-2.5 w-0 border-l border-dashed border-muted-foreground",
												),
											]),
											"deploy",
										),
									]),
						],
					),
				],
			),
			context === null
				? skeleton(h, "h-[200px] w-full")
				: statusChart(h, {
						chartId: "api-responses",
						chart: chartModel,
						buckets: overview.buckets,
						bucketSeconds: inputs.bucketSeconds,
						window: inputs.window,
						context,
						className: "h-[200px] w-full",
						overlay,
						reportPlot: markers.length > 0,
						toMessage: toChart("api-responses"),
					}),
		],
	)
}

// NON-2XX BREAKDOWN

const codeRow = (h: H, summary: StatusCodeSummary): Html => {
	const isServer = isServerError(summary.code)
	const [errorType] = summary.errorTypes
	return h.div(
		[h.Key(summary.code), h.Class("flex flex-col gap-1")],
		[
			h.div(
				[h.Class("flex items-baseline gap-2 text-2xs tabular-nums")],
				[
					h.span(
						[
							h.Class(
								cn(
									"rounded-sm bg-muted px-1 font-medium",
									isServer ? "text-destructive-foreground" : "text-warning-foreground",
								),
							),
						],
						[summary.code],
					),
					h.span([h.Class("truncate text-foreground")], [reasonPhrase(summary.code)]),
					h.span([h.Class("ml-auto text-foreground")], [formatNumber(Math.round(summary.count))]),
					h.span(
						[h.Class("w-11 text-right text-muted-foreground")],
						[formatErrorRate(summary.share)],
					),
				],
			),
			h.div(
				[h.Class("h-1 w-full rounded-full bg-muted")],
				[
					h.div([
						h.Class(cn("h-1 rounded-full", isServer ? "bg-severity-error" : "bg-warning")),
						h.Style({ width: `${Math.max(summary.share * 100, 1)}%` }),
					]),
				],
			),
			h.span(
				[h.Class("block w-full truncate text-3xs text-muted-foreground")],
				[
					...(errorType === undefined
						? []
						: [h.span([h.Class("text-foreground/80")], [errorType.name]), " · "]),
					routeList(summary.routes),
				],
			),
		],
	)
}

const breakdownPanel = (h: H, summaries: ReadonlyArray<StatusCodeSummary> | null): Html => {
	const total = summaries?.reduce((sum, summary) => sum + summary.count, 0) ?? 0
	return h.div(
		[
			h.Class(
				"flex w-full shrink-0 flex-col gap-3 overflow-hidden rounded-lg border bg-card p-4 lg:w-[400px]",
			),
		],
		[
			h.div(
				[h.Class("flex items-baseline justify-between gap-2")],
				[
					h.span([h.Class("text-ui font-medium")], ["Non-2xx responses"]),
					...(summaries === null
						? []
						: [
								h.span(
									[h.Class("text-2xs text-muted-foreground tabular-nums")],
									[`${formatNumber(Math.round(total))} · whole hours`],
								),
							]),
				],
			),
			summaries === null
				? h.div(
						[h.Class("flex flex-col gap-3"), h.AriaBusy(true)],
						[0, 1, 2, 3].map((index) =>
							h.div([h.Key(String(index))], [skeleton(h, "h-9 w-full")]),
						),
					)
				: summaries.length === 0
					? h.p(
							[h.Class("py-6 text-center text-xs text-muted-foreground")],
							["Every response in this window was below 400."],
						)
					: h.div(
							[h.Class("flex flex-col gap-3")],
							summaries.slice(0, 4).map((summary) => codeRow(h, summary)),
						),
		],
	)
}

// TABLE

const filterChip = (h: H, filter: EndpointFilter, active: EndpointFilter): Html =>
	h.button(
		[
			h.Key(filter),
			h.Type("button"),
			h.AriaPressed(filter === active ? "true" : "false"),
			h.Class(
				cn(
					"rounded-sm px-2 py-1 transition-colors",
					filter === active
						? "bg-accent text-foreground"
						: "text-muted-foreground hover:text-foreground",
				),
			),
			h.OnClick(Message.ClickedEndpointFilter({ filter })),
		],
		[ENDPOINT_FILTER_LABELS[filter]],
	)

const toolbar = (h: H, model: Model, count: number): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-3 border-b px-4 py-2")],
		[
			h.span([h.Class("text-ui font-medium")], ["Endpoints"]),
			...(AsyncData.isFailure(model.endpointSeries.data)
				? [
						h.span(
							[h.Class("text-2xs text-destructive-foreground")],
							["Trends failed to load; Reload to retry."],
						),
					]
				: []),
			h.span(
				[h.Class("rounded-sm bg-muted px-1.5 text-2xs text-muted-foreground tabular-nums")],
				[formatNumber(count)],
			),
			h.div(
				[
					h.Class("ml-3 flex items-center gap-1 text-2xs"),
					h.Role("group"),
					h.AriaLabel("Filter endpoints"),
				],
				ENDPOINT_FILTERS.map((filter) => filterChip(h, filter, model.endpointFilter)),
			),
			searchInput(h, {
				id: "service-endpoint-search",
				value: model.endpointQuery,
				placeholder: "Filter routes…",
				ariaLabel: "Filter routes",
				onInput: (value) => Message.ChangedEndpointQuery({ value }),
				onClear: Message.ChangedEndpointQuery({ value: "" }),
				className: "ml-auto w-[240px]",
			}),
		],
	)

/** Request rate per bucket by span name on one axis; a bucket an endpoint was quiet in reads 0. */
const sparksBySpanName = (buckets: ReadonlyArray<ApiBucket>, bucketSeconds: number, window: WindowMs) => {
	const axis = bucketAxis(buckets, bucketSeconds, window)
	const bySpanName = buckets.reduce(
		(acc, bucket) => acc.set(bucket.spanName, [...(acc.get(bucket.spanName) ?? []), bucket]),
		new Map<string, ReadonlyArray<ApiBucket>>(),
	)
	return new Map(
		[...bySpanName].map(([spanName, rows]) => [
			spanName,
			onAxis(axis, rows, (bucket) => bucket.estimatedSpanCount / Math.max(1, bucketSeconds)),
		]),
	)
}

const endpointsTable = (
	h: H,
	model: Model,
	endpoints: ReadonlyArray<Endpoint>,
	inputs: ApiTabInputs,
	theme: ThemeColors | null,
): Html => {
	const sort = model.sorts.endpoints
	const seconds = model.window === null ? 0 : windowSeconds(model.window)
	const visible = endpoints.filter((endpoint) =>
		matchesFilter(endpoint, model.endpointFilter, model.endpointQuery),
	)
	const groups = groupsOf(visible, sort)
	const context: RowContext = {
		seconds,
		sparks: sparksBySpanName(
			AsyncData.getOrElse(model.endpointSeries.data, () => []),
			inputs.bucketSeconds,
			inputs.window,
		),
		theme,
		selected: model.search.endpoint,
		slowest: slowestEndpoint(visible),
	}
	const column = (sortKey: string, label: string, className: string, align?: "left") =>
		sortColumnHead(h, {
			table: "endpoints",
			sortKey,
			label,
			sort,
			className: cn(className, "pr-0"),
			align,
		})
	return h.div(
		[h.Class("flex w-full flex-col overflow-hidden rounded-lg border bg-card")],
		[
			toolbar(h, model, visible.length),
			table(h, {}, [
				tableHeader(h, [
					tableRow(
						h,
						[
							column("path", "Endpoint", "pl-4", "left"),
							column("traffic", "Req/s", COLUMN.rate),
							headLabel(
								h,
								[
									h.span([h.Class("md:hidden")], ["4xx"]),
									h.span([h.Class("hidden md:inline")], ["2xx / 4xx / 5xx"]),
								],
								cn("pr-0 text-right", COLUMN.mix),
							),
							column("errorRate", "5xx", COLUMN.err),
							column("p50", "p50", COLUMN.p50),
							column("p95", "p95", COLUMN.p95),
							column("p99", "p99", COLUMN.p99),
							headLabel(h, ["Body avg"], cn("pr-0 text-right", COLUMN.body)),
							headLabel(h, [], COLUMN.chevron),
						],
						"border-b hover:bg-transparent",
					),
				]),
				tableBody(
					h,
					groups.length === 0
						? [
								tableRow(
									h,
									[
										h.td(
											[
												h.Attribute("colspan", String(COLUMN_COUNT)),
												h.Class("py-8 text-center text-xs text-muted-foreground"),
											],
											["No endpoint matches this filter."],
										),
									],
									"hover:bg-transparent",
								),
							]
						: groups.flatMap((group) =>
								groupRows(
									h,
									group,
									context,
									model.expandedEndpointGroups.includes(group.kind),
								),
							),
				),
			]),
		],
	)
}

// STATES

const loadingState = (h: H): Html =>
	h.div(
		[h.Class("flex flex-col gap-4")],
		[
			kpiSkeleton(h),
			h.div(
				[h.Class("flex flex-col gap-4 lg:flex-row")],
				[
					skeleton(h, "h-[262px] flex-1 rounded-lg"),
					skeleton(h, "h-[262px] w-full rounded-lg lg:w-[400px]"),
				],
			),
			panel(h, {}, [
				h.div(
					[h.AriaBusy(true), h.Class("flex flex-col")],
					Array.from({ length: 8 }, (_, index) =>
						h.div(
							[
								h.Key(String(index)),
								h.Class("flex h-12 items-center gap-3 border-b px-4 last:border-b-0"),
							],
							[
								skeleton(h, "h-2.5 w-9"),
								skeleton(h, "h-2.5 w-40"),
								h.span([h.Class("flex-1")]),
								skeleton(h, "h-2.5 w-[88px]"),
								skeleton(h, "h-2.5 w-24"),
								skeleton(h, "h-2.5 w-12"),
							],
						),
					),
				),
			]),
		],
	)

/** `ApiEmptyState`: names the two conditions an endpoint needs. */
const emptyState = (h: H, serviceName: string): Html => {
	const mono = (text: string) => h.span([h.Class("text-foreground/80")], [text])
	return panel(h, { className: "items-center gap-3.5 px-[18px] py-11 text-center" }, [
		h.span([h.Class("text-title font-medium text-foreground/90")], ["No HTTP endpoints in this window"]),
		h.span(
			[h.Class("max-w-[620px] text-ui leading-[21px] text-muted-foreground")],
			[
				mono(serviceName),
				" reported spans in this range, but none are HTTP server spans with a route. An endpoint needs a server span carrying",
				" ",
				mono("http.route"),
				" or",
				" ",
				mono("url.path"),
				".",
			],
		),
		docsLink(h, "otelConventions"),
	])
}

const notes = (h: H, count: number, seconds: number): ReadonlyArray<Html> =>
	[
		...(isTruncated(count)
			? [
					`Showing the ${ENDPOINTS_LIMIT} busiest endpoints — this service has more. Narrow the time range or environment to see the rest.`,
				]
			: []),
		...(seconds > TRACE_DETAIL_LIMIT_SECONDS
			? ["Endpoint summaries cover the selected range; trace drill-downs show the latest 30 days."]
			: []),
	].map((note) => h.p([h.Key(note), h.Class("px-0.5 text-xs text-muted-foreground")], [note]))

const loaded = (
	h: H,
	model: Model,
	endpoints: ReadonlyArray<Endpoint>,
	isWaiting: boolean,
	inputs: ApiTabInputs,
	theme: ThemeColors | null,
): Html => {
	if (endpoints.length === 0) return emptyState(h, model.serviceName)
	const seconds = model.window === null ? 0 : windowSeconds(model.window)
	const statusRows: ReadonlyArray<StatusRow> | null = Option.getOrNull(
		AsyncData.getData(model.statusBreakdown.data),
	)
	const summaries = statusRows === null ? null : statusCodeSummaries(statusRows)
	const overview = AsyncData.getData(model.apiOverview.data)
	// A failed refresh keeps its data on screen (Stale); only a read with nothing to show errors.
	const overviewFailure = AsyncData.isFailure(model.apiOverview.data) ? model.apiOverview.data.error : null
	const breakdownFailure = AsyncData.isFailure(model.statusBreakdown.data)
		? model.statusBreakdown.data.error
		: null
	return h.div(
		[
			h.Class(cn("flex flex-col gap-4", refreshingClass(isWaiting))),
			...(isWaiting ? [h.AriaBusy(true)] : []),
		],
		[
			...notes(h, endpoints.length, seconds),
			overviewFailure !== null
				? errorState(h, { failure: overviewFailure, title: "Failed to load API overview" })
				: Option.match(overview, {
						onNone: () => kpiSkeleton(h),
						onSome: (data) => kpiStrip(h, data, summaries, seconds, inputs, theme),
					}),
			h.div(
				[h.Class("flex flex-col gap-4 lg:flex-row")],
				[
					overviewFailure !== null
						? h.div(
								[h.Class("min-w-0 flex-1")],
								[
									errorState(h, {
										failure: overviewFailure,
										title: "Failed to load responses",
									}),
								],
							)
						: Option.match(overview, {
								onNone: () => skeleton(h, "h-[262px] flex-1 rounded-lg"),
								onSome: (data) => responsesChart(h, model, data, inputs, theme),
							}),
					breakdownFailure !== null
						? h.div(
								[h.Class("w-full shrink-0 lg:w-[400px]")],
								[
									errorState(h, {
										failure: breakdownFailure,
										title: "Failed to load status codes",
									}),
								],
							)
						: breakdownPanel(h, summaries),
				],
			),
			endpointsTable(h, model, endpoints, inputs, theme),
		],
	)
}

/** The API tab: skeleton, error, the empty explanation, or the strip, charts and table. */
export const apiTab = (h: H, model: Model, inputs: ApiTabInputs, theme: ThemeColors | null): Html =>
	AsyncData.match(model.endpoints.data, {
		onIdle: () => loadingState(h),
		onLoading: () => loadingState(h),
		onFailure: (failure) => errorState(h, { failure }),
		onStale: ({ error }) => errorState(h, { failure: error }),
		onRefreshing: (endpoints) => loaded(h, model, endpoints, true, inputs, theme),
		onSuccess: (endpoints) => loaded(h, model, endpoints, false, inputs, theme),
	})
