import * as SheetStyles from "@maple/ui/styles/ui/sheet"
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
import { toEpochMs } from "@maple/ui/lib/time-format"
import { AsyncData, Submodel } from "foldkit"
import type * as Chart from "../../../../charts/chart"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../../route"
import { linkButton } from "../../../../ui/button"
import * as Dialog from "../../../../ui/dialog"
import * as DialogView from "../../../../ui/dialog-view"
import { kbd } from "../../../../ui/display"
import { emptyMessage } from "../../../../ui/empty"
import { errorState } from "../../../../ui/error-state"
import { eyebrow } from "../../../../ui/eyebrow"
import { icon } from "../../../../ui/icon"
import { iconButton } from "../../../../ui/icon-button"
import { skeleton } from "../../../../ui/skeleton"
import { truncatedId } from "../../../../ui/truncated-id"
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
import type { LoadFailure } from "../../../../data/load-failure"
import type { ApiBucket, EndpointDetail, StatusRow } from "../model-tabs"
import { type ChartContext, latencyChart, STATUS_COLORS, statusChart } from "../view-api-charts"
import { methodLabel } from "../view-api"
import { MountEndpointPeekKeys } from "./keys"
import { Message } from "./message"
import type { Model } from "./model"
import type { Peek } from "./update"

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
			h.div(
				[h.Class("flex items-baseline justify-between gap-2")],
				[sectionLabel(h, label), ...(aside === null ? [] : [aside])],
			),
			...children,
		],
	)

const hint = (h: H, text: string) => h.span([h.Class("text-3xs text-muted-foreground")], [text])

const stat = (h: H, label: string, value: string, sub: string, tone?: Tone): Html =>
	statRailItem(h, { eyebrow: label, value, subline: sub, tone, size: "sm", className: "min-w-0" })

