import {
	CLIENT_ERROR_NOTABLE,
	CPU_HEAVY_P99_MS,
	MIN_RATED_REQUESTS,
	SLOW_P99_MS,
	type WorkerHealth,
	workerHealth,
	type WorkerListRow,
	workerRowKey,
} from "../../../../components/infra/cloudflare/list-model"
import { errorRateClass } from "@maple/ui/lib/error-rate"
import {
	EMPTY_VALUE,
	formatBytes,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercent,
} from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../../charts/chart"
import * as Sparkline from "../../../../charts/sparkline"
import { resolveColor, type ThemeColors } from "../../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../../route"
import { segmentedBar } from "../../../../ui/meter"
import { skeleton } from "../../../../ui/skeleton"
import {
	columnHead,
	dataTable,
	dataTableEmpty,
	skeletonRows,
	ROW_LINK_CLASS,
} from "../../../infra/kit/data-table"
import { metaLine } from "../../../infra/kit/meta-line"
import { type Sort, sortRowsByField } from "../../../kit/table-sort"
import type { QueueRow, ZoneRow } from "../data"
import { Message, type QueueSortKey, type ZoneSortKey } from "./model"

// `CloudflareZoneTable`, `CloudflareWorkerTable`, `CloudflareQueueTable`.

type H = HtmlBuilder<Message>

// The server caps the list at 500 rows, so the row area scrolls rather than growing the page.
const TABLE_MAX_HEIGHT = "560px"
const NAME = "w-0 flex-1 min-w-[200px]"
const NUMBER = "text-right font-mono text-xs tabular-nums"

export type SparkContext = Readonly<{ theme: ThemeColors | null; isChartReady: boolean }>

// ZONES

const zoneHead = (
	h: H,
	label: string,
	width: string,
	options: Readonly<{ key?: ZoneSortKey; sort?: Sort<ZoneSortKey>; align?: "right"; hidden?: string }>,
): Html =>
	columnHead(h, {
		label,
		width,
		align: options.align,
		hidden: options.hidden,
		sort:
			options.key === undefined
				? undefined
				: {
						onSort:
							options.sort === undefined
								? undefined
								: Message.ClickedZoneSort({ key: options.key }),
						isActive: options.sort?.key === options.key,
						dir: options.sort?.dir ?? "desc",
					},
	})

/** Declared once and rendered by both the table and its skeleton so widths cannot drift. */
const zoneColumns = (
	h: H,
	sort: Sort<ZoneSortKey> | undefined,
	showAccount: boolean,
	showLatency: boolean,
): ReadonlyArray<Html> => [
	zoneHead(h, "Zone", NAME, { key: "zoneName", sort }),
	...(showAccount ? [zoneHead(h, "Account", "w-[120px]", { hidden: "hidden lg:flex" })] : []),
	zoneHead(h, "Requests", "w-[170px]", { key: "requests", sort }),
	zoneHead(h, "Status mix", "w-[170px]", { key: "clientErrorRate", sort, hidden: "hidden md:flex" }),
	zoneHead(h, "5xx", "w-[70px]", { key: "errorRate", sort, align: "right" }),
	zoneHead(h, "Cache hit", "w-[120px]", {
		key: "cacheHitRate",
		sort,
		align: "right",
		hidden: "hidden lg:flex",
	}),
	...(showLatency
		? [
				zoneHead(h, "TTFB p99", "w-[80px]", {
					key: "ttfbP99Ms",
					sort,
					align: "right",
					hidden: "hidden lg:flex",
				}),
			]
		: []),
	zoneHead(h, "Bandwidth", "w-[80px]", { key: "bytes", sort, align: "right", hidden: "hidden md:flex" }),
]

export const zoneTableLoading = (h: H): Html =>
	dataTable(
		h,
		{ ariaLabel: "Zones" },
		zoneColumns(h, undefined, false, false),
		skeletonRows(h, 4, () => [
			h.div(
				[h.Class("w-0 min-w-[200px] flex-1 space-y-1.5")],
				[skeleton(h, "h-3.5 w-40"), skeleton(h, "h-2.5 w-24")],
			),
			skeleton(h, "h-4 w-[170px]"),
			skeleton(h, "hidden h-1.5 w-[170px] md:block"),
			skeleton(h, "h-3 w-[70px]"),
			skeleton(h, "hidden h-3 w-[120px] lg:block"),
			skeleton(h, "hidden h-3 w-[80px] md:block"),
		]),
	)

const CHART_MODEL = Chart.init()

