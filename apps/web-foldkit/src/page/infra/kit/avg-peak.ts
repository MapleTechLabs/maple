import type { Html, HtmlBuilder } from "foldkit/html"

// `AvgPeak` (primitives/avg-peak.tsx): avg → peak in one cell.
// TODO(tooltip): the trigger renders; the average/peak breakdown popup on hover is not wired yet.

export const avgPeak = <M>(h: HtmlBuilder<M>, avg: number, peak: number, format: (n: number) => string): Html =>
	h.span(
		[
			h.Class("cursor-default font-mono text-2xs tabular-nums text-foreground"),
			h.DataAttribute("base-ui-tooltip-trigger", ""),
			h.DataAttribute("slot", "tooltip-trigger"),
		],
		[
			h.span([h.Class("text-muted-foreground")], [format(avg)]),
			h.span([h.Class("mx-1 text-foreground/30")], ["→"]),
			format(peak),
		],
	)
