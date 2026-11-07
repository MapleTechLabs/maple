import {
	countLabel,
	formatBytes,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatRate,
} from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { TONE_FILL, TONE_TEXT, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { AsyncData, Submodel } from "foldkit"
import type * as Chart from "@maple/views/charts/chart"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../../route"
import { linkButton } from "@maple/views/ui/button"
import * as DialogView from "@maple/views/ui/dialog-view"
import { kbd } from "@maple/views/ui/display"
import { emptyMessage } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { skeleton } from "@maple/views/ui/skeleton"
import { truncatedId } from "@maple/views/ui/truncated-id"
import { statRail, statRailItem } from "../../../kit/stat-rail"
import { callsPerSecond } from "../derive"
import {
	endpointStatusCodes,
	type HistogramBin,
	isServerError,
	knownStatusMix,
	latencyHistogram,
	reasonPhrase,
	type WindowMs,
} from "../derive-api"
import type { LoadFailure } from "@maple/views/data/load-failure"
import type { ApiBucket, EndpointDetail, StatusRow } from "../model-tabs"
import { type ChartContext, latencyChart, STATUS_COLORS, statusChart } from "../view-api-charts"
import { methodLabel } from "../view-api"
import { sheetDetailHeader } from "../../../kit/sheet-detail-header"
import { MountEndpointPeekKeys } from "./keys"
import { Message } from "./message"
import type { Model } from "./model"
import type { Peek } from "./update"
import { timestamp } from "@maple/views/ui/timestamp"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack, vstackClass } from "@maple/views/ui/stack"
import { Array as Arr, String as Str, Option, Order } from "effect"

// The endpoint drawer: the endpoint's numbers, its requests and latency over the window, the status
// codes, the latency distribution, the clients, the body sizes and the slowest requests.

type H = HtmlBuilder<Message>

export type ViewInputs = Readonly<{
	peek: Peek | null
	/** The peeked endpoint's buckets, from the tab's per-endpoint read or the drawer's own. */
	series: AsyncData.AsyncData<ReadonlyArray<ApiBucket>, LoadFailure>
	bucketSeconds: number
	window: WindowMs
	statusRows: ReadonlyArray<StatusRow>
	chartContext: ChartContext | null
	seconds: number
	/** "ingest · production · last 12 hours". */
	scopeLabel: string
	/** /traces searches over the drawer's endpoint (the page owns the window clamp). */
	tracesHref: (filter: Readonly<{ statusCode?: string; slowest?: boolean }>) => string
	alertHref: string
	timeZone: string
	nowMs: number
}>

const toChart = (chartId: string) => (message: Chart.Message) => Message.GotChartMessage({ chartId, message })

const sectionLabel = (h: H, label: string): Html => eyebrow(h, { variant: "label", as: "h3" }, [label])

const card = (
	h: H,
	label: string,
	aside: Html | null,
	children: ReadonlyArray<Html>,
	className?: string,
): Html =>
	h.section(
		[h.Key(label), h.Class(cn("flex min-w-0 flex-col gap-2.5 rounded-md border bg-card p-3", className))],
		[
			hstack(h, { gap: "2", align: "baseline", justify: "between" }, [
				sectionLabel(h, label),
				...(aside === null ? [] : [aside]),
			]),
			...children,
		],
	)

const hint = (h: H, text: string) => typography(h, { size: "3xs", tone: "muted" }, [text])

const stat = (h: H, label: string, value: string, sub: string, tone?: Tone): Html =>
	statRailItem(h, { eyebrow: label, value, subline: sub, tone, size: "sm", className: "min-w-0" })

const stats = (h: H, peek: Peek, codes: ReturnType<typeof endpointStatusCodes>, seconds: number): Html => {
	const { endpoint } = peek
	const mix = knownStatusMix(endpoint)
	const topClient = Option.getOrUndefined(Arr.findFirst(codes, (code) => Str.startsWith("4")(code.name)))
	return statRail(h, { columns: 4, className: "overflow-hidden sm:grid-cols-4" }, [
		stat(
			h,
			"Req/s",
			formatRate(callsPerSecond(endpoint.estimatedSpanCount, seconds)),
			`${formatNumber(Math.round(endpoint.estimatedSpanCount))} total`,
		),
		stat(
			h,
			"4xx",
			mix === null ? "—" : formatErrorRate(mix.client),
			// The leading code comes from the status rows; until they land it stays blank.
			mix === null || mix.client === 0
				? "none in window"
				: topClient === undefined
					? ""
					: `mostly ${topClient.name}`,
			mix !== null && mix.client > 0 ? "warn" : undefined,
		),
		stat(
			h,
			"5xx",
			mix === null ? formatErrorRate(endpoint.errorRate) : formatErrorRate(mix.server),
			(mix?.server ?? endpoint.errorRate) === 0
				? "none in window"
				: countLabel(
						Math.round(endpoint.estimatedSpanCount * (mix?.server ?? endpoint.errorRate)),
						"response",
					),
			(mix?.server ?? endpoint.errorRate) > 0 ? "crit" : undefined,
		),
		stat(h, "p95", formatLatency(endpoint.p95DurationMs), `p99 ${formatLatency(endpoint.p99DurationMs)}`),
	])
}

