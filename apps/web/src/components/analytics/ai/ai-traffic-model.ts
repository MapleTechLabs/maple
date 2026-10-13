// View model for the AI tab: joins the referral and crawler rows to the product
// catalog, zero-fills the sparklines and ranks products against the previous window.

import {
	AI_CRAWLERS,
	AI_PRODUCT_CARD_COUNT,
	AI_PRODUCTS,
	aiProductById,
	type AiCrawlPurpose,
	type AiProduct,
} from "@maple/domain/ai-traffic"
import { parseWarehouseDateTime } from "@maple/query-engine"

import type { WebAnalyticsAiCrawler, WebAnalyticsAiReferralPoint } from "@/api/warehouse/web-analytics"

/** Bucket widths the sparklines may use, smallest first. */
const SPARK_STEPS = [3600, 2 * 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86_400, 2 * 86_400, 7 * 86_400]

/** Most bars a card sparkline draws. */
const MAX_SPARK_BARS = 32

/** The narrowest bucket that keeps the window at or under {@link MAX_SPARK_BARS} bars. */
export function sparkBucketSeconds(startTime: string, endTime: string): number {
	const spanSeconds = (parseWarehouseDateTime(endTime) - parseWarehouseDateTime(startTime)) / 1000
	return (
		SPARK_STEPS.find((step) => spanSeconds / step <= MAX_SPARK_BARS) ??
		SPARK_STEPS[SPARK_STEPS.length - 1] ??
		86_400
	)
}

/** Epoch-aligned bucket starts covering the window, matching `toStartOfInterval`. */
function bucketStarts(startTime: string, endTime: string, bucketSeconds: number): ReadonlyArray<number> {
	const step = bucketSeconds * 1000
	const first = Math.floor(parseWarehouseDateTime(startTime) / step) * step
	const end = parseWarehouseDateTime(endTime)
	const starts: Array<number> = []
	for (let at = first; at <= end; at += step) starts.push(at)
	return starts
}

export interface AiReferralSummary {
	readonly visits: number
	/** One value per bucket across the whole window, zeros included. */
	readonly spark: ReadonlyArray<number>
}

/** Per-product visit totals and zero-filled sparklines. */
export function summarizeReferrals(
	points: ReadonlyArray<WebAnalyticsAiReferralPoint>,
	window: { startTime: string; endTime: string; bucketSeconds: number },
): ReadonlyMap<string, AiReferralSummary> {
	const starts = bucketStarts(window.startTime, window.endTime, window.bucketSeconds)
	const index = new Map(starts.map((at, i) => [at, i]))
	const byProduct = new Map<string, Array<number>>()
	for (const point of points) {
		const series = byProduct.get(point.product) ?? starts.map(() => 0)
		const slot = index.get(parseWarehouseDateTime(point.bucket))
		if (slot !== undefined) series[slot] = (series[slot] ?? 0) + point.sessions
		byProduct.set(point.product, series)
	}
	return new Map(
		[...byProduct].map(([product, spark]) => [
			product,
			{ visits: spark.reduce((sum, value) => sum + value, 0), spark },
		]),
	)
}

/** Visit totals only, for the comparison window. */
export function totalReferrals(
	points: ReadonlyArray<WebAnalyticsAiReferralPoint>,
): ReadonlyMap<string, number> {
	const totals = new Map<string, number>()
	for (const point of points) totals.set(point.product, (totals.get(point.product) ?? 0) + point.sessions)
	return totals
}

export interface AiReferralRank {
	readonly product: AiProduct
	readonly visits: number
	/** Share of all AI visits in the window, 0-1. */
	readonly share: number
	/** Change in share since the previous window, in percentage points. `null` when new. */
	readonly shareDeltaPoints: number | null
}

/** Products that sent visits, most first, with their change in share. */
export function rankReferrals(
	current: ReadonlyMap<string, AiReferralSummary>,
	previous: ReadonlyMap<string, number> | undefined,
): ReadonlyArray<AiReferralRank> {
	const total = sum([...current.values()].map((summary) => summary.visits))
	const previousTotal = previous ? sum([...previous.values()]) : 0
	return [...current]
		.flatMap(([id, summary]) => {
			const product = aiProductById(id)
			if (!product || summary.visits === 0) return []
			const before = previous?.get(id) ?? 0
			const share = total > 0 ? summary.visits / total : 0
			return [
				{
					product,
					visits: summary.visits,
					share,
					shareDeltaPoints:
						before > 0 && previousTotal > 0 ? (share - before / previousTotal) * 100 : null,
				},
			]
		})
		.sort((a, b) => b.visits - a.visits)
}

export interface AiPurposeActivity {
	readonly purpose: AiCrawlPurpose
	readonly pages: number
	readonly requests: number
	readonly lastSeen: string
}

export interface AiCrawlSummary {
	readonly requests: number
	readonly failedRequests: number
	/** Purposes with at least one served page, most pages first. */
	readonly purposes: ReadonlyArray<AiPurposeActivity>
}

const crawlerByName = new Map(AI_CRAWLERS.map((crawler) => [crawler.name, crawler]))

/**
 * Crawler rows rolled up per product. Pages add across crawlers of one purpose,
 * which counts a page twice only when two such crawlers both read it.
 */
export function summarizeCrawls(
	crawlers: ReadonlyArray<WebAnalyticsAiCrawler>,
): ReadonlyMap<string, AiCrawlSummary> {
	const byProduct = new Map<
		string,
		{ requests: number; failedRequests: number; purposes: Map<AiCrawlPurpose, AiPurposeActivity> }
	>()
	for (const row of crawlers) {
		const crawler = crawlerByName.get(row.crawler)
		if (!crawler) continue
		const entry = byProduct.get(crawler.product) ?? {
			requests: 0,
			failedRequests: 0,
			purposes: new Map(),
		}
		entry.requests += row.requests
		entry.failedRequests += row.failedRequests
		if (row.pages > 0) {
			const prior = entry.purposes.get(crawler.purpose)
			entry.purposes.set(crawler.purpose, {
				purpose: crawler.purpose,
				pages: (prior?.pages ?? 0) + row.pages,
				requests: (prior?.requests ?? 0) + row.requests,
				lastSeen: prior && prior.lastSeen > row.lastSeen ? prior.lastSeen : row.lastSeen,
			})
		}
		byProduct.set(crawler.product, entry)
	}
	return new Map(
		[...byProduct].map(([product, entry]) => [
			product,
			{
				requests: entry.requests,
				failedRequests: entry.failedRequests,
				purposes: [...entry.purposes.values()].sort((a, b) => b.pages - a.pages),
			},
		]),
	)
}

/** Crawler display name to its product, for icon lookups. */
export const productForCrawler = (name: string): AiProduct | undefined => {
	const crawler = crawlerByName.get(name)
	return crawler ? aiProductById(crawler.product) : undefined
}

export const purposeForCrawler = (name: string): AiCrawlPurpose | undefined =>
	crawlerByName.get(name)?.purpose

/** The products that always get a card, in catalog order. */
export const CARD_PRODUCTS: ReadonlyArray<AiProduct> = AI_PRODUCTS.slice(0, AI_PRODUCT_CARD_COUNT)

const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0)
