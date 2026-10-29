import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import type { ChartTooltip } from "./chart-spec"

// `PlotTooltipBody` for a time-bucketed chart (fixed metrics, query-builder areas): the bucket
// heading, then one swatch, label and value per series; a dashed swatch for a partial series.

export type BucketTooltip = Extract<ChartTooltip, { readonly _tag: "Bucket" }>

/** `PlotTooltipBody`: the bucket heading, then one swatch, label and value per series. */
export const bucketTooltipBody = <Message, MountRequirements>(
	h: HtmlBuilder<Message, MountRequirements>,
	tooltip: BucketTooltip,
	portal: Attribute<Message, MountRequirements>,
): Html =>
	h.div(
		[h.Class("grid min-w-[9rem] max-w-[22rem] items-start gap-1.5"), portal],
		[
			h.div(
				[h.Class("border-border/50 border-b pb-1 font-medium text-muted-foreground tracking-tight")],
				[tooltip.heading],
			),
			h.div(
				[h.Class("grid gap-1.5")],
				tooltip.rows.map((row, index) =>
					h.div(
						[
							h.Key(`${index}:${row.label}`),
							h.Class(
								row.label === tooltip.highlighted
									? "flex w-full items-center gap-2 [&_*]:font-semibold"
									: "flex w-full items-center gap-2",
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
							h.div(
								[h.Class("flex flex-1 items-center justify-between gap-3 leading-none")],
								[
									h.span(
										[
											h.Class("min-w-0 truncate text-muted-foreground"),
											h.Title(row.label),
										],
										[row.label],
									),
									h.span(
										[
											h.Class(
												"shrink-0 font-mono font-semibold text-foreground tabular-nums",
											),
										],
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
						h.div(
							[
								h.Class(
									"flex items-center justify-between gap-3 border-border/50 border-t pt-1.5 leading-none",
								),
							],
							[
								h.span([h.Class("text-muted-foreground")], ["Total"]),
								h.span(
									[h.Class("font-mono font-semibold text-foreground tabular-nums")],
									[tooltip.total],
								),
							],
						),
					]),
		],
	)