const legendSwatch = (h: H, label: string, color: string): Html =>
	hstack(h, { gap: "1", attributes: [h.Key(label)] }, [
		h.span([h.Class("h-0.5 w-2"), h.Style({ background: color })]),
		h.span([], [label]),
	])

const chartSection = (h: H, title: string, legend: ReadonlyArray<Html>, body: Html): Html =>
	vstack(h, { gap: "2", as: "section", attributes: [h.Key(title)] }, [
		hstack(h, { justify: "between" }, [
			sectionLabel(h, title),
			hstack(h, { gap: "3", align: "center", className: "text-3xs text-muted-foreground" }, legend),
		]),
		body,
	])

const charts = (h: H, model: Model, inputs: ViewInputs): ReadonlyArray<Html> => {
	if (AsyncData.isFailure(inputs.series))
		return [
			errorState(h, {
				failure: inputs.series.error,
				title: "Couldn't load this endpoint's requests and latency",
				onRetry: Message.ClickedRetryDetail(),
			}),
		]
	const buckets = AsyncData.getOrElse(inputs.series, () => [])
	// Until the series lands the charts are skeletons, not an endpoint that served nothing.
	const isPending = AsyncData.isIdle(inputs.series) || AsyncData.isLoading(inputs.series)
	const context = isPending ? null : inputs.chartContext
	return [
		chartSection(
			h,
			"Requests",
			[
				legendSwatch(h, "2xx", STATUS_COLORS["2xx"]),
				legendSwatch(h, "4xx", STATUS_COLORS["4xx"]),
				legendSwatch(h, "5xx", STATUS_COLORS["5xx"]),
			],
			context === null
				? skeleton(h, "h-[120px] w-full")
				: statusChart(h, {
						chartId: "peek-requests",
						chart: model.charts["peek-requests"],
						buckets,
						bucketSeconds: inputs.bucketSeconds,
						window: inputs.window,
						context,
						className: "h-[120px] w-full",
						toMessage: toChart("peek-requests"),
					}),
		),
		chartSection(
			h,
			"Latency",
			[
				legendSwatch(h, "p50", "var(--chart-p50)"),
				legendSwatch(h, "p95", "var(--chart-p95)"),
				legendSwatch(h, "p99", "var(--chart-p99)"),
			],
			context === null
				? skeleton(h, "h-[120px] w-full")
				: latencyChart(h, {
						chartId: "peek-latency",
						chart: model.charts["peek-latency"],
						buckets,
						bucketSeconds: inputs.bucketSeconds,
						window: inputs.window,
						context,
						className: "h-[120px] w-full",
						toMessage: toChart("peek-latency"),
					}),
		),
	]
}

