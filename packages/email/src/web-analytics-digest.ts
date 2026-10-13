/**
 * Runtime renderer for the weekly web analytics email: a quick glance at the
 * week (four headline stats, top pages, top sources, AI traffic), with the app
 * one click away for everything else.
 *
 * The markup lives in `emails/web-analytics-digest.vue` and is compiled to
 * `src/generated/web-analytics-digest.ts` by Maizzle (`bun run --cwd
 * packages/email build`). This module only splices those strings together.
 */
import { FRAGMENTS, PAGE } from "./generated/web-analytics-digest"
import { C, deltaPalette, deltaParts, rowBorder, trendColor } from "./delta-render"
import { escapeHtml, fill, preheaderPadding, truncate } from "./template"
import {
	deriveWebAnalyticsHeadline,
	emailIcon,
	fmtDuration,
	fmtNum,
	fmtShare,
	type Delta,
	type EmailIconName,
	type WebAnalyticsDigestProps,
	type WebAnalyticsRankRow,
} from "./web-analytics-digest-core"

export {
	deriveWebAnalyticsHeadline,
	hasWebAnalyticsContent,
	type WebAnalyticsDigestProps,
	type WebAnalyticsRankRow,
} from "./web-analytics-digest-core"

function deltaPill(delta: Delta, invertColor = false): string {
	const { arrow, value } = deltaParts(delta, invertColor)
	return fill(FRAGMENTS.deltaPill, { ...deltaPalette(delta, invertColor), arrow, value })
}

function statCard(
	icon: EmailIconName,
	label: string,
	value: string,
	delta: Delta,
	invertColor = false,
): string {
	return fill(
		FRAGMENTS.statCard,
		{ icon: emailIcon(icon), label, value },
		{ deltaPill: deltaPill(delta, invertColor) },
	)
}

function sectionHead(
	icon: EmailIconName,
	title: string,
	hint: string,
	link: { href: string; text: string },
): string {
	return fill(FRAGMENTS.sectionHead, {
		icon: emailIcon(icon),
		title,
		hint,
		href: link.href,
		linkText: link.text,
	})
}

/** The trailing column: a week-over-week trend when the row has one, else its share. */
function aside(row: WebAnalyticsRankRow): { aside: string; asideColor: string } {
	if (row.delta === undefined) return { aside: fmtShare(row.share), asideColor: C.fgMuted }
	const { arrow, value } = deltaParts(row.delta, false)
	return { aside: arrow === "" ? value : `${arrow} ${value}`, asideColor: trendColor(row.delta) }
}

function rankTable(
	head: string,
	columns: { value: string; aside: string },
	rows: ReadonlyArray<WebAnalyticsRankRow>,
): string {
	if (rows.length === 0) return ""
	const top = Math.max(1, ...rows.map((row) => row.value))
	return fill(
		FRAGMENTS.rankTable,
		{ valueHeading: columns.value, asideHeading: columns.aside },
		{
			head,
			rankRows: rows
				.map((row, index) =>
					fill(
						FRAGMENTS.rankRow,
						{
							rowBorder: rowBorder(index, rows.length),
							label: truncate(row.label, 36),
							// Relative to the list's leader, so the bars read as a ranking.
							barWidth: String(Math.max(2, Math.round((row.value / top) * 100))),
							value: fmtNum(row.value),
							...aside(row),
						},
						{ rowIcon: row.icon === null ? "" : fill(FRAGMENTS.rowIcon, { icon: row.icon }) },
					),
				)
				.join("\n"),
		},
	)
}

function aiColumn(
	icon: EmailIconName,
	label: string,
	total: { value: number; delta: Delta },
	hint: string,
	rows: ReadonlyArray<WebAnalyticsRankRow>,
): string {
	return fill(
		FRAGMENTS.aiColumn,
		{ icon: emailIcon(icon), label, value: fmtNum(total.value), hint: rows.length === 0 ? "" : hint },
		{
			deltaPill: deltaPill(total.delta),
			rows: rows
				.map((row) =>
					fill(FRAGMENTS.compactRow, {
						icon: row.icon ?? emailIcon("ai"),
						label: truncate(row.label, 16),
						value: fmtNum(row.value),
					}),
				)
				.join(""),
		},
	)
}

