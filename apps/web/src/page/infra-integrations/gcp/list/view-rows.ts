import type { GcpInfraServiceId } from "@maple/domain/gcp-infra"
import { rowHealth, type RowRules } from "../../../../components/infra/gcp/list-model"
import { gcpWorkloadId, gcpWorkloadSearch } from "../../../../components/infra/gcp/tabs"
import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../../charts/chart"
import * as Sparkline from "../../../../charts/sparkline"
import { resolveColor, type ThemeColors } from "../../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../../route"
import { ROW_LINK_CLASS } from "../../../infra/kit/data-table"
import { type MetaItem, metaLine } from "../../../infra/kit/meta-line"
import { gcpServiceIcon } from "../service-icon"
import { Message } from "./model"
import { type GcpBandSpec, healthDot } from "./view-band"

// The shared parts of the Google Cloud list rows.

export type H = HtmlBuilder<Message>

export type TimeSearch = Readonly<{ startTime?: string; endTime?: string; timePreset?: string }>

export type RowsContext = Readonly<{
	timeSearch: TimeSearch
	showProject: boolean
	/** Sparklines draw once the theme and the chart runtime are in. */
	theme: ThemeColors | null
	isChartReady: boolean
	/** The browser's locale, read with the window. */
	locale: string
}>

export const NAME = "w-0 min-w-[220px] flex-1"
export const NUMBER = "text-right font-mono text-xs tabular-nums"
export const SUB = "font-mono text-3xs text-muted-foreground"

/** The workload's page: the name, its identity params and the list's own time params. */
export const workloadHref = (
	service: GcpInfraServiceId,
	keys: ReadonlyArray<string>,
	timeSearch: TimeSearch,
) =>
	hrefOf(
		AppRoute.InfraGcpResource({
			service,
			name: keys[0] ?? "",
			search: { ...timeSearch, ...gcpWorkloadSearch(service, keys) },
		}),
	)

type RowBase = Readonly<{
	service: GcpInfraServiceId
	keys: ReadonlyArray<string>
	name: string
	engine?: string | undefined
}>

/** `WorkloadRow`: the health dot, the service glyph, the name with its sub-line, then the cells. */
export const workloadRow = <R extends RowBase, S extends string>(
	h: H,
	options: Readonly<{
		row: R
		rules: RowRules<R, S>
		spec: GcpBandSpec<S>
		meta: ReadonlyArray<MetaItem>
		timeSearch: TimeSearch
	}>,
	cells: ReadonlyArray<Html>,
): Html => {
	const { row } = options
	const line = metaLine(h, options.meta)
	return h.a(
		[h.Class(ROW_LINK_CLASS), h.Href(workloadHref(row.service, row.keys, options.timeSearch))],
		[
			healthDot(h, options.spec, rowHealth(options.rules, row)),
			h.div(
				[h.Class(cn(NAME, "flex items-center gap-3"))],
				[
					gcpServiceIcon(h, { service: row.service, databaseVersion: row.engine }),
					h.div(
						[h.Class("min-w-0 flex-1 space-y-0.5")],
						[
							h.div(
								[
									h.Class(
										"truncate font-mono text-xs font-medium text-foreground transition-colors group-hover:text-primary",
									),
									h.Title(row.name),
								],
								[row.name],
							),
							...(line === null ? [] : [line]),
						],
					),
				],
			),
			...cells,
		],
	)
}

const CHART_MODEL = Chart.init()

/** `Spark`: a monotone `PlotSparkline`, or the reserved box under two values. */
export const spark = (
	h: H,
	ctx: RowsContext,
	slotId: string,
	values: ReadonlyArray<number> | undefined,
	color: string,
): Html =>
	values === undefined || values.length < 2 || ctx.theme === null || !ctx.isChartReady
		? h.div([h.Class("h-5 min-w-0 flex-1")])
		: h.div(
				[h.Class("h-5 min-w-0 flex-1")],
				[
					h.submodel({
						slotId,
						model: CHART_MODEL,
						view: Sparkline.view,
						toParentMessage: (message: Chart.Message) => Message.GotSparklineMessage({ message }),
						viewInputs: {
							chartId: slotId,
							values,
							color: resolveColor(ctx.theme, color),
							className: "h-full w-full",
							revision: 0,
							curve: "monotone",
							fillOpacity: [0.35, 0],
						},
					}),
				],
			)

/** `VolumeCell`: a count and its sparkline. */
/** "880K" over "880.0K": a trailing ".0" carries nothing, so the column drops it. */
const formatVolume = (value: number): string => formatNumber(value).replace(/\.0(?=[KMBT]$)/, "")

export const volumeCell = (
	h: H,
	ctx: RowsContext,
	slotId: string,
	value: number,
	values: ReadonlyArray<number> | undefined,
	color = "--chart-2",
): Html =>
	h.div(
		[h.Class("flex w-[180px] items-center gap-3")],
		[
			h.span(
				[h.Class("w-[56px] shrink-0 text-right font-mono text-xs tabular-nums text-foreground/80")],
				[formatVolume(value)],
			),
			spark(h, ctx, slotId, values, color),
		],
	)

export const rowSlot = (prefix: string, keys: ReadonlyArray<string>) =>
	`${prefix}-${gcpWorkloadId(keys).replaceAll("\u0000", "~")}`
