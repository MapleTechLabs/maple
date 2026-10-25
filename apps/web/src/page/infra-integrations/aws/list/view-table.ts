import { AWS_INFRA_KINDS, type AwsInfraKindId } from "@maple/domain/aws-infra"
import {
	EMPTY_VALUE,
	formatBytes,
	formatLatency,
	formatPercent,
	formatRate,
	formatUptime,
	pluralize,
} from "@maple/ui/lib/format"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../../route"
import { meter } from "../../../../ui/meter"
import { skeleton } from "../../../../ui/skeleton"
import { columnHead, dataTable, ROW_LINK_CLASS, skeletonRows } from "../../../infra/kit/data-table"
import { type SparkWindow, windowSparkline } from "../../kit/window-sparkline"
import type { TracedService } from "../data"
import {
	cpuShare,
	type Health,
	HOT,
	lambdaErrorRate,
	lb5xxRate,
	memoryShare,
	perMinute,
	type ResourceView,
	resourceSearch,
	type SparkIndex,
	sparkPoints,
	tracedAs,
} from "../derive"
import type { Message } from "./message"

// One kind's resource table and its loading state.

type H = HtmlBuilder<Message>

export type TableContext = Readonly<{
	sparks: SparkIndex
	traced: ReadonlyArray<TracedService> | null
	window: SparkWindow
	windowMs: number
}>

type Column = Readonly<{
	label: string
	width: string
	align?: "right"
	hidden?: string
	/** The "Traced as" column, dropped when no row in view is traced. */
	traced?: true
	cell: (h: H, view: ResourceView, context: TableContext) => Html
}>

const MUTED = "font-mono text-2xs text-muted-foreground"
const NUMBER = "font-mono text-xs tabular-nums text-foreground/80"

const DOT = {
	crit: "bg-severity-error",
	warn: "bg-severity-warn",
	idle: "border border-muted-foreground bg-transparent",
	ok: "bg-success",
} satisfies Record<Health, string>

const reading = (view: ResourceView, key: string) => view.readings[key]?.value ?? null

const numberCell = (h: H, text: string | null, tone?: "crit" | "warn"): Html =>
	h.span(
		[
			h.Class(
				cn(
					text === null ? MUTED : NUMBER,
					tone === "crit" && "text-severity-error",
					tone === "warn" && "text-severity-warn",
				),
			),
		],
		[text ?? EMPTY_VALUE],
	)

/** A utilisation bar and its percent; a resource without the metric shows an empty track. */
const usageCell = (h: H, label: string, fraction: number | null): Html => {
	const tone: Tone = fraction !== null && fraction >= HOT ? "warn" : "ok"
	return h.div(
		[h.Class("flex items-center gap-2")],
		[
			meter(h, {
				value: Math.min(fraction ?? 0, 1),
				tone,
				className: "h-1 w-20 shrink-0",
				label: fraction === null ? undefined : `${label} ${formatPercent(fraction)}`,
			}),
			// A fixed right-aligned slot, so "20%" and "1.7%" line up down the column.
			h.span(
				[h.Class("w-10 shrink-0 text-right")],
				[
					numberCell(
						h,
						fraction === null ? null : formatPercent(fraction),
						tone === "warn" ? "warn" : undefined,
					),
				],
			),
		],
	)
}

// A trend-only column passes no text; `null` is a figure that did not report.
const sparkCell = (h: H, view: ResourceView, context: TableContext, text?: string | null): Html =>
	h.div(
		[h.Class("flex w-full items-center gap-2")],
		[
			h.div(
				[h.Class(cn("shrink-0 text-chart-2", text === undefined ? "w-full" : "w-16"))],
				[
					windowSparkline(h, {
						points: sparkPoints(context.sparks, view),
						window: context.window,
						color: "currentColor",
						className: "h-5",
						// Every AWS sparkline metric is a share or a count.
						floor: 0,
					}),
				],
			),
			...(text === undefined ? [] : [numberCell(h, text)]),
		],
	)

const tracedCell = (h: H, view: ResourceView, context: TableContext): Html => {
	if (context.traced === null) return h.span([h.Class(MUTED)], [EMPTY_VALUE])
	const service = tracedAs(context.traced, view)
	return service === null
		? h.span([h.Class(MUTED)], ["not traced"])
		: h.span(
				[h.Class("truncate rounded-sm bg-muted px-1.5 py-0.5 font-mono text-2xs text-foreground/80")],
				[service.serviceName],
			)
}

const perMinuteText = (view: ResourceView, key: string, context: TableContext) => {
	const total = reading(view, key)
	return total === null ? null : formatRate(perMinute(total, context.windowMs))
}

const rateCell = (h: H, rate: number | null): Html =>
	numberCell(
		h,
		rate === null ? null : formatPercent(rate, { floor: 0.001 }),
		rate !== null && rate >= 0.01 ? "crit" : undefined,
	)

// Takes the row's slack once the name column hits its cap.
const TREND_WIDTH = "min-w-32 flex-1"

