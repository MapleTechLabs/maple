import { Result } from "@/lib/effect-atom"
import { formatNumber, formatPercent } from "@maple/ui/lib/format"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import type { WebAnalyticsAiCrawlers } from "@/api/warehouse/web-analytics"
import { DocsLink } from "@/components/common/docs-link"
import { ErrorState } from "@/components/common/error-state"
import { StatRail, StatRailItem } from "@/components/common/stat-rail"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import {
	webAnalyticsAiCrawlersResultAtom,
	webAnalyticsAiReferralsResultAtom,
	webAnalyticsSummaryResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { AnalyticsBreakdownPanel } from "../analytics-breakdown-panel"
import { Delta } from "../analytics-metric-strip"
import { DEFAULT_TRAFFIC, type AnalyticsFilterKey, type AnalyticsFilters } from "../filters"
import { previousWindow } from "../previous-window"
import { Favicon } from "../row-icon"
import {
	AiContentFormats,
	AiCrawlerTable,
	AiEmpty,
	AiPanel,
	AiProductCard,
	AiReferralRanking,
} from "./ai-sections"
import {
	CARD_PRODUCTS,
	rankReferrals,
	sparkBucketSeconds,
	summarizeCrawls,
	summarizeReferrals,
	totalReferrals,
} from "./ai-traffic-model"

const CRAWLED_PAGES_LIMIT = 50

/** Filters crawls ignore: a crawler has no country, device, referrer or visitor id. */
const VISITOR_ONLY_FILTERS: ReadonlyArray<AnalyticsFilterKey> = [
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

const NO_CRAWLS_MESSAGE = (
	<>
		AI crawlers fetch pages without running JavaScript, so the browser SDK never sees them. They are
		counted from your server&apos;s traces: HTTP server spans whose{" "}
		<InlineCode>user_agent.original</InlineCode> names GPTBot, ClaudeBot, PerplexityBot or another AI
		fetcher.
		<span className="mt-2 flex justify-center">
			<DocsLink page="traces" />
		</span>
	</>
)

export function AnalyticsAiTab({
	startTime,
	endTime,
	filters,
	onToggleFilter,
}: {
	startTime: string
	endTime: string
	filters: AnalyticsFilters
	onToggleFilter: (key: AnalyticsFilterKey, value: string) => void
}) {
	const bucketSeconds = sparkBucketSeconds(startTime, endTime)
	const previous = previousWindow(startTime, endTime)

	const referralsResult = useRefreshableAtomValue(
		webAnalyticsAiReferralsResultAtom({ data: { startTime, endTime, bucketSeconds, ...filters } }),
	)
	const previousReferralsResult = useRefreshableAtomValue(
		webAnalyticsAiReferralsResultAtom({ data: { ...previous, bucketSeconds, ...filters } }),
	)
	const crawlersResult = useRefreshableAtomValue(
		webAnalyticsAiCrawlersResultAtom({
			data: {
				startTime,
				endTime,
				host: filters.host,
				pagePath: filters.pagePath,
				pagesLimit: CRAWLED_PAGES_LIMIT,
			},
		}),
	)
	// Same key as the Overview tab's summary, so switching tabs reuses it.
	const summaryResult = useRefreshableAtomValue(
		webAnalyticsSummaryResultAtom({ data: { startTime, endTime, ...filters } }),
	)

	const referrals = Result.builder(referralsResult)
		.onSuccess((rows) => summarizeReferrals(rows.data, { startTime, endTime, bucketSeconds }))
		.orElse(() => undefined)
	// Decorative like the Overview deltas: a failed baseline drops the changes, not the page.
	const previousTotals = Result.builder(previousReferralsResult)
		.onSuccess((rows) => totalReferrals(rows.data))
		.orElse(() => undefined)
	const crawlers = Result.builder(crawlersResult)
		.onSuccess((data) => data)
		.orElse(() => undefined)
	const crawls = crawlers ? summarizeCrawls(crawlers.crawlers) : undefined

	const visitorFiltered =
		VISITOR_ONLY_FILTERS.some((key) => filters[key] !== undefined) ||
		(filters.traffic !== undefined && filters.traffic !== DEFAULT_TRAFFIC)

	return (
		<div className="space-y-6">
			<AiKpis
				referrals={referrals}
				previousTotals={previousTotals}
				sessions={Result.builder(summaryResult)
					.onSuccess((summary) => summary.sessions)
					.orElse(() => undefined)}
				crawlers={crawlers}
			/>

			{Result.builder(referralsResult)
				.onInitial(() => (
					<div className="grid gap-3 @min-[560px]/page:grid-cols-2 @min-[880px]/page:grid-cols-3">
						{CARD_PRODUCTS.map((product) => (
							<Skeleton key={product.id} className="h-[148px] w-full" />
						))}
					</div>
				))
				.onError((error) => <ErrorState error={error} />)
				.onSuccess(() => (
					<div className="grid gap-3 @min-[560px]/page:grid-cols-2 @min-[880px]/page:grid-cols-3">
						{CARD_PRODUCTS.map((product, index) => (
							<AiProductCard
								key={product.id}
								product={product}
								referrals={referrals?.get(product.id)}
								crawl={crawls?.get(product.id)}
								delay={(index % 3) * 60}
							/>
						))}
					</div>
				))
				.render()}

			<div className="grid items-start gap-4 @min-[880px]/page:grid-cols-2">
				{referrals ? (
					<AiReferralRanking ranks={rankReferrals(referrals, previousTotals)} />
				) : (
					<Skeleton className="h-64 w-full" />
				)}
				{Result.builder(crawlersResult)
					.onInitial(() => <Skeleton className="h-64 w-full" />)
					.onError((error) => <ErrorState error={error} />)
					.onSuccess((data) => (
						<AiCrawlerTable crawlers={data.crawlers} emptyMessage={NO_CRAWLS_MESSAGE} />
					))
					.render()}
			</div>

			<section className="space-y-3">
				<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
					<h2 className="text-[13px] font-medium">What AI crawlers read</h2>
					{visitorFiltered ? (
						<span className="text-[11px] text-muted-foreground">
							Crawls follow the site and page filters only
						</span>
					) : null}
				</div>
				{Result.builder(crawlersResult)
					.onInitial(() => <Skeleton className="h-32 w-full" />)
					.onError(() => null)
					.onSuccess((data) => (
						<>
							<AiContentFormats formats={data.formats} />
							<CrawledPages
								pages={data.pages}
								activePath={filters.pagePath}
								onToggleFilter={onToggleFilter}
							/>
						</>
					))
					.render()}
			</section>
		</div>
	)
}

function AiKpis({
	referrals,
	previousTotals,
	sessions,
	crawlers,
}: {
	referrals: ReturnType<typeof summarizeReferrals> | undefined
	previousTotals: ReadonlyMap<string, number> | undefined
	sessions: number | undefined
	crawlers: WebAnalyticsAiCrawlers | undefined
}) {
	const summaries = referrals ? [...referrals.values()] : []
	const visits = summaries.reduce((sum, summary) => sum + summary.visits, 0)
	const products = summaries.filter((summary) => summary.visits > 0).length
	const spark = summaries.reduce<Array<number>>(
		(total, summary) => summary.spark.map((value, i) => value + (total[i] ?? 0)),
		[],
	)
	const previousVisits = previousTotals
		? [...previousTotals.values()].reduce((a, b) => a + b, 0)
		: undefined
	const delta = previousVisits && previousVisits > 0 ? (visits - previousVisits) / previousVisits : null

	const fetches = crawlers?.crawlers.reduce((sum, row) => sum + row.requests, 0) ?? 0
	const failed = crawlers?.crawlers.reduce((sum, row) => sum + row.failedRequests, 0) ?? 0
	// A path maps to exactly one format, so pages add up across formats without double counting.
	const pages = crawlers?.formats.reduce((sum, row) => sum + row.pages, 0) ?? 0

	return (
		<StatRail>
			<StatRailItem
				eyebrow="AI visits"
				value={referrals ? formatNumber(visits) : "—"}
				spark={spark}
				delta={delta === null ? undefined : <Delta delta={delta} />}
				subline={
					referrals
						? products > 0
							? `from ${products} ${products === 1 ? "assistant" : "assistants"}`
							: "No AI referrals yet"
						: undefined
				}
			/>
			<StatRailItem
				eyebrow="Share of sessions"
				value={referrals && sessions ? formatPercent(visits / sessions) : "—"}
				subline={sessions !== undefined ? `of ${formatNumber(sessions)} sessions` : undefined}
				delay={60}
			/>
			<StatRailItem
				eyebrow="Pages read by AI"
				value={crawlers ? formatNumber(pages) : "—"}
				subline={crawlers ? "Distinct pages served to crawlers" : undefined}
				delay={120}
			/>
			<StatRailItem
				eyebrow="Crawler fetches"
				value={crawlers ? formatNumber(fetches) : "—"}
				tone={crawlers && fetches > 0 && failed / fetches > 0.5 ? "warn" : "neutral"}
				subline={
					crawlers
						? failed > 0
							? `${formatNumber(failed)} got an error`
							: "All served"
						: undefined
				}
				delay={180}
			/>
		</StatRail>
	)
}

function CrawledPages({
	pages,
	activePath,
	onToggleFilter,
}: {
	pages: WebAnalyticsAiCrawlers["pages"]
	activePath: string | undefined
	onToggleFilter: (key: AnalyticsFilterKey, value: string) => void
}) {
	if (pages.length === 0) {
		return (
			<AiPanel title="Pages read by AI crawlers">
				<AiEmpty>No page was served to an AI crawler in this window.</AiEmpty>
			</AiPanel>
		)
	}
	const multiSite = new Set(pages.map((page) => page.host)).size > 1
	return (
		<AnalyticsBreakdownPanel
			dimensions={[
				{
					tab: "Pages read by AI crawlers",
					rows: pages.map((page) => ({
						name: page.path,
						count: page.requests,
						secondary: page.host,
					})),
					filterKey: "pagePath",
					noun: "page",
					nounPlural: "pages",
					countLabel: "Fetches",
					renderIcon: multiSite ? (row) => <Favicon host={row.secondary ?? ""} /> : undefined,
				},
			]}
			activeValue={(key) => (key === "pagePath" ? activePath : undefined)}
			onToggleFilter={onToggleFilter}
		/>
	)
}
