import { formatNumber } from "@maple/ui/lib/format"
import type { CodeReviewAnalytics, CodeReviewTotals, VcsRepositoryId } from "@maple/domain/http"
import { CATEGORY_LABELS } from "../kit/code-review-format"
import { TONE_FILL } from "@maple/ui/lib/tone"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "@maple/views/ui/empty"
import { icon } from "@maple/views/ui/icon"
import { meter } from "@maple/views/ui/meter"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { analyticsPanel } from "../kit/analytics-panel"
import { authorLink, type LinkScope, repositoryLink } from "../kit/links"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// `RepositoryList`, `BarList`, `CategoriesCard`, `OutcomesCard`, `AuthorsCard`.

type Row = Readonly<{ key: VcsRepositoryId; name: string; value: number }>

/** Each repository links to its pull requests, in the page's window and author. */
export const repositoryList = <M>(
	h: HtmlBuilder<M>,
	title: string,
	rows: ReadonlyArray<Row>,
	scope: LinkScope,
): Html =>
	vstack(h, { gap: "2" }, [
		typography(h, { size: "xs", tone: "muted" }, [title]),
		rows.length === 0
			? h.span([h.Class("py-1 text-sm text-foreground-subtle")], ["No repositories in this window"])
			: vstack(
					h,
					{ as: "ul" },
					Arr.map(rows, (row) =>
						hstack(
							h,
							{
								gap: "2.5",
								align: "center",
								as: "li",
								className: "py-1.5 text-sm",
								attributes: [h.Key(row.key)],
							},
							[
								icon(h, "GithubIcon", {
									size: 16,
									className: "shrink-0 text-muted-foreground",
								}),
								repositoryLink(
									h,
									row.key,
									typography(h, { truncate: true, attributes: [h.Title(row.name)] }, [
										row.name,
									]),
									{ scope, className: "flex-1" },
								),
								typography(h, { tone: "muted", numeric: true }, [formatNumber(row.value)]),
							],
						),
					),
				),
	])

type Bar = Readonly<{ key: string; label: string; value: number; tone?: string }>

const barList = <M>(h: HtmlBuilder<M>, rows: ReadonlyArray<Bar>, emptyLabel: string): Html => {
	const max = Math.max(...Arr.map(rows, (row) => row.value), 1)
	if (rows.length === 0) return emptyMessage(h, {}, [emptyLabel])
	return vstack(
		h,
		{ gap: "2.5", as: "ul" },
		Arr.map(rows, (row) =>
			vstack(h, { gap: "1", as: "li", attributes: [h.Key(row.key)] }, [
				hstack(
					h,
					{ gap: "2", align: "center", justify: "between", as: "span", className: "text-sm" },
					[
						typography(h, { truncate: true }, [row.label]),
						typography(h, { tone: "muted", numeric: true }, [formatNumber(row.value)]),
					],
				),
				meter(h, {
					value: row.value,
					max,
					className: "h-1.5 bg-muted",
					fillClassName: row.tone ?? "bg-primary",
				}),
			]),
		),
	)
}

export const categoriesCard = <M>(h: HtmlBuilder<M>, analytics: CodeReviewAnalytics): Html =>
	analyticsPanel(h, { title: "Issues by category" }, [
		barList(
			h,
			Arr.map(analytics.categories, (row) => ({
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
			Arr.filter(rows, (row) => row.value > 0),
			"No reviews in this window",
		),
	])
}

export const authorsCard = <M>(h: HtmlBuilder<M>, analytics: CodeReviewAnalytics, scope: LinkScope): Html =>
	analyticsPanel(h, { title: "Top authors" }, [
		analytics.authors.length === 0
			? emptyMessage(h, {}, ["No authors in this window"])
			: table(h, { size: "sm", variant: "bare" }, [
					tableHeader(h, [
						tableRow(h, [
							tableHead(h, ["Author"], "pl-0"),
							tableHead(h, ["PRs"], "text-right"),
							tableHead(h, ["Issues"], "pr-0 text-right"),
						]),
					]),
					tableBody(
						h,
						Arr.map(analytics.authors, (row) =>
							tableRow(
								h,
								[
									tableCell(
										h,
										[authorLink(h, row.author, { scope, className: "max-w-full" })],
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