const statusCard = (h: H, rows: ReadonlyArray<StatusRow>, spanName: string): Html => {
	const codes = endpointStatusCodes(rows, spanName)
	const errorType = Arr.sort(
		Arr.filter(
			rows,
			(row) => row.spanName === spanName && row.errorType !== "" && Number(row.httpStatusCode) >= 400,
		),
		Order.flip(Order.mapInput(Order.Number, (row: (typeof rows)[number]) => row.estimatedSpanCount)),
	)[0]
	return card(h, "Status codes", null, [
		...(codes.length === 0
			? [
					typography(h, { size: "2xs", tone: "muted", as: "p" }, [
						"No status codes recorded in this window",
					]),
				]
			: Arr.map(codes.slice(0, 4), (code) => {
					const tone = Str.startsWith("2")(code.name)
						? { text: TONE_TEXT.info, bar: TONE_FILL.ok }
						: isServerError(code.name)
							? { text: TONE_TEXT.crit, bar: TONE_FILL.crit }
							: { text: TONE_TEXT.warn, bar: TONE_FILL.warn }
					return vstack(h, { gap: "1", attributes: [h.Key(code.name)] }, [
						hstack(
							h,
							{
								gap: "2",
								align: "stretch",
								justify: "between",
								className: "text-2xs tabular-nums",
							},
							[
								h.span(
									[h.Class(cn("truncate", tone.text))],
									[Str.trim(`${code.name} ${reasonPhrase(code.name)}`)],
								),
								h.span(
									[h.Class("shrink-0")],
									[
										`${formatNumber(Math.round(code.count))} · ${formatErrorRate(code.share)}`,
									],
								),
							],
						),
						h.div(
							[h.Class("h-1 rounded-full bg-muted")],
							[
								h.div([
									h.Class(cn("h-1 rounded-full", tone.bar)),
									h.Style({ width: `${Math.max(code.share * 100, 1)}%` }),
								]),
							],
						),
					])
				})),
		...(errorType === undefined
			? []
			: [
					h.span(
						[h.Class("mt-auto truncate text-3xs text-muted-foreground")],
						[
							`error.type `,
							typography(h, { tone: "soft" }, [errorType.errorType]),
							` on most ${errorType.httpStatusCode}s`,
						],
					),
				]),
	])
}

const BAND_CLASS = {
	p50: "bg-chart-p50",
	p95: "bg-chart-p95",
	p99: "bg-chart-p99",
} as const satisfies Record<HistogramBin["band"], string>

const distributionCard = (h: H, detail: EndpointDetail): Html => {
	const bins = latencyHistogram(detail.latencyQuantileLevels, detail.latencyQuantilesMs)
	const peak = Arr.reduce(bins, 0, (max, bin) => Math.max(max, bin.share))
	const first = bins[0]
	const last = bins[bins.length - 1]
	return card(h, "Distribution", hint(h, "log scale"), [
		bins.length === 0 || first === undefined || last === undefined
			? typography(h, { size: "2xs", tone: "muted", as: "p" }, [
					"Not enough requests to draw a distribution.",
				])
			: vstack(h, { gap: "1.5" }, [
					hstack(
						h,
						{ align: "end", className: "h-16 gap-[3px]" },
						Arr.map(bins, (bin, index) =>
							h.div([
								h.Key(String(index)),
								h.Class(cn("flex-1 rounded-t-xs", BAND_CLASS[bin.band])),
								h.Style({
									height: `${peak > 0 ? Math.max((bin.share / peak) * 100, 2) : 2}%`,
								}),
								h.Title(
									`${formatLatency(bin.fromMs)} to ${formatLatency(bin.toMs)}: ${formatErrorRate(bin.share)} of requests`,
								),
							]),
						),
					),
					hstack(
						h,
						{
							align: "stretch",
							justify: "between",
							className: "text-3xs text-muted-foreground tabular-nums",
						},
						[h.span([], [formatLatency(first.fromMs)]), h.span([], [formatLatency(last.toMs)])],
					),
				]),
	])
}

/** User-agent counts are stored spans, so their share is of the endpoint's stored spans. */
const clientsCard = (h: H, detail: EndpointDetail, spanCount: number): Html => {
	const total = spanCount
	return card(h, "Top clients", hint(h, "user_agent.original"), [
		detail.userAgents.length === 0
			? typography(h, { size: "2xs", tone: "muted", as: "p" }, ["No requests carried a user agent."])
			: vstack(
					h,
					{ gap: "1.5", className: "text-2xs tabular-nums" },
					Arr.map(detail.userAgents.slice(0, 5), (agent) =>
						hstack(h, { gap: "2", attributes: [h.Key(agent.value)] }, [
							typography(
								h,
								{
									truncate: true,
									className: "min-w-0 flex-1",
									attributes: [h.Title(agent.value)],
								},
								[agent.value === "" ? "(no user agent)" : agent.value],
							),
							...(agent.count === null || total === 0
								? []
								: [
										typography(h, { tone: "muted", className: "shrink-0" }, [
											formatErrorRate(agent.count / total),
										]),
									]),
						]),
					),
				),
	])
}

