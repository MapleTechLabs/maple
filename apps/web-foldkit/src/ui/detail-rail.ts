import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "./eyebrow"

// Port of `DetailRail` (packages/ui/src/components/detail-rail.tsx): Group, Row and Field.
// TODO(icon): `Row`'s leading icon and `MetaRow` are not ported yet.

type Children = ReadonlyArray<Html | string>

/** `DetailRail.Group`: an eyebrow-titled section of the right rail. */
export const detailRailGroup = <M>(
	h: HtmlBuilder<M>,
	label: string,
	children: Children,
	className?: string,
): Html =>
	h.section(
		[
			h.DataAttribute("slot", "detail-rail-group"),
			h.Class(
				cn("flex flex-col gap-1.5 border-b border-border/40 px-4 py-3.5 last:border-b-0", className),
			),
		],
		[eyebrow(h, { as: "h3" }, [label]), h.div([h.Class("flex flex-col gap-1")], children)],
	)

export type DetailRailRowOptions = Readonly<{
	label: string
	hint?: string | undefined
	title?: string
	labelWidth?: string
	className?: string
}>

/** `DetailRail.Row`: label (and hint) on the left, the value right-aligned. */
export const detailRailRow = <M>(
	h: HtmlBuilder<M>,
	options: DetailRailRowOptions,
	children: Children,
): Html =>
	h.div(
		[
			h.DataAttribute("slot", "detail-rail-row"),
			...(options.title === undefined ? [] : [h.Title(options.title)]),
			h.Class(cn("grid min-h-8 items-center gap-x-3 py-0.5", options.className)),
			h.Style({ "grid-template-columns": `${options.labelWidth ?? "88px"} 1fr` }),
		],
		[
			h.span(
				[h.Class("flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground")],
				[
					h.span(
						[h.Class("flex min-w-0 flex-col")],
						[
							h.span([h.Class("truncate")], [options.label]),
							...(options.hint
								? [
										h.span(
											[h.Class("truncate text-3xs text-muted-foreground/70")],
											[options.hint],
										),
									]
								: []),
						],
					),
				],
			),
			h.div([h.Class("flex min-w-0 items-center justify-end")], children),
		],
	)

/** `DetailRail.Field`: label over value, for values too wide for a row. */
export const detailRailField = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ label: string; hint?: string | undefined; title?: string }>,
	children: Children,
): Html =>
	h.div(
		[
			h.DataAttribute("slot", "detail-rail-field"),
			...(options.title === undefined ? [] : [h.Title(options.title)]),
			h.Class("flex flex-col gap-1 py-1"),
		],
		[
			h.span(
				[h.Class("flex items-baseline gap-1.5 text-xs text-muted-foreground")],
				[
					h.span([], [options.label]),
					...(options.hint
						? [h.span([h.Class("text-3xs text-muted-foreground/70")], [options.hint])]
						: []),
				],
			),
			h.div([h.Class("min-w-0")], children),
		],
	)