const stats = (h: H, peek: Peek, codes: ReturnType<typeof endpointStatusCodes>, seconds: number): Html => {
	const { endpoint } = peek
	const mix = knownStatusMix(endpoint)
	const topClient = codes.find((code) => code.name.startsWith("4"))
	return statRail(h, { columns: 4, className: "overflow-hidden" }, [
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
	h.div(
		[h.Key(label), h.Class("flex items-center gap-1")],
		[h.span([h.Class("h-0.5 w-2"), h.Style({ background: color })]), h.span([], [label])],
	)

const chartSection = (h: H, title: string, legend: ReadonlyArray<Html>, body: Html): Html =>
	h.section(
		[h.Key(title), h.Class("flex flex-col gap-2")],
		[
			h.div(
				[h.Class("flex items-center justify-between")],
				[
					sectionLabel(h, title),
					h.div([h.Class("flex items-center gap-3 text-3xs text-muted-foreground")], legend),
				],
			),
			body,
		],
	)

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
	const errorType = rows
		.filter(
			(row) => row.spanName === spanName && row.errorType !== "" && Number(row.httpStatusCode) >= 400,
		)
		.toSorted((a, b) => b.estimatedSpanCount - a.estimatedSpanCount)[0]
	return card(h, "Status codes", null, [
		...(codes.length === 0
			? [h.p([h.Class("text-2xs text-muted-foreground")], ["No status codes recorded in this window."])]
			: codes.slice(0, 4).map((code) => {
					const tone = code.name.startsWith("2")
						? { text: TONE_TEXT.info, bar: "bg-chart-3" }
						: isServerError(code.name)
							? { text: TONE_TEXT.crit, bar: TONE_FILL.crit }
							: { text: TONE_TEXT.warn, bar: TONE_FILL.warn }
					return h.div(
						[h.Key(code.name), h.Class("flex flex-col gap-1")],
						[
							h.div(
								[h.Class("flex justify-between gap-2 text-2xs tabular-nums")],
								[
									h.span(
										[h.Class(cn("truncate", tone.text))],
										[`${code.name} ${reasonPhrase(code.name)}`.trim()],
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
						],
					)
				})),
		...(errorType === undefined
			? []
			: [
					h.span(
						[h.Class("mt-auto truncate text-3xs text-muted-foreground")],
						[
							`error.type `,
							h.span([h.Class("text-foreground/80")], [errorType.errorType]),
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
	const peak = bins.reduce((max, bin) => Math.max(max, bin.share), 0)
	const first = bins[0]
	const last = bins[bins.length - 1]
	return card(h, "Distribution", hint(h, "log scale"), [
		bins.length === 0 || first === undefined || last === undefined
			? h.p(
					[h.Class("text-2xs text-muted-foreground")],
					["Not enough requests to draw a distribution."],
				)
			: h.div(
					[h.Class("flex flex-col gap-1.5")],
					[
						h.div(
							[h.Class("flex h-16 items-end gap-[3px]")],
							bins.map((bin, index) =>
								h.div([
									h.Key(String(index)),
									h.Class(cn("flex-1 rounded-t-[2px]", BAND_CLASS[bin.band])),
									h.Style({
										height: `${peak > 0 ? Math.max((bin.share / peak) * 100, 2) : 2}%`,
									}),
									h.Title(
										`${formatLatency(bin.fromMs)} to ${formatLatency(bin.toMs)}: ${formatErrorRate(bin.share)} of requests`,
									),
								]),
							),
						),
						h.div(
							[h.Class("flex justify-between text-3xs text-muted-foreground tabular-nums")],
							[
								h.span([], [formatLatency(first.fromMs)]),
								h.span([], [formatLatency(last.toMs)]),
							],
						),
					],
				),
	])
}

/** User-agent counts are stored spans, so their share is of the endpoint's stored spans. */
const clientsCard = (h: H, detail: EndpointDetail, spanCount: number): Html => {
	const total = spanCount
	return card(h, "Top clients", hint(h, "user_agent.original"), [
		detail.userAgents.length === 0
			? h.p([h.Class("text-2xs text-muted-foreground")], ["No requests carried a user agent."])
			: h.div(
					[h.Class("flex flex-col gap-1.5 text-2xs tabular-nums")],
					detail.userAgents
						.slice(0, 5)
						.map((agent) =>
							h.div(
								[h.Key(agent.value), h.Class("flex items-center gap-2")],
								[
									h.span(
										[h.Class("min-w-0 flex-1 truncate"), h.Title(agent.value)],
										[agent.value === "" ? "(no user agent)" : agent.value],
									),
									...(agent.count === null || total === 0
										? []
										: [
												h.span(
													[h.Class("shrink-0 text-muted-foreground")],
													[formatErrorRate(agent.count / total)],
												),
											]),
								],
							),
						),
				),
	])
}

const bodyCard = (h: H, detail: EndpointDetail): Html =>
	card(h, "Request body", null, [
		detail.body === null
			? h.p(
					[h.Class("text-2xs text-muted-foreground")],
					[
						"No request carried ",
						h.span([h.Class("text-foreground/80")], ["http.request.body.size"]),
						".",
					],
				)
			: h.div(
					[h.Class("flex flex-col gap-2")],
					[
						h.div(
							[h.Class("grid grid-cols-3 gap-2")],
							[
								{ label: "p50", bytes: detail.body.p50Bytes },
								{ label: "p95", bytes: detail.body.p95Bytes },
								{ label: "max", bytes: detail.body.maxBytes },
							].map(({ label, bytes }) =>
								h.div(
									[h.Key(label), h.Class("flex flex-col")],
									[
										h.span([h.Class("text-3xs text-muted-foreground")], [label]),
										h.span([h.Class("text-ui tabular-nums")], [formatBytes(bytes)]),
									],
								),
							),
						),
						hint(h, `${formatNumber(detail.body.count)} requests reported a size`),
					],
				),
	])

/** "Oct 24 13:40" in the page time zone, 24-hour like the rest of the page. */
const formatSlowestTime = (timestamp: string, timeZone: string): string =>
	new Intl.DateTimeFormat("en-US", {
		timeZone,
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(toEpochMs(timestamp))

const slowestCard = (h: H, detail: EndpointDetail, inputs: ViewInputs): Html =>
	h.section(
		[h.Class("flex flex-col overflow-hidden rounded-md border bg-card")],
		[
			h.div(
				[h.Class("flex h-9 items-center justify-between border-b px-3")],
				[
					h.div(
						[h.Class("flex items-baseline gap-2")],
						[
							sectionLabel(h, "Slowest requests"),
							h.span(
								[h.Class("hidden text-3xs text-muted-foreground sm:inline")],
								["slowest per hour and status"],
							),
						],
					),
					h.a(
						[
							h.Class(
								"flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground",
							),
							h.Href(inputs.tracesHref({ slowest: true })),
						],
						["All traces", icon(h, "ArrowRightIcon", { size: 12 })],
					),
				],
			),
			...(detail.slowest.length === 0
				? [emptyMessage(h, {}, ["No requests in this window."])]
				: detail.slowest.map((request) =>
						h.a(
							[
								h.Key(`${request.traceId}-${request.timestamp}`),
								h.Href(hrefOf(AppRoute.Trace({ traceId: request.traceId, search: {} }))),
								h.Class(
									"flex h-9 items-center gap-2 border-b px-3 text-2xs tabular-nums sm:gap-3 last:border-b-0 hover:bg-muted/40",
								),
							],
							[
								truncatedId(h, {
									value: request.traceId,
									kind: "trace",
									className: "w-16 shrink-0 text-info-foreground sm:w-20",
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
												request.httpStatusCode.startsWith("2")
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
									[
										h.Class(
											"hidden min-w-0 flex-1 truncate text-muted-foreground sm:block",
										),
									],
									[request.bodyBytes === null ? "" : formatBytes(request.bodyBytes)],
								),
								h.span(
									[h.Class("ml-auto shrink-0 whitespace-nowrap text-muted-foreground")],
									[formatSlowestTime(request.timestamp, inputs.timeZone)],
								),
							],
						),
					)),
		],
	)

const detailSections = (h: H, model: Model, peek: Peek, inputs: ViewInputs): ReadonlyArray<Html> => {
	const slot = model.details[peek.endpoint.spanName]
	const data = slot?.data ?? AsyncData.Idle()
	return AsyncData.matchData(data, {
		onEmpty: () => [
			h.div(
				[h.Key("detail-loading"), h.Class("grid grid-cols-1 gap-3 sm:grid-cols-2"), h.AriaBusy(true)],
				[0, 1, 2, 3].map((index) =>
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
			h.p(
				[h.Key("detail-grain"), h.Class("text-2xs text-muted-foreground")],
				["The cards below count whole hours, so they can reach past the window's edges."],
			),
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
	DialogView.dialogHeader(
		h,
		"sheet",
		[
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					methodLabel(h, peek.endpoint.method, ""),
					h.h2(
						[
							h.Class(
								cn(SheetStyles.sheetTitleStyles, "min-w-0 truncate text-title font-medium"),
							),
							h.DataAttribute("slot", "sheet-title"),
							h.Id(Dialog.titleId(model.dialog.id)),
							h.Title(peek.endpoint.route),
						],
						[peek.endpoint.route],
					),
					h.div(
						[h.Class("ml-auto flex shrink-0 items-center gap-1")],
						[
							stepButton(h, "Previous endpoint", "ChevronUpIcon", peek.index > 0, -1),
							stepButton(h, "Next endpoint", "ChevronDownIcon", peek.index < peek.count - 1, 1),
						],
					),
				],
			),
			h.p(
				[
					h.Class(cn(SheetStyles.sheetDescriptionStyles, "text-2xs text-muted-foreground")),
					h.DataAttribute("slot", "sheet-description"),
					h.Id(Dialog.descriptionId(model.dialog.id)),
				],
				[inputs.scopeLabel],
			),
		],
		"gap-1.5 border-b pr-14 pb-4",
	)

const footer = (h: H, peek: Peek, inputs: ViewInputs): Html => {
	const topError = endpointStatusCodes(inputs.statusRows, peek.endpoint.spanName).find(
		(code) => Number(code.name) >= 400,
	)
	return DialogView.dialogFooter(
		h,
		"sheet",
		[
			h.div(
				[h.Class("flex items-center gap-2")],
				[
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
						[
							h.Class(
								"ml-1 hidden items-center gap-1 text-2xs text-muted-foreground sm:inline-flex",
							),
						],
						[kbd(h, undefined, ["↑"]), kbd(h, undefined, ["↓"]), " walk the list"],
					),
				],
			),
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
		"flex flex-col gap-4",
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
