import { EMPTY_VALUE, formatNumber } from "@maple/ui/lib/format"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { delta } from "../../ui/delta"
import { skeleton } from "../../ui/skeleton"
import type { Model, UsageTotals } from "./model"
import { statRail, statRailItem, statRailLoading } from "../kit/stat-rail"

// The service usage cards.

const CARDS: ReadonlyArray<{ title: string; key: keyof UsageTotals; format: (value: number) => string }> = [
	{ title: "Total Logs", key: "logs", format: formatNumber },
	{ title: "Total Traces", key: "traces", format: formatNumber },
	{ title: "Total Metrics", key: "metrics", format: formatNumber },
]

/** Loading tiles; on failure a quiet "Couldn't load" rail (the charts carry the full message). */
export const usageCards = <M>(h: HtmlBuilder<M>, model: Model, hasPageFailure: boolean): Html =>
	AsyncData.matchData(model.usage.data, {
		onEmpty: () => statRailLoading(h, CARDS.length, 3),
		onFailure: () =>
			statRail(
				h,
				{ columns: 3 },
				CARDS.map((card) =>
					statRailItem(h, {
						eyebrow: card.title,
						value: EMPTY_VALUE,
						// Under the page strip the tile shows only its empty value; the strip says why.
						subline: hasPageFailure ? undefined : h.span([h.Class("font-prose")], ["Couldn't load"]),
						compact: true,
					}),
				),
			),
		onData: ({ totals, previous }) =>
			statRail(
				h,
				{ columns: 3 },
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
