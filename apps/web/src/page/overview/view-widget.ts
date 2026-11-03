import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { FixedMetricSeries } from "@maple/views/charts/fixed-metric-series"
import { card, cardHeader, cardPanel } from "@maple/views/ui/card"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { swatch } from "@maple/views/ui/swatch"
import { Array as Arr } from "effect"

// A read-only widget shell in view
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
					"ml-auto hidden min-w-0 flex-1 items-center justify-end gap-x-3 overflow-hidden font-sans @min-[380px]/widget:flex",
				),
			],
			[
				...Arr.map(visible, (item) =>
					h.span(
						[
							h.Key(item.key),
							h.Class("flex min-w-0 shrink items-center gap-1.5 text-xs text-foreground"),
						],
						[
							swatch(h, { color: item.color, dashed: item.dashed }),
							h.span([h.Class("truncate")], [item.label]),
						],
					),
				),
				...(overflow > 0
					? [
							typography(
								h,
								{
									size: "xs",
									tone: "muted",
									className: "shrink-0",
									attributes: [
										h.Title(
											Arr.join(
												Arr.map(items, (item) => item.label),
												", ",
											),
										),
									],
								},
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
	/** `titleHint`: the info icon after the title, a docs link when it has an `href`. */
	titleHint?: Readonly<{ text: string; href?: string }>
	/** `contentClassName`: replaces the panel's `flex-1 min-h-0 p-2` (an overlay opts out of the clip). */
	contentClassName?: string
}>

// No overview card sets `titleHint`, so its hover tooltip has nothing to show here; a page that
// sets one wires a Tooltip Model to the trigger.
const titleHint = <M>(
	h: HtmlBuilder<M>,
	title: string,
	hint: Readonly<{ text: string; href?: string }>,
): Html =>
	hint.href === undefined
		? h.span(
				[
					h.AriaLabel(`About ${title}`),
					h.Class("shrink-0 text-foreground-subtle"),
					h.DataAttribute("base-ui-tooltip-trigger", ""),
					h.DataAttribute("slot", "tooltip-trigger"),
				],
				[icon(h, "CircleInfoIcon", { size: 12 })],
			)
		: h.a(
				[
					h.AriaLabel(`About ${title}`),
					h.Class("shrink-0 text-foreground-subtle hover:text-foreground active:text-foreground"),
					h.DataAttribute("base-ui-tooltip-trigger", ""),
					h.DataAttribute("slot", "tooltip-trigger"),
					h.Href(hint.href),
					h.Attribute("rel", "noreferrer"),
					h.Attribute("target", "_blank"),
				],
				[icon(h, "CircleInfoIcon", { size: 12 })],
			)

export const widgetShell = <M>(h: HtmlBuilder<M>, options: WidgetShellOptions, content: Html): Html =>
	card(
		h,
		[
			cardHeader(
				h,
				[
					hstack(h, { gap: "2", shrink: true }, [
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
						...(options.titleHint === undefined
							? []
							: [titleHint(h, options.title, options.titleHint)]),
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
					]),
				],
				"py-2.5",
			),
			cardPanel(h, [content], cn("overflow-hidden", options.contentClassName ?? "flex-1 min-h-0 p-2")),
			...(options.footer === undefined
				? []
				: [h.div([h.Class("shrink-0 px-3 pb-2.5 text-2xs text-muted-foreground")], options.footer)]),
		],
		"group/card @container/widget h-full flex flex-col",
	)
