import {
	CLIENT_ERROR_NOTABLE,
	CPU_HEAVY_P99_MS,
	MIN_RATED_REQUESTS,
	SLOW_P99_MS,
	workerHealth,
	type WorkerListRow,
	workerRowKey,
	WORKER_HEALTH_TONE,
} from "../../../../components/infra/cloudflare/list-model"
import { ERROR_RATE_WARN, errorRateClass } from "@maple/ui/lib/error-rate"
import {
	EMPTY_VALUE,
	formatBytes,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercentColumn,
} from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../../charts/chart"
import * as Sparkline from "../../../../charts/sparkline"
import { resolveColor, type ThemeColors } from "../../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../../route"
import { segmentedBar } from "../../../../ui/meter"
import { skeleton } from "../../../../ui/skeleton"
import { statusDot } from "../../../../ui/status-dot"
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
// Capped: a short zone name on a wide page otherwise opens a gulf before its numbers.
const NAME = "w-0 flex-1 min-w-52 max-w-90"
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
	...(showAccount ? [zoneHead(h, "Account", "w-32", { hidden: "hidden lg:flex" })] : []),
	zoneHead(h, "Requests", "w-48", { key: "requests", sort }),
	zoneHead(h, "Status mix", "w-52", { key: "clientErrorRate", sort, hidden: "hidden md:flex" }),
	zoneHead(h, "5xx", "w-20", { key: "errorRate", sort, align: "right" }),
	zoneHead(h, "Cache hit", "w-32", {
		key: "cacheHitRate",
		sort,
		align: "right",
		hidden: "hidden lg:flex",
	}),
	...(showLatency
		? [
				zoneHead(h, "TTFB p99", "w-20", {
					key: "ttfbP99Ms",
					sort,
					align: "right",
					hidden: "hidden lg:flex",
				}),
			]
		: []),
	zoneHead(h, "Bandwidth", "w-24", { key: "bytes", sort, align: "right", hidden: "hidden md:flex" }),
]

