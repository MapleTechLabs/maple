import { AI_CREDITS_FEATURE_ID, AI_CREDITS_MARKUP_PERCENT } from "@maple/domain/billing"
import type {
	AiCreditSourceUsage,
	AiCreditUsageResponse,
	CodeReviewSpend,
	CodeReviewSpendPullRequest,
} from "@maple/domain/http"
import { Array as Arr, Number as Num, Option, String as Str } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import { grid } from "@maple/views/ui/grid"
import { segmentedBar } from "@maple/views/ui/meter"
import { swatch } from "@maple/views/ui/swatch"
import { panel } from "@maple/views/ui/panel"
import { hstack, vstack } from "@maple/views/ui/stack"
import {
	numericTableCell,
	table,
	tableBody,
	tableCell,
	tableHead,
	tableHeader,
	tableRow,
	truncatedTableCell,
} from "@maple/views/ui/table"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { sectionHeading } from "../../kit/section-heading"
import { settingsSection } from "../../kit/settings-section"
import { statRail, statRailItem, statRailLoading } from "../../kit/stat-rail"
import type { Message, Model } from "./model"
import { formatCredits, type SpendModel } from "./spend"
import { AI_SOURCE_LABELS } from "./view-usage"

type H = HtmlBuilder<Message>

export const AI_CREDITS_SECTION_ID = "settings-billing-ai-credits"

/** A chart colour per surface, the same wherever a surface's credits are drawn. */
const SOURCE_COLORS = {
	review: "var(--chart-1)",
	security_audit: "var(--chart-2)",
	chat: "var(--chart-3)",
	triage: "var(--chart-4)",
	bot: "var(--chart-5)",
	other: "var(--muted-foreground)",
} satisfies Record<AiCreditSourceUsage["source"], string>

/** A pull request reviewed this often in one cycle gets a "Reviewed N×" chip. */
const REPEATED_REVIEWS = 4

/** `openrouter/deepseek/deepseek-v4.1-flash` reads as `deepseek/deepseek-v4.1-flash`. */
export const modelLabel = (model: string): string =>
	Option.match(Str.indexOf("/")(model), {
		onNone: () => model,
		onSome: (slash) => Str.slice(slash + 1)(model),
	})

const shareBar = (h: H, value: number, total: number, color: string): Html =>
	segmentedBar(h, {
		className: "h-1 w-full rounded-none bg-muted",
		total,
		segments: [{ key: "share", value, color }],
	})

const figure = (h: H, value: string): Html => typography(h, { mono: true, numeric: true }, [value])

/** Where this cycle's AI credits went: totals, each surface and model, and code review in detail. */
export const aiCreditsSection = (h: H, model: Model, spend: SpendModel | null): ReadonlyArray<Html> => {
	if (AsyncData.isLoading(model.aiUsage)) return [section(h, [statRailLoading(h, 4, 4)])]
	const usage = AsyncData.getOrElse(model.aiUsage, () => null)
	// A failed read already says so (with a retry) on the AI credits usage row.
	if (usage === null) return []
	const total = Num.sumAll(Arr.map(usage.bySource, (entry) => entry.credits))
	if (total <= 0 && usage.codeReview === null) return []
	const feature =
		spend === null
			? null
			: Option.getOrNull(
					Arr.findFirst(spend.features, (entry) => entry.featureId === AI_CREDITS_FEATURE_ID),
				)
	return [
		section(h, [
			totalsRail(h, usage, total, feature),
			grid(h, { lg: 2, gap: "4" }, [sourcesTable(h, usage, total), modelsTable(h, usage, total)]),
			...(usage.codeReview === null ? [] : codeReviewDetail(h, usage.codeReview)),
		]),
	]
}

const section = (h: H, children: ReadonlyArray<Html>): Html =>
	settingsSection(
		h,
		{
			id: AI_CREDITS_SECTION_ID,
			title: "AI credits",
			description: [
				`Where this cycle's AI credits went. Each model call is priced at what the model provider charged, plus ${AI_CREDITS_MARKUP_PERCENT}%; one credit is one dollar.`,
			],
			framed: false,
		},
		[vstack(h, { gap: "6" }, children)],
	)

