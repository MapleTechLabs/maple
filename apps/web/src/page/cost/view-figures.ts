import type { CostTotalsResponse } from "@maple/domain/http"
import { EMPTY_VALUE, pluralize } from "@maple/ui/lib/format"
import { Array as Arr, Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { delta } from "@maple/views/ui/delta"
import { errorState } from "@maple/views/ui/error-state"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { statRail, statRailItem, statRailLoading } from "../kit/stat-rail"
import { formatMoney, formatMoneyChange, type PreviousPeriod, previousPeriodOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

type H = HtmlBuilder<Message>

const daysText = (days: number): string => `${days} ${pluralize(days, "day")}`

/** What the totals cannot say in a figure: days still open to a restatement, and mixed currencies. */
const notes = (totals: CostTotalsResponse): ReadonlyArray<string> => [
	...(totals.estimatedDays > 0
		? [
				totals.estimatedDays === 1
					? "The last day is not final yet. The provider can still restate it."
					: `The last ${totals.estimatedDays} days are not final yet. The provider can still restate them.`,
			]
		: []),
	// The API reads one currency at a time: the others are named, never added in.
	...(totals.currencies.length > 1
		? [
				`Showing ${totals.currency}. This window also has cost in ${Arr.join(
					Arr.filter(totals.currencies, (currency) => currency !== totals.currency),
					", ",
				)}, which is not added in.`,
			]
		: []),
]

const figures = (h: H, totals: CostTotalsResponse, previous: PreviousPeriod): Html => {
	const previousSynced = previous === "synced"
	const currency = totals.currency
	const change = totals.cost - totals.previousCost
	const lines = notes(totals)
	return vstack(h, { gap: "2" }, [
		statRail(h, { columns: 3 }, [
			statRailItem(h, {
				eyebrow: "Cost",
				value: formatMoney(totals.cost, currency),
				subline: `Over ${daysText(totals.days)}`,
				compact: true,
			}),
			statRailItem(h, {
				eyebrow: "Change",
				// A period still being backfilled reads as cheaper than it was: no change is shown against it.
				value: previousSynced ? formatMoneyChange(change, currency) : EMPTY_VALUE,
				subline: !previousSynced
					? previous === "syncing"
						? `The ${daysText(totals.days)} before are still syncing`
						: `The ${daysText(totals.days)} before start earlier than the history read`
					: totals.previousCost > 0
						? hstack(h, { gap: "1.5", as: "span", inline: true }, [
								// Rising cost is not good news: the delta reads it as the worse direction.
								delta(h, {
									current: totals.cost,
									previous: totals.previousCost,
									invert: true,
								}),
								`against the ${daysText(totals.days)} before`,
							])
						: `No cost in the ${daysText(totals.days)} before`,
				compact: true,
			}),
			statRailItem(h, {
				eyebrow: "Average per day",
				value: formatMoney(totals.days > 0 ? totals.cost / totals.days : 0, currency),
				subline: "Per UTC day",
				compact: true,
			}),
		]),
		...(lines.length === 0
			? []
			: [
					vstack(
						h,
						{ gap: "0.5" },
						Arr.map(lines, (line) =>
							typography(h, { size: "xs", tone: "muted", as: "p" }, [line]),
						),
					),
				]),
	])
}

/** The row of figures: cost in the window, the change against the period before, the daily average. */
export const figuresRow = (h: H, model: Model): Html =>
	AsyncData.matchData(model.totals.data, {
		onEmpty: () => statRailLoading(h, 3, 3),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load cost totals",
				onRetry: Message.ClickedRetry(),
			}),
		onData: (totals) =>
			figures(
				h,
				totals,
				previousPeriodOf(
					Option.match(AsyncData.getData(model.sources.data), {
						onNone: () => [],
						onSome: (response) => response.sources,
					}),
					model.window,
					totals.days,
				),
			),
	})