const requestSpark = (
	h: H,
	ctx: SparkContext,
	zone: ZoneRow,
	values: ReadonlyArray<number> | undefined,
): Html =>
	values === undefined || values.length < 2 || ctx.theme === null || !ctx.isChartReady
		? h.div([h.Class("h-5 min-w-0 flex-1")])
		: h.div(
				[h.Class("h-5 min-w-0 flex-1")],
				[
					h.submodel({
						slotId: `cf-spark-${zone.serviceName}`,
						model: CHART_MODEL,
						view: Sparkline.view,
						toParentMessage: (message: Chart.Message) => Message.GotSparklineMessage({ message }),
						viewInputs: {
							chartId: `cf-spark-${zone.zoneName.replace(/\W+/g, "_")}`,
							values,
							color: resolveColor(ctx.theme, "--chart-2"),
							className: "h-full w-full",
							revision: 0,
							curve: "monotone",
							fillOpacity: [0.35, 0],
						},
					}),
				],
			)

/** One bar per zone: 2xx/3xx/4xx/5xx shares, labelled with whichever error class dominates. */
const statusMix = (h: H, zone: ZoneRow, rated: boolean): Html => {
	const label =
		zone.errorRate >= 0.01
			? { text: `${formatPercent(zone.errorRate)} 5xx`, className: "text-severity-error" }
			: {
					text: `${formatPercent(zone.clientErrorRate)} 4xx`,
					className:
						zone.clientErrorRate >= CLIENT_ERROR_NOTABLE
							? "text-severity-warn"
							: "text-muted-foreground",
				}
	return h.div(
		[h.Class("hidden w-[170px] items-center gap-2.5 md:flex")],
		[
			segmentedBar(h, {
				className: "w-[100px] shrink-0 gap-px bg-transparent",
				minVisible: 2,
				label: `2xx ${zone.requests2xx}, 3xx ${zone.requests3xx}, 4xx ${zone.errors4xx}, 5xx ${zone.errors5xx}`,
				segments: [
					{ key: "2xx", value: zone.requests2xx, className: "bg-severity-info" },
					{ key: "3xx", value: zone.requests3xx, className: "bg-chart-2" },
					{ key: "4xx", value: zone.errors4xx, className: "bg-severity-warn" },
					{ key: "5xx", value: zone.errors5xx, className: "bg-severity-error" },
				],
			}),
			h.span(
				[
					h.Class(
						cn(
							"truncate font-mono text-2xs tabular-nums",
							rated ? label.className : "text-muted-foreground",
						),
					),
				],
				[rated ? label.text : EMPTY_VALUE],
			),
		],
	)
}

const zoneRow = (
	h: H,
	zone: ZoneRow,
	options: Readonly<{
		sparks: ReadonlyMap<string, ReadonlyArray<number>> | undefined
		accounts: ReadonlyMap<string, string> | undefined
		showLatency: boolean
		spark: SparkContext
	}>,
): Html => {
	const rated = zone.requests >= MIN_RATED_REQUESTS
	const meta = metaLine(h, [
		zone.visits > 0 ? `${formatNumber(zone.visits)} visits` : "",
		rated ? "" : "too few requests to rate",
	])
	return h.a(
		[
			h.Key(zone.serviceName),
			h.Class(ROW_LINK_CLASS),
			h.Href(hrefOf(AppRoute.InfraCloudflareZone({ zoneName: zone.zoneName, search: {} }))),
		],
		[
			h.div(
				[h.Class("w-0 min-w-[200px] flex-1 space-y-0.5")],
				[
					h.div(
						[
							h.Class(
								"truncate font-mono text-xs font-medium text-foreground transition-colors group-hover:text-primary",
							),
							h.Title(zone.zoneName),
						],
						[zone.zoneName],
					),
					...(meta === null ? [] : [meta]),
				],
			),
			...(options.accounts === undefined
				? []
				: [
						h.div(
							[
								h.Class(
									"hidden w-[120px] truncate font-mono text-2xs text-muted-foreground lg:block",
								),
							],
							[options.accounts.get(zone.serviceName) ?? EMPTY_VALUE],
						),
					]),
			h.div(
				[h.Class("flex w-[170px] items-center gap-3")],
				[
					h.span(
						[h.Class("w-[56px] shrink-0 font-mono text-xs tabular-nums text-foreground/80")],
						[formatNumber(zone.requests)],
					),
					requestSpark(h, options.spark, zone, options.sparks?.get(zone.serviceName)),
				],
			),
			statusMix(h, zone, rated),
			h.div(
				[
					h.Class(
						cn(
							"w-[70px]",
							NUMBER,
							rated ? errorRateClass(zone.errorRate) : "text-muted-foreground",
						),
					),
				],
				[rated ? formatErrorRate(zone.errorRate) : EMPTY_VALUE],
			),
			h.div(
				[h.Class("hidden w-[120px] flex-col items-end gap-0.5 lg:flex")],
				[
					h.span(
						[h.Class("font-mono text-xs tabular-nums text-foreground/80")],
						[zone.cacheHitRate === null ? EMPTY_VALUE : formatPercent(zone.cacheHitRate)],
					),
					h.span(
						[h.Class("font-mono text-3xs text-muted-foreground")],
						[
							zone.cacheHitRate === null
								? "nothing cacheable"
								: `of ${formatPercent(zone.requests > 0 ? zone.cacheableRequests / zone.requests : 0)} cacheable`,
						],
					),
				],
			),
			...(options.showLatency
				? [
						h.div(
							[h.Class(cn("hidden w-[80px] text-foreground/80 lg:block", NUMBER))],
							[zone.ttfbP99Ms > 0 ? formatLatency(zone.ttfbP99Ms) : EMPTY_VALUE],
						),
					]
				: []),
			h.div(
				[h.Class(cn("hidden w-[80px] text-foreground/80 md:block", NUMBER))],
				[formatBytes(zone.bytes)],
			),
		],
	)
}