const totalsRail = (
	h: H,
	usage: AiCreditUsageResponse,
	total: number,
	feature: { readonly included: number | null; readonly overageUnits: number } | null,
): Html => {
	const review = usage.codeReview
	const included = feature?.included ?? null
	const spentTile = statRailItem(h, {
		eyebrow: "Spent this cycle",
		value: formatCredits(total),
		subline:
			included === null || feature === null
				? "This billing cycle"
				: feature.overageUnits > 0
					? `${formatCredits(feature.overageUnits)} overage`
					: `of ${formatCredits(included)} included`,
	})
	if (review === null) {
		const top = usage.bySource[0]
		return statRail(h, { columns: 2 }, [
			spentTile,
			statRailItem(h, {
				eyebrow: "Most spent on",
				value: top === undefined ? "Nothing yet" : AI_SOURCE_LABELS[top.source],
				subline: top === undefined ? "No AI features ran" : formatCredits(top.credits),
			}),
		])
	}
	const priced = review.reviews - review.unpricedReviews
	return statRail(h, { columns: 4 }, [
		spentTile,
		statRailItem(h, {
			eyebrow: "Code reviews",
			value: review.reviews.toLocaleString("en-US"),
			subline: `${review.pullRequests.toLocaleString("en-US")} pull request${review.pullRequests === 1 ? "" : "s"}`,
		}),
		statRailItem(h, {
			eyebrow: "Per review",
			value: priced > 0 ? formatCredits(review.credits / priced) : "Not yet known",
			subline: `${formatCredits(review.credits)} in all`,
		}),
		statRailItem(h, {
			eyebrow: "Re-reviews",
			eyebrowTooltip:
				"Reviews after a pull request's first this cycle: Maple reviews each new push again.",
			value: review.reReviews.toLocaleString("en-US"),
			subline: `${formatCredits(review.reReviewCredits)} in all`,
		}),
	])
}

const sourcesTable = (h: H, usage: AiCreditUsageResponse, total: number): Html =>
	vstack(h, { gap: "3" }, [
		sectionHeading(h, { title: "By feature", as: "h3" }),
		panel(h, {}, [
			table(h, { size: "sm", ariaLabel: "AI credits by feature" }, [
				tableHeader(h, [
					tableRow(h, [
						tableHead(h, ["Feature"]),
						tableHead(h, ["Share"], "hidden w-32 sm:table-cell"),
						tableHead(h, ["Credits"], "w-24 text-right"),
					]),
				]),
				tableBody(
					h,
					usage.bySource.length === 0
						? [emptyRow(h, 3, "No AI credits spent this cycle")]
						: Arr.map(usage.bySource, (entry) =>
								tableRow(
									h,
									[
										tableCell(h, [
											hstack(h, { gap: "2", shrink: true }, [
												swatch(h, {
													color: SOURCE_COLORS[entry.source],
													round: true,
													ariaHidden: true,
												}),
												typography(h, { truncate: true }, [
													AI_SOURCE_LABELS[entry.source],
												]),
											]),
										]),
										tableCell(
											h,
											[shareBar(h, entry.credits, total, SOURCE_COLORS[entry.source])],
											"hidden sm:table-cell",
										),
										numericTableCell(h, [figure(h, formatCredits(entry.credits))]),
									],
									undefined,
									[h.Key(entry.source)],
								),
							),
				),
			]),
		]),
	])

/** Spend no model is named on (a security audit's sandbox fee) shows as its own row, so the table adds up. */
const UNATTRIBUTED = "Unattributed"

const modelsTable = (h: H, usage: AiCreditUsageResponse, total: number): Html => {
	const named = Num.sumAll(Arr.map(usage.byModel, (entry) => entry.credits))
	const rest = total - named
	const rows = rest >= 0.005 ? [...usage.byModel, { model: UNATTRIBUTED, credits: rest }] : usage.byModel
	return vstack(h, { gap: "3" }, [
		sectionHeading(h, { title: "By model", as: "h3" }),
		panel(h, {}, [
			table(h, { size: "sm", ariaLabel: "AI credits by model" }, [
				tableHeader(h, [
					tableRow(h, [
						tableHead(h, ["Model"]),
						tableHead(h, ["Share"], "hidden w-32 sm:table-cell"),
						tableHead(h, ["Credits"], "w-24 text-right"),
					]),
				]),
				tableBody(
					h,
					rows.length === 0
						? [emptyRow(h, 3, "No model calls this cycle")]
						: Arr.map(rows, (entry) =>
								tableRow(
									h,
									[
										truncatedTableCell(h, [
											typography(
												h,
												{
													mono: true,
													truncate: true,
													attributes: [h.Title(entry.model)],
												},
												[modelLabel(entry.model)],
											),
										]),
										tableCell(
											h,
											[shareBar(h, entry.credits, total, "var(--muted-foreground)")],
											"hidden sm:table-cell",
										),
										numericTableCell(h, [figure(h, formatCredits(entry.credits))]),
									],
									undefined,
									[h.Key(entry.model)],
								),
							),
				),
			]),
		]),
	])
}

