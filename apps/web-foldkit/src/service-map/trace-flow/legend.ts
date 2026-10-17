import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../ui/icon"
import { serviceDot } from "./node-card"
import type { SpanCategory } from "./span-category"

// The hint, service and category legend under `TraceFlowView`.

const separator = <M>(h: HtmlBuilder<M>): Html => h.span([h.Class("text-foreground/30")], ["|"])

const hint = <M>(h: HtmlBuilder<M>, text: string): Html => h.span([h.Class("font-medium")], [text])

export const flowLegend = <M>(
	h: HtmlBuilder<M>,
	services: ReadonlyArray<string>,
	categories: ReadonlyArray<SpanCategory>,
): Html =>
	h.div(
		[
			h.Class(
				"flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-muted/30 px-3 py-2.5 text-2xs text-muted-foreground shrink-0",
			),
		],
		[
			hint(h, "Click to select"),
			separator(h),
			hint(h, "Scroll to zoom"),
			separator(h),
			hint(h, "Drag to pan"),
			separator(h),
			h.div(
				[h.Class("flex items-center gap-3")],
				services.map((service) =>
					h.div(
						[h.Class("flex items-center gap-1.5")],
						[serviceDot(h, service, "size-2.5"), h.span([h.Class("font-medium")], [service])],
					),
				),
			),
			...(categories.length > 0
				? [
						separator(h),
						h.div(
							[h.Class("flex items-center gap-3")],
							categories.map((category) =>
								h.div(
									[h.Class("flex items-center gap-1.5")],
									[
										h.span(
											[
												h.Class(
													cn(
														"flex size-3.5 items-center justify-center rounded-sm",
														category.accent.soft,
														category.accent.text,
													),
												),
											],
											[icon(h, category.icon, { size: 9 })],
										),
										h.span([h.Class("font-medium")], [category.label]),
									],
								),
							),
						),
					]
				: []),
			h.span([h.Class("flex-1")]),
			h.div(
				[h.Class("flex items-center gap-1.5")],
				[
					h.span([
						h.Class(
							"size-3.5 rounded-sm bg-severity-error/15 ring-1 ring-inset ring-severity-error/40",
						),
					]),
					h.span([h.Class("font-medium")], ["Error"]),
				],
			),
		],
	)
