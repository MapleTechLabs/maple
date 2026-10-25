import { EMPTY_VALUE, formatNumber } from "@maple/ui/lib/format"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "../../data/load-failure"
import { delta } from "../../ui/delta"
import { skeleton } from "../../ui/skeleton"
import type { Model, UsageTotals } from "./model"
import { statRail, statRailItem, statRailLoading } from "../kit/stat-rail"

// The service usage cards.

/** Overview rails share the chart cards' corner radius. */
export const OVERVIEW_RAIL_CLASS = "rounded-2xl"

const CARDS: ReadonlyArray<{ title: string; key: keyof UsageTotals; format: (value: number) => string }> = [
	{ title: "Total Logs", key: "logs", format: formatNumber },
	{ title: "Total Traces", key: "traces", format: formatNumber },
	{ title: "Total Metrics", key: "metrics", format: formatNumber },
]

/** Loading tiles; on failure a quiet "Couldn't load" rail, or bare tiles when the page strip
 * (`isExplained`) already names that failure. */
export const usageCards = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	isExplained: (failure: LoadFailure) => boolean,
): Html =>
	AsyncData.matchData(model.usage.data, {
		onEmpty: () => statRailLoading(h, CARDS.length, 3, OVERVIEW_RAIL_CLASS),
		onFailure: (failure) =>
			statRail(
				h,
				{ columns: 3, className: OVERVIEW_RAIL_CLASS },
				CARDS.map((card) =>
					statRailItem(h, {
						eyebrow: card.title,
						value: EMPTY_VALUE,
						subline: isExplained(failure)
							? h.span([h.Class("sr-only")], ["Couldn't load"])
							: h.span([h.Class("font-prose")], ["Couldn't load"]),
						compact: true,
					}),
				),
			),
		onData: ({ totals, previous }) =>
			statRail(
				h,
				{ columns: 3, className: OVERVIEW_RAIL_CLASS },
				CARDS.map((card) =>
					statRailItem(h, {
						eyebrow: card.title,
						value: card.format(totals[card.key]),
						compact: true,
						delta:
							previous === null
								? skeleton(h, "h-3 w-16")
								: delta(h, {
										current: totals[card.key],
										previous: previous[card.key],
										suffix: "vs prev",
									}),
					}),
				),
			),
	})
