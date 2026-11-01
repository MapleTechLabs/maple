import { formatNumber } from "@maple/ui/lib/format"
import type { CodeReviewAnalytics, CodeReviewTotals } from "@maple/domain/http"
import { CATEGORY_LABELS } from "../../../components/code-review/code-review-format"
import { TONE_FILL } from "@maple/ui/lib/tone"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { meter } from "../../../ui/meter"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { analyticsPanel } from "../kit/analytics-panel"
import { authorLabel } from "../kit/author"

// `RepositoryList`, `BarList`, `CategoriesCard`, `OutcomesCard`, `AuthorsCard`.

type Row = Readonly<{ key: string; name: string; value: number }>

export const repositoryList = <M>(h: HtmlBuilder<M>, title: string, rows: ReadonlyArray<Row>): Html =>
	h.div(
		[h.Class("flex flex-col gap-2")],
		[
			h.span([h.Class("text-xs text-muted-foreground")], [title]),
			rows.length === 0
				? h.span(
						[h.Class("py-1 text-sm text-foreground-subtle")],
						["No repositories in this window"],
					)
				: h.ul(
						[h.Class("flex flex-col")],
						rows.map((row) =>
							h.li(
								[h.Key(row.key), h.Class("flex items-center gap-2.5 py-1.5 text-sm")],
								[
									icon(h, "GithubIcon", {
										size: 16,
										className: "shrink-0 text-muted-foreground",
									}),
									h.span([h.Class("min-w-0 flex-1 truncate")], [row.name]),
									h.span(
										[h.Class("tabular-nums text-muted-foreground")],
										[formatNumber(row.value)],
									),
								],
							),
						),
					),
		],
	)

type Bar = Readonly<{ key: string; label: string; value: number; tone?: string }>

const barList = <M>(h: HtmlBuilder<M>, rows: ReadonlyArray<Bar>, emptyLabel: string): Html => {
	const max = Math.max(...rows.map((row) => row.value), 1)
	if (rows.length === 0) return emptyMessage(h, {}, [emptyLabel])
	return h.ul(
		[h.Class("flex flex-col gap-2.5")],
		rows.map((row) =>
			h.li(
				[h.Key(row.key), h.Class("flex flex-col gap-1")],
				[
					h.span(
						[h.Class("flex items-center justify-between gap-2 text-sm")],
						[
							h.span([h.Class("truncate")], [row.label]),
							h.span([h.Class("tabular-nums text-muted-foreground")], [formatNumber(row.value)]),
						],
					),
					meter(h, {
						value: row.value,
						max,
						className: "h-1.5 bg-muted",
						fillClassName: row.tone ?? "bg-primary",
					}),
				],
			),
		),
	)
}

export const categoriesCard = <M>(h: HtmlBuilder<M>, analytics: CodeReviewAnalytics): Html =>
	analyticsPanel(h, { title: "Issues by category" }, [
		barList(
			h,
			analytics.categories.map((row) => ({
				key: row.category,
				label: CATEGORY_LABELS[row.category],
				value: row.findings,
			})),
			"No issues in this window",
		),
	])

export const outcomesCard = <M>(
	h: HtmlBuilder<M>,
	current: CodeReviewTotals,
	analytics: CodeReviewAnalytics,
): Html => {
	const rows: ReadonlyArray<Bar> = [
		{ key: "issues", label: "Issues found", value: analytics.verdicts.issues, tone: TONE_FILL.warn },
		{ key: "clean", label: "Clean", value: analytics.verdicts.clean, tone: TONE_FILL.ok },
		{
			key: "not_applicable",
			label: "Nothing to review",
			value: analytics.verdicts.notApplicable,
			tone: TONE_FILL.neutral,
		},
		{ key: "failed", label: "Failed", value: current.failedReviews, tone: TONE_FILL.crit },
		{ key: "skipped", label: "Skipped", value: current.skippedReviews, tone: "bg-foreground-faint" },
	]
	return analyticsPanel(h, { title: "Review outcomes" }, [
		barList(
			h,
			rows.filter((row) => row.value > 0),
			"No reviews in this window",
		),
	])
}

export const authorsCard = <M>(h: HtmlBuilder<M>, analytics: CodeReviewAnalytics): Html =>
	analyticsPanel(h, { title: "Top authors" }, [
		analytics.authors.length === 0
			? emptyMessage(h, {}, ["No authors in this window"])
			: table(h, { size: "sm", variant: "bare" }, [
					tableHeader(h, [
						tableRow(h, [
							tableHead(h, ["Author"], "pl-0 font-normal"),
							tableHead(h, ["PRs"], "text-right font-normal"),
							tableHead(h, ["Issues"], "pr-0 text-right font-normal"),
						]),
					]),
					tableBody(
						h,
						analytics.authors.map((row) =>
							tableRow(
								h,
								[
									tableCell(
										h,
										[authorLabel(h, row.author, "max-w-full")],
										"max-w-0 pl-0 text-sm",
									),
									tableCell(
										h,
										[formatNumber(row.pullRequests)],
										"text-right text-sm tabular-nums",
									),
									tableCell(
										h,
										[formatNumber(row.findings)],
										"pr-0 text-right text-sm tabular-nums text-muted-foreground",
									),
								],
								undefined,
								[h.Key(row.author)],
							),
						),
					),
				]),
	])
