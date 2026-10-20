import type { CodeReviewTotals } from "@maple/domain/http"
import { formatCount, formatSpan } from "../../../components/code-review/code-review-format"
import { countLabel, EMPTY_VALUE, formatPercent } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { delta, relativeChange } from "../../../ui/delta"
import { statRail, statRailItem } from "../../kit/stat-rail"

// `HeadlineStrip` and `SecondaryStats`.

/** Change against the previous window; nothing when there is no baseline to compare with. */
export const changeOf = <M>(
	h: HtmlBuilder<M>,
	current: number | null,
	previous: number | null,
	invert = false,
): Html | undefined => {
	const ratio = current === null || previous === null ? null : relativeChange(current, previous)
	return ratio === null ? undefined : delta(h, { ratio, invert })
}

export const headlineStrip = <M>(
	h: HtmlBuilder<M>,
	current: CodeReviewTotals,
	previous: CodeReviewTotals,
	windowLabel: string,
): Html => {
	const versus = `vs previous ${windowLabel}`
	return statRail(h, {}, [
		statRailItem(h, {
			compact: true,
			eyebrow: "Pull requests reviewed",
			value: formatCount(current.pullRequests),
			delta: changeOf(h, current.pullRequests, previous.pullRequests),
			subline: versus,
		}),
		statRailItem(h, {
			compact: true,
			eyebrow: "Total reviews",
			value: formatCount(current.reviews),
			delta: changeOf(h, current.reviews, previous.reviews),
			subline: versus,
		}),
		h.div(
			[h.Title("From a pull request's first review to its merge")],
			[
				statRailItem(h, {
					compact: true,
					eyebrow: "Avg time to merge",
					value: formatSpan(current.avgMergeSeconds),
					delta: changeOf(h, current.avgMergeSeconds, previous.avgMergeSeconds, true),
					subline: versus,
				}),
			],
		),
		statRailItem(h, {
			compact: true,
			eyebrow: "Issues caught",
			value: formatCount(current.findings),
			subline:
				current.repositoriesWithFindings > 0
					? `in ${countLabel(current.repositoriesWithFindings, "repo")}`
					: undefined,
		}),
	])
}

type Stat = Readonly<{ label: string; value: string; hint?: string }>

const secondaryStatList = (current: CodeReviewTotals): ReadonlyArray<Stat> => {
	const settled = current.resolvedFindings + current.dismissedFindings
	return [
		{
			label: "Avg confidence",
			value: current.avgConfidence === null ? EMPTY_VALUE : `${current.avgConfidence.toFixed(1)}/10`,
			hint: "How safe the reviewer judged each change to merge",
		},
		{
			label: "Avg quality",
			value: current.avgScore === null ? EMPTY_VALUE : `${Math.round(current.avgScore)}/100`,
			hint: "100 minus a fixed penalty per open finding",
		},
		{
			label: "Avg review time",
			value: formatSpan(current.avgReviewSeconds),
			hint: "From the push to the posted review",
		},
		{
			label: "Fixed rate",
			value:
				current.findings === 0
					? EMPTY_VALUE
					: formatPercent(current.resolvedFindings / current.findings),
			hint: "Issues a later push resolved",
		},
		{
			label: "Dismissed",
			value: settled === 0 ? EMPTY_VALUE : formatCount(current.dismissedFindings),
			hint: "Issues a person dismissed as not worth fixing",
		},
		{ label: "Critical issues", value: formatCount(current.criticalFindings) },
		{
			label: "Tokens",
			value: formatCount(current.inputTokens + current.outputTokens),
			hint: `${formatCount(current.inputTokens)} in, ${formatCount(current.outputTokens)} out`,
		},
	]
}

export const secondaryStats = <M>(h: HtmlBuilder<M>, current: CodeReviewTotals): Html =>
	statRail(
		h,
		{ columns: 4, className: "xl:grid-cols-7" },
		secondaryStatList(current).map((stat) =>
			h.div(
				[h.Key(stat.label), ...(stat.hint === undefined ? [] : [h.Title(stat.hint)])],
				[
					statRailItem(h, {
						compact: true,
						eyebrow: stat.label,
						value: stat.value,
						className: "px-4 py-3",
						valueClassName: "text-lg",
					}),
				],
			),
		),
	)