export const zoneTableLoading = (h: H): Html =>
	dataTable(
		h,
		{ ariaLabel: "Zones" },
		zoneColumns(h, undefined, false, false),
		skeletonRows(h, 4, () => [
			h.div([h.Class(cn(NAME, "space-y-1.5"))], [skeleton(h, "h-3.5 w-40"), skeleton(h, "h-2.5 w-24")]),
			skeleton(h, "h-4 w-48"),
			skeleton(h, "hidden h-1.5 w-52 md:block"),
			skeleton(h, "h-3 w-20"),
			skeleton(h, "hidden h-3 w-32 lg:block"),
			skeleton(h, "hidden h-3 w-24 md:block"),
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

/**
 * One bar per zone: 2xx/3xx/4xx/5xx shares, captioned with the 5xx share when the zone is serving
 * 5xx (the "Serving 5xx" rule), else the 4xx share, amber at the "Mostly 4xx" threshold.
 */
const statusMix = (h: H, zone: ZoneRow, rated: boolean): Html => {
	const label =
		zone.errorRate >= ERROR_RATE_WARN
			? {
					text: `${formatPercentColumn(zone.errorRate)} 5xx`,
					className: "text-severity-error",
					title: "1% or more of requests are 5xx",
				}
			: zone.clientErrorRate >= CLIENT_ERROR_NOTABLE
				? {
						text: `${formatPercentColumn(zone.clientErrorRate)} 4xx`,
						className: "text-severity-warn",
						title: "Half or more of requests are 4xx",
					}
				: {
						text: `${formatPercentColumn(zone.clientErrorRate)} 4xx`,
						className: "text-muted-foreground",
						title: undefined,
					}
	return h.div(
		[h.Class("hidden w-52 items-center gap-2.5 md:flex")],
		[
			segmentedBar(h, {
				className: "w-24 shrink-0 gap-px bg-transparent",
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
					...(rated && label.title !== undefined ? [h.Title(label.title)] : []),
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
				[h.Class(cn(NAME, "space-y-0.5"))],
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
									"hidden w-32 truncate font-mono text-2xs text-muted-foreground lg:block",
								),
							],
							[options.accounts.get(zone.serviceName) ?? EMPTY_VALUE],
						),
					]),
			h.div(
				[h.Class("flex w-48 items-center gap-3")],
				[
					h.span(
						[h.Class("w-[56px] shrink-0 font-mono text-xs tabular-nums text-foreground-soft")],
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
							"w-20",
							NUMBER,
							rated ? errorRateClass(zone.errorRate) : "text-muted-foreground",
						),
					),
				],
				[rated ? formatErrorRate(zone.errorRate) : EMPTY_VALUE],
			),
			h.div(
				[h.Class("hidden w-32 flex-col items-end gap-0.5 lg:flex")],
				[
					h.span(
						[h.Class("font-mono text-xs tabular-nums text-foreground-soft")],
						[zone.cacheHitRate === null ? EMPTY_VALUE : formatPercentColumn(zone.cacheHitRate)],
					),
					h.span(
						[h.Class("font-mono text-3xs text-muted-foreground")],
						[
							zone.cacheHitRate === null
								? "nothing cacheable"
								: `of ${formatPercentColumn(zone.requests > 0 ? zone.cacheableRequests / zone.requests : 0)} cacheable`,
						],
					),
				],
			),
			...(options.showLatency
				? [
						h.div(
							[h.Class(cn("hidden w-20 text-foreground-soft lg:block", NUMBER))],
							[zone.ttfbP99Ms > 0 ? formatLatency(zone.ttfbP99Ms) : EMPTY_VALUE],
						),
					]
				: []),
			h.div(
				[h.Class(cn("hidden w-24 text-foreground-soft md:block", NUMBER))],
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
		{ ariaLabel: "Cloudflare zones" },
		zoneColumns(h, options.sort, options.accounts !== undefined, showLatency),
		sorted.length === 0
			? [dataTableEmpty(h, [options.emptyMessage ?? "No zone traffic in this window"])]
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
			statusDot(h, { tone: WORKER_HEALTH_TONE[health], size: "lg" }),
			h.div(
				[h.Class("w-0 min-w-56 flex-1 space-y-0.5")],
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
									"hidden w-28 truncate font-mono text-2xs text-muted-foreground lg:block",
								),
							],
							[accounts.get(row.accountId) ?? EMPTY_VALUE],
						),
					]),
			h.div(
				[h.Class(cn("w-24 text-foreground-soft", NUMBER))],
				[invocationsOnly ? formatNumber(row.requests) : EMPTY_VALUE],
			),
			h.div(
				[
					h.Class(
						cn(
							"w-20",
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
							"hidden w-20 md:block",
							NUMBER,
							row.cpuP99Ms >= CPU_HEAVY_P99_MS ? "text-severity-warn" : "text-foreground-soft",
						),
					),
				],
				[row.cpuP99Ms > 0 ? formatLatency(row.cpuP99Ms) : EMPTY_VALUE],
			),
			h.div(
				[
					h.Class(
						cn(
							"w-24",
							NUMBER,
							row.durationP99Ms >= SLOW_P99_MS ? "text-severity-warn" : "text-foreground-soft",
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
		{ ariaLabel: "Cloudflare Workers" },
		[
			h.div([h.Class("w-2 shrink-0")]),
			columnHead(h, { label: "Worker", width: "w-0 flex-1 min-w-56" }),
			...(options.accounts === undefined
				? []
				: [columnHead(h, { label: "Account", width: "w-28", hidden: "hidden lg:flex" })]),
			columnHead(h, { label: "Invocations", align: "right", width: "w-24" }),
			columnHead(h, { label: "Errors", align: "right", width: "w-20" }),
			columnHead(h, { label: "CPU p99", align: "right", width: "w-20", hidden: "hidden md:flex" }),
			columnHead(h, { label: "Duration p99", align: "right", width: "w-24" }),
		],
		options.rows.length === 0
			? [dataTableEmpty(h, [options.emptyMessage ?? "No Worker invocations in this window"])]
			: options.rows.map((row) => workerRow(h, row, options.accounts)),
	)

// QUEUES

const QUEUE_ROW =
	"flex items-center gap-4 border-b border-border-subtle px-4 py-3 last:border-0 hover:bg-surface-sunken active:bg-surface-sunken"

const numCell = (h: H, value: string, hidden?: boolean): Html =>
	h.div(
		[
			h.Class(
				`w-28 text-right font-mono text-xs tabular-nums text-foreground-soft ${hidden === true ? "hidden md:block" : ""}`,
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
			queueHead(h, "Queue", "queueName", sort, "w-0 flex-1 min-w-56"),
			queueHead(h, "Backlog avg", "backlogMessages", sort, "w-28", "right"),
			queueHead(h, "Backlog peak", "backlogMessagesMax", sort, "w-28", "right"),
			columnHead(h, {
				label: "Backlog size",
				align: "right",
				width: "w-28",
				hidden: "hidden md:flex",
			}),
			queueHead(h, "Consumers", "consumerConcurrency", sort, "w-28", "right"),
		],
		sorted.length === 0
			? [dataTableEmpty(h, ["No queue activity in this window"])]
			: sorted.map((queue) =>
					h.div(
						[h.Key(queue.serviceName), h.Class(QUEUE_ROW)],
						[
							h.div(
								[
									h.Class(
										"w-0 min-w-56 flex-1 truncate font-mono text-xs font-medium text-foreground",
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