const COLUMNS = {
	ecs: [
		{ label: "CPU", width: "w-36", cell: (h, view) => usageCell(h, "CPU", cpuShare(view)) },
		{ label: "Memory", width: "w-36", cell: (h, view) => usageCell(h, "Memory", memoryShare(view)) },
		{
			label: "CPU trend",
			width: TREND_WIDTH,
			hidden: "hidden md:flex",
			cell: (h, view, context) => sparkCell(h, view, context),
		},
		{ label: "Traced as", width: "w-36", hidden: "hidden lg:flex", traced: true, cell: tracedCell },
	],
	ec2: [
		{ label: "CPU", width: "w-36", cell: (h, view) => usageCell(h, "CPU", cpuShare(view)) },
		{
			label: "CPU trend",
			width: TREND_WIDTH,
			hidden: "hidden md:flex",
			cell: (h, view, context) => sparkCell(h, view, context),
		},
		{
			label: "Network in",
			width: "w-24",
			align: "right",
			hidden: "hidden lg:flex",
			cell: (h, view) =>
				numberCell(
					h,
					reading(view, "networkIn") === null ? null : formatBytes(reading(view, "networkIn") ?? 0),
				),
		},
		{
			label: "Network out",
			width: "w-24",
			align: "right",
			hidden: "hidden lg:flex",
			cell: (h, view) =>
				numberCell(
					h,
					reading(view, "networkOut") === null
						? null
						: formatBytes(reading(view, "networkOut") ?? 0),
				),
		},
		{
			label: "Status checks",
			width: "w-24",
			align: "right",
			cell: (h, view) => {
				const failed = reading(view, "statusFailed")
				return numberCell(
					h,
					failed === null ? null : failed > 0 ? "failing" : "passing",
					failed !== null && failed > 0 ? "crit" : undefined,
				)
			},
		},
	],
	loadBalancers: [
		{
			label: "Requests / min",
			width: "w-36",
			cell: (h, view, context) => sparkCell(h, view, context, perMinuteText(view, "requests", context)),
		},
		{
			label: "5xx",
			width: "w-20",
			align: "right",
			cell: (h, view) => rateCell(h, lb5xxRate(view.readings)),
		},
		{
			label: "Avg response",
			width: "w-24",
			align: "right",
			cell: (h, view) => {
				const seconds = reading(view, "responseTime")
				return numberCell(h, seconds === null ? null : formatLatency(seconds * 1000))
			},
		},
	],
	rds: [
		{ label: "CPU", width: "w-36", cell: (h, view) => usageCell(h, "CPU", cpuShare(view)) },
		{
			label: "Connections",
			width: "w-24",
			align: "right",
			cell: (h, view) => {
				const peak = view.readings["connections"]?.peak ?? null
				return numberCell(h, peak === null ? null : String(Math.round(peak)))
			},
		},
		{
			label: "Free storage",
			width: "w-24",
			align: "right",
			hidden: "hidden md:flex",
			cell: (h, view) =>
				numberCell(
					h,
					reading(view, "freeStorage") === null
						? null
						: formatBytes(reading(view, "freeStorage") ?? 0),
				),
		},
		{
			label: "Free memory",
			width: "w-24",
			align: "right",
			hidden: "hidden lg:flex",
			cell: (h, view) =>
				numberCell(
					h,
					reading(view, "freeMemory") === null
						? null
						: formatBytes(reading(view, "freeMemory") ?? 0),
				),
		},
	],
	lambda: [
		{
			label: "Invocations / min",
			width: "w-36",
			cell: (h, view, context) =>
				sparkCell(h, view, context, perMinuteText(view, "invocations", context)),
		},
		{
			label: "Errors",
			width: "w-20",
			align: "right",
			cell: (h, view) => rateCell(h, lambdaErrorRate(view.readings)),
		},
		{
			label: "Throttles",
			width: "w-20",
			align: "right",
			cell: (h, view) => {
				const throttles = reading(view, "throttles")
				return numberCell(
					h,
					throttles === null ? null : formatRate(throttles),
					throttles !== null && throttles > 0 ? "warn" : undefined,
				)
			},
		},
		{
			label: "Avg duration",
			width: "w-24",
			align: "right",
			hidden: "hidden md:flex",
			cell: (h, view) => {
				const ms = reading(view, "duration")
				return numberCell(h, ms === null ? null : formatLatency(ms))
			},
		},
		{ label: "Traced as", width: "w-36", hidden: "hidden lg:flex", traced: true, cell: tracedCell },
	],
	sqs: [
		{
			label: "Visible messages",
			width: "w-36",
			cell: (h, view, context) => {
				const visible = reading(view, "visible")
				return sparkCell(h, view, context, visible === null ? null : formatRate(visible))
			},
		},
		{
			label: "Oldest message",
			width: "w-24",
			align: "right",
			cell: (h, view) => {
				const age = view.readings["oldestAge"]?.peak ?? null
				return numberCell(
					h,
					age === null ? null : formatUptime(age),
					view.health === "warn" ? "warn" : undefined,
				)
			},
		},
		{
			label: "Sent / min",
			width: "w-24",
			align: "right",
			hidden: "hidden md:flex",
			cell: (h, view, context) => numberCell(h, perMinuteText(view, "sent", context)),
		},
	],
} satisfies Record<AwsInfraKindId, ReadonlyArray<Column>>