const bodyCard = (h: H, detail: EndpointDetail): Html =>
	card(h, "Request body", null, [
		detail.body === null
			? typography(h, { size: "2xs", tone: "muted", as: "p" }, [
					"No request carried ",
					typography(h, { tone: "soft" }, ["http.request.body.size"]),
					".",
				])
			: vstack(h, { gap: "2" }, [
					h.div(
						[h.Class("grid grid-cols-3 gap-2")],
						Arr.map(
							[
								{ label: "p50", bytes: detail.body.p50Bytes },
								{ label: "p95", bytes: detail.body.p95Bytes },
								{ label: "max", bytes: detail.body.maxBytes },
							],
							({ label, bytes }) =>
								vstack(h, { attributes: [h.Key(label)] }, [
									typography(h, { size: "3xs", tone: "muted" }, [label]),
									h.span([h.Class("text-ui tabular-nums")], [formatBytes(bytes)]),
								]),
						),
					),
					hint(h, `${formatNumber(detail.body.count)} requests reported a size`),
				]),
	])

const slowestCard = (h: H, detail: EndpointDetail, inputs: ViewInputs): Html =>
	vstack(h, { as: "section", className: "overflow-hidden rounded-md border bg-card" }, [
		hstack(h, { align: "center", justify: "between", className: "h-9 border-b px-3" }, [
			hstack(h, { gap: "2", align: "baseline" }, [
				sectionLabel(h, "Slowest requests"),
				h.span(
					[h.Class("hidden text-3xs text-muted-foreground sm:inline")],
					["slowest per hour and status"],
				),
			]),
			h.a(
				[
					h.Class(
						"flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground active:text-foreground",
					),
					h.Href(inputs.tracesHref({ slowest: true })),
				],
				["All traces", icon(h, "ArrowRightIcon", { size: 12 })],
			),
		]),
		...(detail.slowest.length === 0
			? [emptyMessage(h, {}, ["No requests in this window"])]
			: Arr.map(detail.slowest, (request) =>
					h.a(
						[
							h.Key(`${request.traceId}-${request.timestamp}`),
							h.Href(hrefOf(AppRoute.Trace({ traceId: request.traceId, search: {} }))),
							h.Class(
								"flex h-9 items-center gap-2 border-b px-3 text-2xs tabular-nums sm:gap-3 last:border-b-0 hover:bg-surface-sunken active:bg-surface-sunken",
							),
						],
						[
							truncatedId(h, {
								value: request.traceId,
								kind: "trace",
								className: "w-16 shrink-0 text-severity-debug sm:w-20",
							}),
							h.span(
								[h.Class("w-14 shrink-0 text-right")],
								[formatLatency(request.durationMs)],
							),
							h.span(
								[
									h.Class(
										cn(
											"w-10 shrink-0",
											Str.startsWith("2")(request.httpStatusCode)
												? TONE_TEXT.info
												: TONE_TEXT[
														isServerError(request.httpStatusCode)
															? "crit"
															: "warn"
													],
										),
									),
								],
								[request.httpStatusCode],
							),
							h.span(
								[h.Class("hidden min-w-0 flex-1 truncate text-muted-foreground sm:block")],
								[request.bodyBytes === null ? "" : formatBytes(request.bodyBytes)],
							),
							timestamp(h, {
								value: request.timestamp,
								timeZone: inputs.timeZone,
								nowMs: inputs.nowMs,
								label: formatTimestampInTimezone(request.timestamp, {
									timeZone: inputs.timeZone,
									style: "range",
								}),
								className: "ml-auto shrink-0 whitespace-nowrap text-muted-foreground",
							}),
						],
					),
				)),
	])

const detailSections = (h: H, model: Model, peek: Peek, inputs: ViewInputs): ReadonlyArray<Html> => {
	const slot = model.details[peek.endpoint.spanName]
	const data = slot?.data ?? AsyncData.Idle()
	return AsyncData.matchData(data, {
		onEmpty: () => [
			h.div(
				[h.Key("detail-loading"), h.Class("grid grid-cols-1 gap-3 sm:grid-cols-2"), h.AriaBusy(true)],
				Arr.map([0, 1, 2, 3], (index) =>
					h.div([h.Key(String(index))], [skeleton(h, "h-[148px] w-full rounded-md")]),
				),
			),
			skeleton(h, "h-[180px] w-full rounded-md"),
		],
		onFailure: (failure) => [
			errorState(h, {
				failure,
				title: "Couldn't load endpoint details",
				onRetry: Message.ClickedRetryDetail(),
			}),
		],
		onData: (detail) => [
			typography(h, { size: "2xs", tone: "muted", as: "p", attributes: [h.Key("detail-grain")] }, [
				"The cards below count whole hours, so they can reach past the window's edges.",
			]),
			h.div(
				[
					h.Key("detail-grid"),
					h.Class(
						cn(
							"grid grid-cols-1 gap-3 sm:grid-cols-2",
							refreshingClass(AsyncData.isRefreshing(data)),
						),
					),
				],
				[
					statusCard(h, inputs.statusRows, peek.endpoint.spanName),
					distributionCard(h, detail),
					clientsCard(h, detail, peek.endpoint.spanCount),
					bodyCard(h, detail),
				],
			),
			slowestCard(h, detail, inputs),
		],
	})
}