export const zoneTable = (
	h: H,
	options: Readonly<{
		zones: ReadonlyArray<ZoneRow>
		sparks: ReadonlyMap<string, ReadonlyArray<number>> | undefined
		accounts: ReadonlyMap<string, string> | undefined
		sort: Sort<ZoneSortKey>
		emptyMessage: string | undefined
		spark: SparkContext
	}>,
): Html => {
	const sorted = sortRowsByField(options.zones, options.sort)
	// Latency quantiles are plan-gated; four always-empty columns were most of the old table.
	const showLatency = options.zones.some((zone) => zone.ttfbP99Ms > 0)
	return dataTable(
		h,
		{ ariaLabel: "Cloudflare zones", maxHeight: TABLE_MAX_HEIGHT },
		zoneColumns(h, options.sort, options.accounts !== undefined, showLatency),
		sorted.length === 0
			? [dataTableEmpty(h, [options.emptyMessage ?? "No zone traffic in the selected window."])]
			: sorted.map((zone) =>
					zoneRow(h, zone, {
						sparks: options.sparks,
						accounts: options.accounts,
						showLatency,
						spark: options.spark,
					}),
				),
	)
}

// WORKERS

const HEALTH_DOT = {
	erroring: "bg-severity-error",
	slow: "bg-severity-warn",
	ok: "bg-severity-info",
} as const satisfies Record<WorkerHealth, string>

const workerMeta = (h: H, row: WorkerListRow) => [
	row.nameInOtherAccounts ? "name shared with another account" : "",
	row.errors > 0 ? `${formatNumber(row.errors)} of ${formatNumber(row.requests)} failed` : "",
	row.doRequests > 0
		? h.span(
				[...(row.doErrorRate >= 0.01 ? [h.Class("text-severity-error")] : [])],
				[
					"Durable Objects · ",
					formatNumber(row.doRequests),
					" calls",
					row.doErrors > 0 ? ` · ${formatErrorRate(row.doErrorRate)} failed` : "",
				],
			)
		: "",
	row.isPreview ? "preview deploy" : "",
]

const workerRow = (h: H, row: WorkerListRow, accounts: ReadonlyMap<string, string> | undefined): Html => {
	const health = workerHealth(row)
	const invocationsOnly = row.requests > 0
	const meta = metaLine(h, workerMeta(h, row))
	return h.a(
		[
			h.Key(workerRowKey(row)),
			h.Class(ROW_LINK_CLASS),
			h.Href(
				hrefOf(
					AppRoute.InfraCloudflareWorker({
						scriptName: row.scriptName,
						// A shared name is only one Worker once the account is pinned.
						search: {
							account:
								row.nameInOtherAccounts && row.accountId !== "" ? row.accountId : undefined,
						},
					}),
				),
			),
		],
		[
			h.span([h.AriaHidden(true), h.Class(cn("size-2 shrink-0 rounded-full", HEALTH_DOT[health]))]),
			h.div(
				[h.Class("w-0 min-w-[220px] flex-1 space-y-0.5")],
				[
					h.div(
						[
							h.Class(
								"truncate font-mono text-xs font-medium text-foreground transition-colors group-hover:text-primary",
							),
							h.Title(row.scriptName),
						],
						[row.scriptName],
					),
					...(meta === null ? [] : [meta]),
				],
			),
			...(accounts === undefined
				? []
				: [
						h.div(
							[
								h.Class(
									"hidden w-[110px] truncate font-mono text-2xs text-muted-foreground lg:block",
								),
							],
							[accounts.get(row.accountId) ?? EMPTY_VALUE],
						),
					]),
			h.div(
				[h.Class(cn("w-[90px] text-foreground/80", NUMBER))],
				[invocationsOnly ? formatNumber(row.requests) : EMPTY_VALUE],
			),
			h.div(
				[
					h.Class(
						cn(
							"w-[80px]",
							NUMBER,
							invocationsOnly ? errorRateClass(row.errorRate) : "text-muted-foreground",
						),
					),
				],
				[invocationsOnly ? formatErrorRate(row.errorRate) : EMPTY_VALUE],
			),
			h.div(
				[
					h.Class(
						cn(
							"hidden w-[80px] md:block",
							NUMBER,
							row.cpuP99Ms >= CPU_HEAVY_P99_MS ? "text-severity-warn" : "text-foreground/80",
						),
					),
				],
				[row.cpuP99Ms > 0 ? formatLatency(row.cpuP99Ms) : EMPTY_VALUE],
			),
			h.div(
				[
					h.Class(
						cn(
							"w-[100px]",
							NUMBER,
							row.durationP99Ms >= SLOW_P99_MS ? "text-severity-warn" : "text-foreground/80",
						),
					),
				],
				[row.durationP99Ms > 0 ? formatLatency(row.durationP99Ms) : EMPTY_VALUE],
			),
		],
	)
}