const columnsOf = (kind: AwsInfraKindId, showTraced = true): ReadonlyArray<Column> =>
	showTraced ? COLUMNS[kind] : COLUMNS[kind].filter((column: Column) => column.traced !== true)

/** False once the traced services loaded and none of the rows matches one. */
const anyTraced = (views: ReadonlyArray<ResourceView>, traced: TableContext["traced"]): boolean =>
	traced === null || views.some((view) => tracedAs(traced, view) !== null)

// Grows far ahead of a CPU trend column, so it reaches its cap before the trend widens.
const NAME_COLUMN = { label: "", width: "w-0 min-w-48 max-w-[480px] flex-[999_1_0%]" }

const heads = (h: H, kind: AwsInfraKindId, nameLabel: string, showTraced = true): ReadonlyArray<Html> => [
	columnHead(h, { label: nameLabel, width: NAME_COLUMN.width }),
	...columnsOf(kind, showTraced).map((column) =>
		columnHead(h, {
			label: column.label,
			width: column.width,
			align: column.align,
			hidden: column.hidden,
		}),
	),
]

export const awsTableLoading = (h: H, kind: AwsInfraKindId, nameLabel: string): Html =>
	dataTable(
		h,
		{ ariaLabel: `AWS ${nameLabel}` },
		heads(h, kind, nameLabel),
		skeletonRows(h, 5, () => [
			h.div(
				[h.Class(cn(NAME_COLUMN.width, "space-y-1.5"))],
				[skeleton(h, "h-3.5 w-36"), skeleton(h, "h-2.5 w-48")],
			),
			...columnsOf(kind).map((column) => skeleton(h, cn("h-3", column.width, column.hidden))),
		]),
	)

/** "prod · us-east-1", or the reason it needs a look. */
const subline = (view: ResourceView): Html | string =>
	[view.cluster, view.region].filter((part) => part !== "").join(" · ")

const row = (h: H, view: ResourceView, context: TableContext, showTraced: boolean): Html =>
	h.a(
		[
			h.Key(JSON.stringify(view.keys)),
			h.Class(ROW_LINK_CLASS),
			h.Href(
				hrefOf(
					AppRoute.InfraAwsResource({
						kind: view.kind,
						name: view.name,
						search: resourceSearch(view),
					}),
				),
			),
		],
		[
			h.div(
				[h.Class(cn("flex items-start gap-2.5", NAME_COLUMN.width))],
				[
					h.span([h.Class(cn("mt-1.5 size-1.5 shrink-0 rounded-full", DOT[view.health]))]),
					h.div(
						[h.Class("flex min-w-0 flex-col gap-0.5")],
						[
							h.span(
								[
									h.Class(
										"truncate font-mono text-xs font-medium text-foreground transition-colors group-hover:text-primary",
									),
									h.Title(view.name),
								],
								[view.name],
							),
							h.span(
								[
									h.Class(
										cn(
											"truncate font-mono text-2xs",
											view.health === "crit"
												? "text-severity-error"
												: view.health === "warn"
													? "text-severity-warn"
													: "text-muted-foreground",
										),
									),
								],
								[
									view.reason === null
										? subline(view)
										: [subline(view), view.reason]
												.filter((part) => part !== "")
												.join(" · "),
								],
							),
						],
					),
				],
			),
			...columnsOf(view.kind, showTraced).map((column) =>
				h.div(
					[
						h.Class(
							cn(
								"flex",
								column.width,
								column.hidden,
								column.align === "right" && "justify-end",
							),
						),
					],
					[column.cell(h, view, context)],
				),
			),
		],
	)

export const awsTable = (
	h: H,
	options: Readonly<{
		kind: AwsInfraKindId
		nameLabel: string
		views: ReadonlyArray<ResourceView>
		/** Every row before the search filter: a search must not hide the column. */
		allViews: ReadonlyArray<ResourceView>
		context: TableContext
		isWaiting: boolean
	}>,
): Html => {
	const showTraced = anyTraced(options.allViews, options.context.traced)
	const table = dataTable(
		h,
		{ ariaLabel: `AWS ${options.nameLabel}`, isWaiting: options.isWaiting },
		heads(h, options.kind, options.nameLabel, showTraced),
		options.views.map((view) => row(h, view, options.context, showTraced)),
	)
	const hasTracedColumn = COLUMNS[options.kind].some((column: Column) => column.traced === true)
	return showTraced || !hasTracedColumn
		? table
		: h.div(
				[h.Class("flex flex-col")],
				[
					table,
					h.p(
						[h.Class("px-4 pt-2 font-prose text-xs text-muted-foreground")],
						[`None of these ${pluralize(2, AWS_INFRA_KINDS[options.kind].noun)} are traced yet.`],
					),
				],
			)
}
