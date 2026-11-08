import type { GcpInfraServiceId } from "@maple/domain/gcp-infra"
import { rowHealth, type RowRules } from "../../../../components/infra/gcp/list-model"
import { gcpWorkloadId, gcpWorkloadSearch } from "../../../../components/infra/gcp/tabs"
import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "@maple/views/charts/chart"
import * as Sparkline from "@maple/views/charts/sparkline"
import { resolveColor, type ThemeColors } from "@maple/views/charts/theme-colors"
import { AppRoute, hrefOf } from "../../../../route"
import { ROW_LINK_CLASS } from "../../../infra/kit/data-table"
import { type MetaItem, metaLine } from "../../../infra/kit/meta-line"
import { gcpServiceIcon } from "../service-icon"
import { Message } from "./model"
import { type GcpBandSpec, healthDot } from "./view-band"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, hstackClass } from "@maple/views/ui/stack"
import { columnClass } from "@maple/views/ui/column"
import { spaced } from "@maple/views/ui/spaced"
import { Array as Arr, String as Str } from "effect"

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

export const NAME = columnClass({ min: "56" })
export const NUMBER = typographyClass({ size: "xs", mono: true, numeric: true, className: "text-right" })
export const SUB = typographyClass({ size: "3xs", tone: "muted", mono: true })

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
				[h.Class(cn(NAME, hstackClass({ gap: "3" })))],
				[
					gcpServiceIcon(h, { service: row.service, databaseVersion: row.engine }),
					spaced(h, { space: "0.5", fill: true }, [
						typography(
							h,
							{
								size: "xs",
								tone: "foreground",
								weight: "medium",
								mono: true,
								truncate: true,
								as: "div",
								className: "transition-colors group-hover:text-primary",
								attributes: [h.Title(row.name)],
							},
							[row.name],
						),
						...(line === null ? [] : [line]),
					]),
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
		: Arr.every(values, (value) => value === 0)
			? // All zeros is no traffic, not a flat line of data: a muted dash keeps the slot.
				hstack(h, { align: "center", shrink: true, grow: true, className: "h-5" }, [
					h.span([h.AriaHidden(true), h.Class("h-px w-3 bg-foreground-subtle")]),
				])
			: h.div(
					[h.Class("h-5 min-w-0 flex-1")],
					[
						h.submodel({
							slotId,
							model: CHART_MODEL,
							view: Sparkline.view,
							toParentMessage: (message: Chart.Message) =>
								Message.GotSparklineMessage({ message }),
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
const formatVolume = (value: number): string => Str.replace(/\.0(?=[KMBT]$)/, "")(formatNumber(value))

const VOLUME_CELL = "flex w-44 items-center gap-3"
const VOLUME_NUMBER_SLOT = "w-[56px] shrink-0"

/** The head over a `volumeCell` column: its label ends where the right-aligned counts end. */
export const volumeHead = (h: H, label: string, hidden?: string): Html =>
	h.div(
		[h.Class(cn(VOLUME_CELL, typographyClass({ size: "2xs", weight: "medium" }), hidden))],
		[
			h.span(
				[h.Class(cn(VOLUME_NUMBER_SLOT, "flex justify-end whitespace-nowrap text-muted-foreground"))],
				[label],
			),
		],
	)

export const volumeCell = (
	h: H,
	ctx: RowsContext,
	slotId: string,
	value: number,
	values: ReadonlyArray<number> | undefined,
	color = "--chart-2",
): Html =>
	h.div(
		[h.Class(VOLUME_CELL)],
		[
			h.span(
				[
					h.Class(
						cn(
							VOLUME_NUMBER_SLOT,
							"text-right font-mono text-xs tabular-nums text-foreground-soft",
						),
					),
				],
				[formatVolume(value)],
			),
			spark(h, ctx, slotId, values, color),
		],
	)

export const rowSlot = (prefix: string, keys: ReadonlyArray<string>) =>
	`${prefix}-${Str.replaceAll("\u0000", "~")(gcpWorkloadId(keys))}`
