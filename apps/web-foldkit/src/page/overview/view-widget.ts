import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { FixedMetricSeries } from "../../charts/fixed-metric-series"
import { card, cardHeader, cardPanel } from "../../ui/card"
import { eyebrow } from "../../ui/eyebrow"

// `ReadonlyWidgetShell` (apps/web/src/components/dashboard-builder/widgets/widget-shell.tsx) in view
// mode with no widget actions: title, hoisted legend chips, headline value, content and footer.

const MAX_HEADER_ITEMS = 5

/** The header's series chips: shown from two series up, five at most, then "+N". */
const headerLegend = <M>(h: HtmlBuilder<M>, items: ReadonlyArray<FixedMetricSeries>): ReadonlyArray<Html> => {
	if (items.length < 2) return []
	const visible = items.slice(0, MAX_HEADER_ITEMS)
	const overflow = items.length - visible.length
	return [
		h.div(
			[
				h.Class(
					"ml-auto hidden min-w-0 flex-1 items-center justify-end gap-x-3 overflow-hidden @min-[380px]/widget:flex",
				),
			],
			[
				...visible.map((item) =>
					h.span(
						[
							h.Key(item.key),
							h.Class(
								"flex min-w-0 shrink items-center gap-1.5 text-3xs text-muted-foreground",
							),
						],
						[
							h.span([
								h.Class(
									cn(
										"size-2 shrink-0 rounded-xs",
										item.dashed === true && "border border-dashed",
									),
								),
								h.Style(
									item.dashed === true
										? { "border-color": item.color }
										: { "background-color": item.color },
								),
							]),
							h.span([h.Class("truncate")], [item.label]),
						],
					),
				),
				...(overflow > 0
					? [
							h.span(
								[
									h.Class("shrink-0 text-3xs text-muted-foreground"),
									h.Title(items.map((item) => item.label).join(", ")),
								],
								[`+${overflow}`],
							),
						]
					: []),
			],
		),
	]
}

export type WidgetShellOptions = Readonly<{
	title: string
	legend: ReadonlyArray<FixedMetricSeries>
	headerValue?: Html
	footer?: ReadonlyArray<Html | string>
}>

export const widgetShell = <M>(h: HtmlBuilder<M>, options: WidgetShellOptions, content: Html): Html =>
	card(
		h,
		[
			cardHeader(
				h,
				[
					h.div(
						[h.Class("flex min-w-0 items-center gap-2")],
						[
							eyebrow(
								h,
								{
									variant: "label",
									as: "div",
									className: "min-w-0 truncate",
									attributes: [h.Title(options.title)],
								},
								[options.title],
							),
							...headerLegend(h, options.legend),
							...(options.headerValue === undefined
								? []
								: [
										h.div(
											[
												h.Class(
													"ml-auto shrink-0 font-mono font-semibold text-xs tabular-nums",
												),
											],
											[options.headerValue],
										),
									]),
						],
					),
				],
				"py-2.5",
			),
			cardPanel(h, [content], cn("overflow-hidden", "flex-1 min-h-0 p-2")),
			...(options.footer === undefined
				? []
				: [h.div([h.Class("shrink-0 px-3 pb-2.5 text-2xs text-muted-foreground")], options.footer)]),
		],
		"group/card @container/widget h-full flex flex-col",
	)
