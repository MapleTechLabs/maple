import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { flowIcon } from "./flow-icon"
import { serviceDot } from "./node-card"
import type { SpanCategory } from "./span-category"
import { hstack } from "../../ui/stack"
import { Array as Arr } from "effect"
import { typography } from "../../ui/typography"

// The hint, service and category legend under `TraceFlowView`.

const separator = <M>(h: HtmlBuilder<M>): Html => typography(h, { tone: "faint" }, ["·"])

// Hints are instructions, not legend entries: lighter weight and tone so they read as their own group.
const hint = <M>(h: HtmlBuilder<M>, text: string): Html => typography(h, { tone: "subtle" }, [text])

export const flowLegend = <M>(
	h: HtmlBuilder<M>,
	services: ReadonlyArray<string>,
	categories: ReadonlyArray<SpanCategory>,
): Html =>
	hstack(
		h,
		{
			align: "center",
			wrap: true,
			className:
				"gap-x-10 gap-y-2 border-t bg-surface-sunken px-3 py-2.5 text-2xs text-muted-foreground shrink-0",
		},
		[
			hstack(h, { gap: "3" }, [
				hint(h, "Click to select"),
				separator(h),
				hint(h, "Scroll to zoom"),
				separator(h),
				hint(h, "Drag to pan"),
			]),
			// Groups are split by the gap alone, so a wrapped line never starts with a separator.
			...(services.length > 0
				? [
						hstack(
							h,
							{ gap: "3" },
							Arr.map(services, (service) =>
								hstack(h, { gap: "1.5" }, [
									serviceDot(h, service, "size-2.5"),
									typography(h, { weight: "medium" }, [service]),
								]),
							),
						),
					]
				: []),
			// The error swatch closes the span-kind group, so it never strands at the far right.
			hstack(h, { wrap: true, className: "gap-x-3 gap-y-2" }, [
				...Arr.map(categories, (category) =>
					hstack(h, { gap: "1.5" }, [
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
							[flowIcon(h, category.icon, { size: 9 })],
						),
						typography(h, { weight: "medium" }, [category.label]),
					]),
				),
				hstack(h, { gap: "1.5" }, [
					h.span([
						h.Class(
							"size-3.5 rounded-sm bg-severity-error-a2 ring-1 ring-inset ring-severity-error-a4",
						),
					]),
					typography(h, { weight: "medium" }, ["Error"]),
				]),
			]),
		],
	)