function aiSection(props: WebAnalyticsDigestProps): string {
	const { referrals, crawlers } = props.ai
	const quiet = referrals.sessions === 0 && (crawlers === null || crawlers.requests === 0)

	const columns = [
		aiColumn(
			"sparkle",
			"AI visits",
			{ value: referrals.sessions, delta: referrals.delta },
			"Clicked through from",
			referrals.byProduct,
		),
		crawlers === null
			? ""
			: aiColumn(
					"crawler",
					"Crawler fetches",
					{ value: crawlers.requests, delta: crawlers.delta },
					"Read by",
					crawlers.byCrawler,
				),
	].join("")

	return fill(
		FRAGMENTS.aiSection,
		{},
		{
			head: sectionHead("ai", "AI traffic", "Visits from AI answers, and AI bots reading your site", {
				href: props.aiUrl,
				text: "AI tab",
			}),
			aiColumns: columns,
			aiQuiet: quiet
				? fill(FRAGMENTS.quietLine, {
						text: "No visits from AI assistants and no AI crawler fetches this week.",
					})
				: "",
		},
	)
}

export function renderWebAnalyticsDigest(props: WebAnalyticsDigestProps): string {
	const { summary } = props
	const { headline, standout } = deriveWebAnalyticsHeadline(props)
	const previewText = standout === null ? headline : `${headline} ${standout}`

	const highlightBanner = fill(
		FRAGMENTS.highlightBanner,
		{
			// Neutral: this banner is a summary, not a verdict. The status colours
			// belong to the ops digest, where the week can actually be bad.
			accent: "#5c554c",
			bannerBg: "#262320",
			pillBg: "#3a342e",
			pillFg: "#b5aa9c",
			label: "THIS WEEK",
			headline,
		},
		{ biggestMover: standout === null ? "" : fill(FRAGMENTS.biggestMover, { text: standout }) },
	)

	return fill(
		PAGE,
		{
			previewText,
			orgName: truncate(props.orgName, 32),
			dateStart: props.dateRange.start,
			dateEnd: props.dateRange.end,
			analyticsUrl: props.analyticsUrl,
			baseUrl: props.baseUrl,
			unsubscribeUrl: props.unsubscribeUrl,
		},
		{
			preheaderPad: escapeHtml(preheaderPadding(previewText)),
			highlightBanner,
			summaryRowOne:
				statCard("visitors", "Visitors", fmtNum(summary.visitors.value), summary.visitors.delta) +
				statCard("pageviews", "Page views", fmtNum(summary.pageViews.value), summary.pageViews.delta),
			summaryRowTwo:
				statCard(
					"bounce",
					"Bounce rate",
					summary.bounceRate.value === null ? "n/a" : `${summary.bounceRate.value.toFixed(1)}%`,
					summary.bounceRate.delta,
					true,
				) +
				statCard(
					"session",
					"Avg. visit",
					fmtDuration(summary.avgSessionMs.value),
					summary.avgSessionMs.delta,
				),
			pagesSection: rankTable(
				sectionHead("page", "Top pages", "Your most viewed pages this week", {
					href: props.analyticsUrl,
					text: "All pages",
				}),
				{ value: "Views", aside: "vs last wk" },
				props.topPages,
			),
			sourcesSection: rankTable(
				sectionHead("source", "Top sources", "Where your visitors came from", {
					href: props.analyticsUrl,
					text: "All sources",
				}),
				{ value: "Visits", aside: "Share" },
				props.sources,
			),
			aiSection: aiSection(props),
		},
	)
}
