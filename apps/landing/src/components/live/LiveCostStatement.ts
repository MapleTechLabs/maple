import { formatPercent } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { delta } from "@maple/views/ui/delta"
import { icon } from "@maple/views/ui/icon"
import { segmentedBar } from "@maple/views/ui/meter"
import { hstack } from "@maple/views/ui/stack"
import { statFigure } from "@maple/views/ui/stat-figure"
import { swatch } from "@maple/views/ui/swatch"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { makeStaticIsland, type StaticMessage } from "../../foldkit-island/island"
import { type BreakdownRow, costView, CURRENCY, DAYS, formatMoney, WINDOW_TEXT } from "./live-cost-data"

// The cost feature page's hero: every provider's bill for the window as one statement. It reads
// what LiveCostExplorer reads, so the two agree to the cent.

type H = HtmlBuilder<StaticMessage>

const FALLBACK_COLOR = "var(--muted-foreground)"

const line = (h: H, entry: BreakdownRow, total: number): Html =>
	h.li(
		[h.Key(entry.key), h.Class("flex items-center gap-3 px-4 py-2.5")],
		[
			hstack(h, { gap: "2", shrink: true, grow: true }, [
				swatch(h, { color: entry.color ?? FALLBACK_COLOR }),
				icon(h, entry.mark.icon, { size: 14, className: cn("shrink-0", entry.mark.className) }),
				truncatedText(h, { text: entry.label, className: "text-sm", tooltip: "none" }),
			]),
			typography(
				h,
				{ size: "xs", tone: "muted", numeric: true, className: "w-12 shrink-0 text-right" },
				[formatPercent(entry.cost / total, { floor: 0.001 })],
			),
			typography(h, { size: "sm", numeric: true, className: "w-24 shrink-0 text-right" }, [
				formatMoney(entry.cost),
			]),
		],
	)

const view = (_props: Readonly<{}>, h: H): Html => {
	const data = costView("provider", [], "cost")
	return h.div(
		[h.Class("live-frame")],
		[
			h.div(
				[h.Class("live-frame__head")],
				[
					h.span([], [`statement · ${WINDOW_TEXT} · ${CURRENCY}`]),
					// Invented figures: said on the frame, like the explorer's.
					h.span(
						[h.Class("live-frame__live")],
						[h.span([h.Class("live-frame__live-dot")], []), "DEMO"],
					),
				],
			),
			h.div(
				[h.Class("bg-background font-sans text-foreground")],
				[
					h.div(
						[h.Class("px-4 pt-4 pb-5")],
						[
							statFigure(h, {
								label: `Total over ${DAYS} days`,
								value: formatMoney(data.cost),
								size: "lg",
								caption: hstack(h, { gap: "1.5", as: "span", inline: true }, [
									// Rising cost is not good news: the delta reads it as the worse direction.
									delta(h, {
										current: data.cost,
										previous: data.previousCost,
										invert: true,
									}),
									`against the ${DAYS} days before`,
								]),
							}),
							segmentedBar(h, {
								segments: Arr.map(data.rows, (entry) => ({
									key: entry.key,
									value: entry.cost,
									color: entry.color ?? FALLBACK_COLOR,
								})),
								label: `Cost by provider: ${Arr.join(
									Arr.map(
										data.rows,
										(entry) => `${entry.label} ${formatPercent(entry.cost / data.cost)}`,
									),
									", ",
								)}`,
								className: "mt-4 h-2 gap-px rounded-xs",
							}),
						],
					),
					h.ul(
						[h.Class("divide-y divide-border-subtle border-t border-border")],
						Arr.map(data.rows, (entry) => line(h, entry, data.cost)),
					),
				],
			),
		],
	)
}

export const LiveCostStatement = makeStaticIsland({
	name: "live-cost-statement",
	Props: Schema.Struct({}),
	view,
})
