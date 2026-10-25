import {
	CARD_PRODUCTS,
	rankReferrals,
	sparkBucketSeconds,
	summarizeCrawls,
	summarizeReferrals,
	totalReferrals,
} from "../../components/analytics/ai/ai-traffic-model"
import { DEFAULT_TRAFFIC, hasActiveFilters } from "../../components/analytics/filters"
import { EMPTY_VALUE, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { delta } from "../../ui/delta"
import { errorState } from "../../ui/error-state"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../ui/empty"
import { icon } from "../../ui/icon"
import { inlineCode } from "../../ui/inline-code"
import { skeleton } from "../../ui/skeleton"
import { sectionHeading } from "../kit/section-heading"
import { docsLink, emptyActions } from "../kit/signal-empty-state"
import { statRail, statRailItem } from "../kit/stat-rail"
import type { FilterKey, Message } from "./message"
import type { AiCrawlers, Model } from "./model"
import { filtersOf } from "./requests"
import { type BreakdownCard, breakdownPanel } from "./view-breakdown"
import {
	aiEmpty,
	aiPanel,
	aiProductCard,
	CARD_SURFACE,
	contentFormats,
	crawlerTable,
	DIALOG_SURFACE,
	plural,
	rankingTable,
} from "./view-ai-parts"
import { favicon } from "./view-icons"

// `AnalyticsAiTab`: the AI traffic tab.

type H = HtmlBuilder<Message>

const VISITOR_ONLY_FILTERS: ReadonlyArray<FilterKey> = [
	"referrerHost",
	"country",
	"deviceType",
	"browserName",
	"osName",
	"language",
	"utmSource",
	"utmMedium",
	"utmCampaign",
	"visitorType",
	"eventName",
]

const dataOf = <A>(slot: { readonly data: AsyncData.AsyncData<A, unknown> }): A | undefined =>
	Option.getOrUndefined(AsyncData.getData(slot.data))

/** The crawled-pages card (one dimension), shared with the expand dialog. */
export const crawledPagesCard = (model: Model, crawlers: AiCrawlers): BreakdownCard => {
	const isMultiSite = new Set(crawlers.pages.map((page) => page.host)).size > 1
	return {
		id: "ai-pages",
		dimensions: [
			{
				tab: "Pages read by AI crawlers",
				rows: crawlers.pages.map((page) => ({ name: page.path, count: page.requests, secondary: page.host })),
				filterKey: "pagePath",
				noun: "page",
				nounPlural: "pages",
				countLabel: "Fetches",
				renderIcon: isMultiSite
					? (h: H, row: { readonly secondary?: string }) => favicon(h, model, row.secondary ?? "")
					: undefined,
			},
		],
	}
}

const noAiTraffic = (h: H): Html =>
	empty(h, [
		emptyHeader(h, [
			emptyMedia(h, { variant: "icon" }, [icon(h, "FaceRobotIcon")]),
			emptyTitle(h, ["No AI traffic yet"]),
			emptyDescription(h, [
				"See visits sent by ChatGPT, Claude and other assistants, and which pages AI crawlers read. Visits come from the Maple browser SDK, crawler fetches from your server’s traces.",
			]),
		]),
		emptyContent(h, [emptyActions(h, [docsLink(h, "browserSdk", "Setup guide"), docsLink(h, "webAnalytics")])]),
	])

const NO_CRAWLS = (h: H): ReadonlyArray<Html | string> => [
	"AI crawlers fetch pages without running JavaScript, so the browser SDK never sees them. They are counted from your server’s traces: HTTP server spans whose ",
	inlineCode(h, {}, ["user_agent.original"]),
	" names GPTBot, ClaudeBot, PerplexityBot or another AI fetcher.",
	h.span([h.Class("mt-2 flex justify-center")], [docsLink(h, "traces")]),
]

export const aiTab = (h: H, model: Model, timeZone: string): Html => {
	const window = model.window
	if (window === null) return skeleton(h, "h-64 w-full")
	const filters = filtersOf(model.search)
	const bucketSeconds = sparkBucketSeconds(window.startTime, window.endTime)
	const referralPoints = dataOf(model.aiReferrals)
	const referrals =
		referralPoints === undefined ? undefined : summarizeReferrals(referralPoints, { ...window, bucketSeconds })
	const previousPoints = dataOf(model.previousAiReferrals)
	const previousTotals = previousPoints === undefined ? undefined : totalReferrals(previousPoints)
	const crawlers = dataOf(model.aiCrawlers)
	const crawls = crawlers === undefined ? undefined : summarizeCrawls(crawlers.crawlers)
	const isVisitorFiltered =
		VISITOR_ONLY_FILTERS.some((key) => filters[key] !== undefined) ||
		(filters.traffic !== undefined && filters.traffic !== DEFAULT_TRAFFIC)
	const isNoAiTraffic =
		referrals !== undefined &&
		crawlers !== undefined &&
		[...referrals.values()].every((summary) => summary.visits === 0) &&
		crawlers.crawlers.every((row) => row.requests === 0)
	if (isNoAiTraffic && !hasActiveFilters(filters)) return noAiTraffic(h)
	const clock = { nowMs: model.nowMs, timeZone }
	return h.div(
		[h.Class("space-y-6")],
		[
			aiKpis(h, model, referrals, previousTotals, crawlers),
			AsyncData.matchData(model.aiReferrals.data, {
				onEmpty: () =>
					h.div(
						[h.Class("grid gap-3 @min-[560px]/page:grid-cols-2 @min-[880px]/page:grid-cols-3")],
						CARD_PRODUCTS.map(() => skeleton(h, "h-[148px] w-full")),
					),
				onFailure: (failure) => errorState(h, { failure, title: "Couldn't load AI referrals" }),
				onData: () =>
					h.div(
						[h.Class("grid gap-3 @min-[560px]/page:grid-cols-2 @min-[880px]/page:grid-cols-3")],
						CARD_PRODUCTS.map((product, index) =>
							aiProductCard(
								h,
								product,
								referrals?.get(product.id),
								crawls?.get(product.id),
								(index % 3) * 60,
								model.nowMs,
							),
						),
					),
			}),
			h.div(
				[h.Class("grid items-start gap-4 @min-[880px]/page:grid-cols-2")],
				[
					referrals === undefined
						? skeleton(h, "h-64 w-full")
						: rankingPanel(h, rankReferrals(referrals, previousTotals)),
					AsyncData.matchData(model.aiCrawlers.data, {
						onEmpty: () => skeleton(h, "h-64 w-full"),
						onFailure: (failure) =>
							errorState(h, { failure, title: "Couldn't load AI crawlers" }),
						onData: (data) => crawlersPanel(h, data, clock),
					}),
				],
			),
			h.section(
				[h.Class("space-y-3")],
				[
					sectionHeading(h, {
						title: "What AI crawlers read",
						hint: isVisitorFiltered ? "Crawls follow the site and page filters only" : undefined,
					}),
					...AsyncData.matchData(model.aiCrawlers.data, {
						onEmpty: () => [skeleton(h, "h-32 w-full")],
						// The crawlers panel above already shows this read's failure.
						onFailure: () => [],
						onData: (data) => [
							contentFormats(h, data.formats),
							data.pages.length === 0
								? aiPanel(h, { title: "Pages read by AI crawlers" }, [
										aiEmpty(h, ["No page was served to an AI crawler in this window."]),
									])
								: (breakdownPanel(h, model, crawledPagesCard(model, data), {
										selectedOf: (key) =>
											key === "pagePath" ? filters.pagePath : undefined,
										isWaiting: false,
									}) ?? h.div([], [])),
						],
					}),
				],
			),
		],
	)
}

const rankingPanel = (h: H, ranks: ReturnType<typeof rankReferrals>): Html => {
	const options = { title: "Share of AI visits", hint: "Change in share since the previous period" }
	return ranks.length === 0
		? aiPanel(h, options, [
				aiEmpty(h, [
					"No visits from AI assistants in this window. When someone follows a link from ChatGPT, Perplexity, Claude or another assistant, it shows up here.",
				]),
			])
		: aiPanel(h, {
				...options,
				expand: { id: "ai-ranking", count: plural(ranks.length, "assistant", "assistants"), table: rankingTable(h, ranks, CARD_SURFACE) },
			})
}

const crawlersPanel = (h: H, data: AiCrawlers, clock: Readonly<{ nowMs: number; timeZone: string }>): Html => {
	const requests = data.crawlers.reduce((sum, row) => sum + row.requests, 0)
	const failed = data.crawlers.reduce((sum, row) => sum + row.failedRequests, 0)
	const options = {
		title: "AI crawlers",
		hint: "Pages served to each crawler. Error responses are not counted as reads.",
	}
	if (data.crawlers.length === 0) return aiPanel(h, options, [aiEmpty(h, NO_CRAWLS(h))])
	return aiPanel(h, {
		...options,
		aside:
			failed > 0
				? h.span(
						[h.Title("User agents are easy to spoof: scanners borrow crawler names and mostly get 404s.")],
						[formatPercent(failed / Math.max(requests, 1)), " of fetches failed"],
					)
				: undefined,
		expand: {
			id: "ai-crawlers",
			count: plural(data.crawlers.length, "crawler", "crawlers"),
			table: crawlerTable(h, data.crawlers, CARD_SURFACE, clock),
		},
	})
}

/** The ranking or crawler table at dialog width, for the expand dialog. */
export const aiDialogTable = (
	h: H,
	model: Model,
	id: string,
	timeZone: string,
): Readonly<{ title: string; hint: string; table: Html }> | null => {
	const window = model.window
	const points = dataOf(model.aiReferrals)
	const crawlers = dataOf(model.aiCrawlers)
	if (id === "ai-ranking" && window !== null && points !== undefined) {
		const bucketSeconds = sparkBucketSeconds(window.startTime, window.endTime)
		const previous = dataOf(model.previousAiReferrals)
		const ranks = rankReferrals(
			summarizeReferrals(points, { ...window, bucketSeconds }),
			previous === undefined ? undefined : totalReferrals(previous),
		)
		return {
			title: "Share of AI visits",
			hint: "Change in share since the previous period",
			table: rankingTable(h, ranks, DIALOG_SURFACE),
		}
	}
	if (id === "ai-crawlers" && crawlers !== undefined)
		return {
			title: "AI crawlers",
			hint: "Pages served to each crawler. Error responses are not counted as reads.",
			table: crawlerTable(h, crawlers.crawlers, DIALOG_SURFACE, { nowMs: model.nowMs, timeZone }),
		}
	return null
}

const aiKpis = (
	h: H,
	model: Model,
	referrals: ReturnType<typeof summarizeReferrals> | undefined,
	previousTotals: ReadonlyMap<string, number> | undefined,
	crawlers: AiCrawlers | undefined,
): Html => {
	const summaries = referrals === undefined ? [] : [...referrals.values()]
	const visits = summaries.reduce((sum, summary) => sum + summary.visits, 0)
	const products = summaries.filter((summary) => summary.visits > 0).length
	const spark = summaries.reduce<ReadonlyArray<number>>(
		(total, summary) => summary.spark.map((value, i) => value + (total[i] ?? 0)),
		[],
	)
	const previousVisits = previousTotals === undefined ? undefined : [...previousTotals.values()].reduce((a, b) => a + b, 0)
	const change = previousVisits !== undefined && previousVisits > 0 ? (visits - previousVisits) / previousVisits : null
	const sessions = dataOf(model.summary)?.sessions
	const fetches = crawlers?.crawlers.reduce((sum, row) => sum + row.requests, 0) ?? 0
	const failed = crawlers?.crawlers.reduce((sum, row) => sum + row.failedRequests, 0) ?? 0
	const pages = crawlers?.formats.reduce((sum, row) => sum + row.pages, 0) ?? 0
	return statRail(h, {}, [
		statRailItem(h, {
			eyebrow: "AI visits",
			value: referrals === undefined ? EMPTY_VALUE : formatNumber(visits),
			spark,
			delta: change === null ? undefined : delta(h, { ratio: change }),
			subline:
				referrals === undefined
					? undefined
					: products > 0
						? `from ${products} ${products === 1 ? "assistant" : "assistants"}`
						: "No AI referrals yet",
		}),
		statRailItem(h, {
			eyebrow: "Share of sessions",
			value: referrals !== undefined && sessions ? formatPercent(visits / sessions) : EMPTY_VALUE,
			subline: sessions === undefined ? undefined : `of ${formatNumber(sessions)} sessions`,
			delay: 60,
		}),
		statRailItem(h, {
			eyebrow: "Pages read by AI",
			value: crawlers === undefined ? EMPTY_VALUE : formatNumber(pages),
			subline: crawlers === undefined ? undefined : "Distinct pages served to crawlers",
			delay: 120,
		}),
		statRailItem(h, {
			eyebrow: "Crawler fetches",
			value: crawlers === undefined ? EMPTY_VALUE : formatNumber(fetches),
			tone: crawlers !== undefined && fetches > 0 && failed / fetches > 0.5 ? "warn" : "neutral",
			subline: crawlers === undefined ? undefined : failed > 0 ? `${formatNumber(failed)} got an error` : "All served",
			delay: 180,
		}),
	])
}
