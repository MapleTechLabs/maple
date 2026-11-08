import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import type { ChartTooltip } from "./chart-spec"
import { hstack, hstackClass } from "../ui/stack"
import { typography } from "../ui/typography"
import { Array as Arr } from "effect"

// `PlotTooltipBody` for a time-bucketed chart (fixed metrics, query-builder areas): the bucket
// heading, then one swatch, label and value per series; a dashed swatch for a partial series.

export type BucketTooltip = Extract<ChartTooltip, { readonly _tag: "Bucket" }>

/** `PlotTooltipBody`: the bucket heading, then one swatch, label and value per series. */
export const bucketTooltipBody = <Message>(
	h: HtmlBuilder<Message>,
	tooltip: BucketTooltip,
	portal: Attribute<Message>,
): Html =>
	h.div(
		[h.Class("grid min-w-[9rem] max-w-[22rem] items-start gap-1.5"), portal],
		[
			h.div(
				[
					h.Class(
						"border-border-subtle border-b pb-1 font-medium text-muted-foreground tracking-tight",
					),
				],
				[tooltip.heading],
			),
			h.div(
				[h.Class("grid gap-1.5")],
				Arr.map(tooltip.rows, (row, index) =>
					h.div(
						[
							h.Key(`${index}:${row.label}`),
							h.Class(
								row.label === tooltip.highlighted
									? "flex w-full items-center gap-2 [&_*]:font-semibold"
									: hstackClass({ gap: "2", className: "w-full" }),
							),
						],
						[
							h.span([
								h.Class(
									row.dashed
										? "size-2.5 shrink-0 rounded-xs border border-dashed"
										: "size-2.5 shrink-0 rounded-xs",
								),
								h.Style(
									row.dashed
										? { "border-color": row.color }
										: { "background-color": row.color },
								),
							]),
							hstack(
								h,
								{
									gap: "3",
									align: "center",
									justify: "between",
									grow: true,
									className: "leading-none",
								},
								[
									typography(
										h,
										{
											tone: "muted",
											truncate: true,
											className: "min-w-0",
											attributes: [h.Title(row.label)],
										},
										[row.label],
									),
									typography(
										h,
										{
											tone: "foreground",
											weight: "semibold",
											mono: true,
											numeric: true,
											className: "shrink-0",
										},
										[row.value],
									),
								],
							),
						],
					),
				),
			),
			...(tooltip.total === undefined
				? []
				: [
						hstack(
							h,
							{
								gap: "3",
								align: "center",
								justify: "between",
								className: "border-border-subtle border-t pt-1.5 leading-none",
							},
							[
								typography(h, { tone: "muted" }, ["Total"]),
								typography(
									h,
									{ tone: "foreground", weight: "semibold", mono: true, numeric: true },
									[tooltip.total],
								),
							],
						),
					]),
		],
	)
