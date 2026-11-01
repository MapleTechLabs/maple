import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import * as Sparkline from "../../../charts/sparkline"

// The line spark the tool tables and panels draw per row.

/** Sparks draw no focus or tooltip, so they share one constant chart Model. */
const SPARK_CHART = Chart.init()

export type ToolSparkOptions<M> = Readonly<{
	chartId: string
	values: ReadonlyArray<number>
	/** Resolved for the canvas. */
	color: string
	toMessage: (message: Chart.Message) => M
	className: string
	fillOpacity: readonly [start: number, end: number]
	isFramedWhenEmpty?: boolean
}>

/** One row's spark: a `Sparkline` over the shared constant Model. */
export const toolSpark = <M>(h: HtmlBuilder<M>, options: ToolSparkOptions<M>): Html =>
	h.submodel({
		slotId: options.chartId,
		model: SPARK_CHART,
		view: Sparkline.view,
		toParentMessage: options.toMessage,
		viewInputs: {
			chartId: options.chartId,
			values: options.values,
			color: options.color,
			className: options.className,
			revision: 0,
			fillOpacity: options.fillOpacity,
			isFramedWhenEmpty: options.isFramedWhenEmpty === true,
		},
	})

/** The tools table's Volume cell: the last 24 buckets, framed even when the row is all zeros. */
export const volumeSparkCell = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		chartId: string
		values: ReadonlyArray<number>
		color: string
		toMessage: (message: Chart.Message) => M
	}>,
): Html =>
	h.span(
		[h.Class("hidden h-[22px] w-28 shrink-0 @min-[720px]/panel:block")],
		[
			toolSpark(h, {
				...options,
				values: options.values.slice(-24),
				className: "size-full",
				fillOpacity: [0.35, 0],
				isFramedWhenEmpty: true,
			}),
		],
	)
