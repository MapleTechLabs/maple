import type { CodeReviewTotals } from "@maple/domain/http"
import { formatSpan } from "../../../components/code-review/code-review-format"
import { countLabel, EMPTY_VALUE, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { formatExactCount } from "../../kit/locale"
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

/** The headline tiles' labels, in order; the loading skeleton shows them too. */
export const HEADLINE_LABELS = {
	reviewed: "Pull requests reviewed",
	reviews: "Total reviews",
	mergeTime: "Avg time to merge",
	issues: "Issues caught",
} as const

/** The secondary tiles' labels, in order; the loading skeleton shows them too. */
export const SECONDARY_LABELS = {
	confidence: "Avg confidence",
	quality: "Avg quality",
	reviewTime: "Avg review time",
	fixRate: "Fixed rate",
	dismissed: "Dismissed",
	critical: "Critical issues",
	tokens: "Tokens",
} as const

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
			eyebrow: HEADLINE_LABELS.reviewed,
			value: formatNumber(current.pullRequests),
			delta: changeOf(h, current.pullRequests, previous.pullRequests),
			subline: versus,
		}),
		statRailItem(h, {
			compact: true,
			eyebrow: HEADLINE_LABELS.reviews,
			value: formatNumber(current.reviews),
			delta: changeOf(h, current.reviews, previous.reviews),
			subline: versus,
		}),
		h.div(
			[h.Title("From a pull request's first review to its merge")],
			[
				statRailItem(h, {
					compact: true,
					eyebrow: HEADLINE_LABELS.mergeTime,
					value: formatSpan(current.avgMergeSeconds),
					delta: changeOf(h, current.avgMergeSeconds, previous.avgMergeSeconds, true),
					subline: versus,
				}),
			],
		),
		statRailItem(h, {
			compact: true,
			eyebrow: HEADLINE_LABELS.issues,
			value: formatNumber(current.findings),
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
			label: SECONDARY_LABELS.confidence,
			value: current.avgConfidence === null ? EMPTY_VALUE : `${current.avgConfidence.toFixed(1)}/10`,
			hint: "How safe the reviewer judged each change to merge",
		},
		{
			label: SECONDARY_LABELS.quality,
			value: current.avgScore === null ? EMPTY_VALUE : `${Math.round(current.avgScore)}/100`,
			hint: "100 minus a fixed penalty per open finding",
		},
		{
			label: SECONDARY_LABELS.reviewTime,
			value: formatSpan(current.avgReviewSeconds),
			hint: "From the push to the posted review",
		},
		{
			label: SECONDARY_LABELS.fixRate,
			value:
				current.findings === 0
					? EMPTY_VALUE
					: formatPercent(current.resolvedFindings / current.findings),
			hint: "Issues a later push resolved",
		},
		{
			label: SECONDARY_LABELS.dismissed,
			value: settled === 0 ? EMPTY_VALUE : formatNumber(current.dismissedFindings),
			hint: "Issues a person dismissed as not worth fixing",
		},
		{ label: SECONDARY_LABELS.critical, value: formatNumber(current.criticalFindings) },
		{
			label: SECONDARY_LABELS.tokens,
			value: formatNumber(current.inputTokens + current.outputTokens),
			hint: `${formatExactCount(current.inputTokens)} in, ${formatExactCount(current.outputTokens)} out`,
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