const codeReviewDetail = (h: H, review: CodeReviewSpend): ReadonlyArray<Html> => {
	const manyRepositories = review.repositories.length > 1
	return [
		vstack(h, { gap: "3" }, [
			sectionHeading(h, {
				title: "Code review by repository",
				hint: "Each review is one run on one push",
				as: "h3",
			}),
			panel(h, {}, [
				table(h, { size: "sm", ariaLabel: "Code review credits by repository" }, [
					tableHeader(h, [
						tableRow(h, [
							tableHead(h, ["Repository"]),
							tableHead(h, ["Pull requests"], "hidden w-28 text-right sm:table-cell"),
							tableHead(h, ["Reviews"], "w-20 text-right"),
							tableHead(h, ["Share"], "hidden w-32 md:table-cell"),
							tableHead(h, ["Credits"], "w-24 text-right"),
						]),
					]),
					tableBody(
						h,
						Arr.map(review.repositories, (repo) =>
							tableRow(
								h,
								[
									truncatedTableCell(h, [
										typography(h, { truncate: true }, [repo.fullName]),
									]),
									numericTableCell(
										h,
										[figure(h, String(repo.pullRequests))],
										"hidden sm:table-cell",
									),
									numericTableCell(h, [figure(h, String(repo.reviews))]),
									tableCell(
										h,
										[shareBar(h, repo.credits, review.credits, "var(--chart-1)")],
										"hidden md:table-cell",
									),
									numericTableCell(h, [figure(h, formatCredits(repo.credits))]),
								],
								undefined,
								[h.Key(repo.repositoryId)],
							),
						),
					),
				]),
			]),
		]),
		vstack(h, { gap: "3" }, [
			sectionHeading(h, {
				title: "Most expensive pull requests",
				hint: "Every review of a pull request this cycle",
				as: "h3",
			}),
			panel(h, {}, [
				table(h, { size: "sm", ariaLabel: "Most expensive pull requests" }, [
					tableHeader(h, [
						tableRow(h, [
							tableHead(h, ["Pull request"]),
							tableHead(h, ["Reviews"], "w-20 text-right"),
							tableHead(h, ["Credits"], "w-24 text-right"),
						]),
					]),
					tableBody(
						h,
						Arr.map(review.topPullRequests, (pr) => pullRequestRow(h, pr, manyRepositories)),
					),
				]),
			]),
			...(review.unpricedReviews > 0
				? [
						typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
							`${review.unpricedReviews.toLocaleString("en-US")} of this cycle's reviews ran before Maple recorded each review's cost. They count above, without credits.`,
						]),
					]
				: []),
		]),
	]
}

const pullRequestRow = (h: H, pr: CodeReviewSpendPullRequest, showRepository: boolean): Html => {
	const isRepeated = pr.reviews >= REPEATED_REVIEWS
	return tableRow(
		h,
		[
			truncatedTableCell(h, [
				vstack(h, { gap: "1", shrink: true }, [
					hstack(h, { gap: "2", shrink: true }, [
						textLink(
							h,
							{
								href: pr.url,
								tone: "inherit",
								isMono: true,
								attributes: [
									h.Target("_blank"),
									h.Rel("noreferrer"),
									h.AriaLabel(
										`Pull request #${pr.number} in ${pr.fullName}, opens in a new tab`,
									),
								],
							},
							[`#${pr.number}`],
						),
						typography(h, { tone: "muted", truncate: true }, [pr.title ?? ""]),
					]),
					...(showRepository || isRepeated
						? [
								hstack(h, { gap: "2", shrink: true }, [
									...(showRepository
										? [
												typography(
													h,
													{ size: "2xs", tone: "muted", truncate: true },
													[pr.fullName],
												),
											]
										: []),
									...(isRepeated
										? [
												badge(h, { variant: "warn", pill: true }, [
													`Reviewed ${pr.reviews}×`,
												]),
											]
										: []),
								]),
							]
						: []),
				]),
			]),
			numericTableCell(h, [figure(h, String(pr.reviews))]),
			numericTableCell(h, [figure(h, formatCredits(pr.credits))]),
		],
		undefined,
		[h.Key(`${pr.repositoryId}#${pr.number}`)],
	)
}

const emptyRow = (h: H, columns: number, text: string): Html =>
	tableRow(h, [
		tableCell(h, [typography(h, { tone: "muted" }, [text])], undefined, [
			h.Attribute("colspan", String(columns)),
		]),
	])