const stepButton = (
	h: H,
	label: string,
	iconName: "ChevronUpIcon" | "ChevronDownIcon",
	isEnabled: boolean,
	step: 1 | -1,
) =>
	iconButton(
		h,
		{
			variant: "outline",
			label,
			isDisabled: !isEnabled,
			attributes: [h.OnClick(Message.ClickedStep({ step }))],
		},
		[icon(h, iconName)],
	)

const header = (h: H, model: Model, peek: Peek, inputs: ViewInputs): Html =>
	sheetDetailHeader(h, {
		dialogId: model.dialog.id,
		kind: [methodLabel(h, peek.endpoint.method, "")],
		title: [peek.endpoint.route],
		description: inputs.scopeLabel,
		meta: [
			// The header's hidden description already reads the scope to screen readers.
			typography(h, { size: "xs", tone: "muted", attributes: [h.AriaHidden(true)] }, [
				inputs.scopeLabel,
			]),
			hstack(h, { gap: "1", align: "center", className: "ml-auto shrink-0" }, [
				stepButton(h, "Previous endpoint", "ChevronUpIcon", peek.index > 0, -1),
				stepButton(h, "Next endpoint", "ChevronDownIcon", peek.index < peek.count - 1, 1),
			]),
		],
		className: "border-b pb-4",
	})

const footer = (h: H, peek: Peek, inputs: ViewInputs): Html => {
	const topError = Option.getOrUndefined(
		Arr.findFirst(
			endpointStatusCodes(inputs.statusRows, peek.endpoint.spanName),
			(code) => Number(code.name) >= 400,
		),
	)
	return DialogView.dialogFooter(
		h,
		"sheet",
		[
			hstack(h, { gap: "2" }, [
				linkButton(h, { size: "sm", variant: "outline", href: inputs.tracesHref({}) }, [
					"Traces",
					icon(h, "ArrowRightIcon"),
				]),
				...(topError === undefined
					? []
					: [
							linkButton(
								h,
								{
									size: "sm",
									variant: "outline",
									href: inputs.tracesHref({ statusCode: topError.name }),
								},
								[`${topError.name} traces`, icon(h, "ArrowRightIcon")],
							),
						]),
				h.span(
					[h.Class("ml-1 hidden items-center gap-1 text-2xs text-muted-foreground sm:inline-flex")],
					[kbd(h, undefined, ["↑"]), kbd(h, undefined, ["↓"]), " walk the list"],
				),
			]),
			linkButton(
				h,
				{
					size: "sm",
					variant: "ghost",
					href: inputs.alertHref,
					attributes: [h.AriaLabel("Create alert")],
				},
				[icon(h, "BellIcon"), h.span([h.Class("hidden sm:inline")], ["Create alert"])],
			),
		],
		"flex-row items-center justify-between gap-3 border-t sm:justify-between",
	)
}

const content = (h: H, model: Model, peek: Peek, inputs: ViewInputs): ReadonlyArray<Html> => [
	h.span([h.Hidden(true), h.OnMount(MountEndpointPeekKeys())], []),
	header(h, model, peek, inputs),
	DialogView.dialogPanel(
		h,
		"sheet",
		model.dialog.id,
		[
			stats(h, peek, endpointStatusCodes(inputs.statusRows, peek.endpoint.spanName), inputs.seconds),
			...charts(h, model, inputs),
			...detailSections(h, model, peek, inputs),
		],
		vstackClass({ gap: "4" }),
	),
	footer(h, peek, inputs),
]

/** The drawer; its content renders only while an endpoint is peeked. */
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
	h.submodel({
		slotId: `${model.dialog.id}-sheet`,
		model: model.dialog,
		view: DialogView.view,
		viewInputs: {
			className: "p-0 sm:max-w-[600px]",
			side: "right",
			hasTrigger: false,
			isPopupFocused: true,
			toView: ({ portal }) => portal,
			toContent: () => (inputs.peek === null ? [] : content(h, model, inputs.peek, inputs)),
		},
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
	}),
)