/** Rows arrive already ordered (problems first); the table doesn't re-sort them. */
export const workerTable = (
	h: H,
	options: Readonly<{
		rows: ReadonlyArray<WorkerListRow>
		accounts: ReadonlyMap<string, string> | undefined
		emptyMessage: string | undefined
	}>,
): Html =>
	dataTable(
		h,
		{ ariaLabel: "Cloudflare Workers", maxHeight: TABLE_MAX_HEIGHT },
		[
			h.div([h.Class("w-2 shrink-0")]),
			columnHead(h, { label: "Worker", width: "w-0 flex-1 min-w-[220px]" }),
			...(options.accounts === undefined
				? []
				: [columnHead(h, { label: "Account", width: "w-[110px]", hidden: "hidden lg:flex" })]),
			columnHead(h, { label: "Invocations", align: "right", width: "w-[90px]" }),
			columnHead(h, { label: "Errors", align: "right", width: "w-[80px]" }),
			columnHead(h, { label: "CPU p99", align: "right", width: "w-[80px]", hidden: "hidden md:flex" }),
			columnHead(h, { label: "Duration p99", align: "right", width: "w-[100px]" }),
		],
		options.rows.length === 0
			? [dataTableEmpty(h, [options.emptyMessage ?? "No Worker invocations in the selected window."])]
			: options.rows.map((row) => workerRow(h, row, options.accounts)),
	)

// QUEUES

const QUEUE_ROW =
	"flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0 hover:bg-muted/40"

const numCell = (h: H, value: string, hidden?: boolean): Html =>
	h.div(
		[
			h.Class(
				`w-[110px] text-right font-mono text-xs tabular-nums text-foreground/80 ${hidden === true ? "hidden md:block" : ""}`,
			),
		],
		[value],
	)

const queueHead = (
	h: H,
	label: string,
	key: QueueSortKey,
	sort: Sort<QueueSortKey>,
	width: string,
	align?: "right",
): Html =>
	columnHead(h, {
		label,
		width,
		align,
		sort: { onSort: Message.ClickedQueueSort({ key }), isActive: sort.key === key, dir: sort.dir },
	})

/** Queue backlog and consumer gauges, one row per queue. */
export const queueTable = (
	h: H,
	options: Readonly<{ queues: ReadonlyArray<QueueRow>; sort: Sort<QueueSortKey>; isWaiting: boolean }>,
): Html => {
	const sorted = sortRowsByField(options.queues, options.sort)
	const { sort } = options
	return dataTable(
		h,
		{ ariaLabel: "Cloudflare queues", isWaiting: options.isWaiting },
		[
			queueHead(h, "Queue", "queueName", sort, "w-0 flex-1 min-w-[220px]"),
			queueHead(h, "Backlog avg", "backlogMessages", sort, "w-[110px]", "right"),
			queueHead(h, "Backlog peak", "backlogMessagesMax", sort, "w-[110px]", "right"),
			columnHead(h, {
				label: "Backlog size",
				align: "right",
				width: "w-[110px]",
				hidden: "hidden md:flex",
			}),
			queueHead(h, "Consumers", "consumerConcurrency", sort, "w-[110px]", "right"),
		],
		sorted.length === 0
			? [dataTableEmpty(h, ["No queue activity in the selected window."])]
			: sorted.map((queue) =>
					h.div(
						[h.Key(queue.serviceName), h.Class(QUEUE_ROW)],
						[
							h.div(
								[
									h.Class(
										"w-0 min-w-[220px] flex-1 truncate font-mono text-xs font-medium text-foreground",
									),
								],
								[queue.queueName],
							),
							numCell(h, formatNumber(Math.round(queue.backlogMessages))),
							numCell(h, formatNumber(Math.round(queue.backlogMessagesMax))),
							numCell(h, formatBytes(queue.backlogBytes), true),
							numCell(h, queue.consumerConcurrency.toFixed(1)),
						],
					),
				),
	)
}
