import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { type CopyStatus, copyButton } from "./copy-button"
import { eyebrow } from "./eyebrow"
import { icon, type IconName } from "./icon"

// Port of `DetailRail` (packages/ui/src/components/detail-rail.tsx): Group, Row and Field.
// TODO(tooltip): `MetaRow` has no value tooltip.

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
	/** A glyph before the label; give every row in a rail one or none. */
	icon?: IconName
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
					...(options.icon === undefined
						? []
						: [
								icon(h, options.icon, {
									className: "size-3.5 shrink-0 text-muted-foreground/70",
									attributes: [h.AriaHidden(true)],
								}),
							]),
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

const tooltipTrigger = <M>(h: HtmlBuilder<M>, tooltip: string | undefined, value: Html): Html =>
	tooltip === undefined || tooltip === ""
		? value
		: h.span(
				[
					h.Class("cursor-default"),
					h.DataAttribute("base-ui-tooltip-trigger", ""),
					h.DataAttribute("slot", "tooltip-trigger"),
				],
				[value],
			)

/** `DetailRail.MetaRow`: the mono, divider-separated row of infra rails; nothing for an absent value. */
export const detailRailMetaRow = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		label: string
		value: string | null | undefined
		valueClassName?: string
		/** A glyph before the label; give every row in a rail one or none. */
		icon?: IconName
		/** `copyable`: the hover-revealed copy button, its status and click owned by the page. */
		copy?: Readonly<{ status: CopyStatus; onClick: M }>
		/** `tooltip`: the value is a tooltip trigger (the page Tooltip draws the text). */
		tooltip?: string
	}>,
): Html | null =>
	options.value === null || options.value === undefined || options.value === ""
		? null
		: h.div(
				[
					h.DataAttribute("slot", "detail-rail-meta-row"),
					h.Class(
						"group flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5 last:border-0",
					),
				],
				[
					h.span(
						[
							h.Class(
								"flex shrink-0 items-center gap-1.5 font-mono text-2xs text-muted-foreground",
							),
						],
						[
							...(options.icon === undefined
								? []
								: [
										icon(h, options.icon, {
											className:
												"size-3.5 shrink-0 self-center text-muted-foreground/70",
										}),
									]),
							options.label,
						],
					),
					h.div(
						[h.Class("flex min-w-0 items-center gap-1.5 text-2xs")],
						[
							tooltipTrigger(
								h,
								options.tooltip,
								h.span(
									[
										h.Class(
											cn(
												"break-all text-right font-mono text-2xs tabular-nums text-foreground/85",
												options.valueClassName,
											),
										),
									],
									[options.value],
								),
							),
							...(options.copy === undefined
								? []
								: [
										copyButton(h, {
											status: options.copy.status,
											label: options.label,
											iconSize: 11,
											onClick: options.copy.onClick,
											className:
												"size-5 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100",
										}),
									]),
						],
					),
				],
			)
