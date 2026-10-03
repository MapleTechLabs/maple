import { digestSubscriptions } from "@maple/db"
import {
	DigestNotConfiguredError,
	DigestPersistenceError,
	DigestPreviewResponse,
	DigestRenderError,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import type { RoleName as RoleNameType } from "@maple/domain/http"
import { AI_CRAWLERS, AI_PRODUCTS, aiProductById } from "@maple/domain/ai-traffic"
import { WEB_ANALYTICS_UNSET } from "@maple/domain/query-engine"
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm"
import { Array as Arr, Cause, Clock, Context, Effect, Layer } from "effect"
import {
	aiProductIcon,
	computeDelta,
	deriveWebAnalyticsHeadline,
	emailIcon,
	faviconIcon,
	hasWebAnalyticsContent,
	type Delta,
	type WebAnalyticsDigestProps,
	type WebAnalyticsRankRow,
} from "@maple/email/web-analytics-digest-core"
import { renderWebAnalyticsDigest } from "@maple/email/web-analytics-digest"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import type { CompiledQueryInput } from "@maple/query-engine/ch"
import { EdgeCacheService } from "@maple/cache"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { EmailService } from "@maple/backend/platform/EmailService"
import { Env } from "@maple/backend/platform/Env"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import {
	isMissingAiCrawlerRequests,
	isMissingProductEvents,
} from "@maple/backend/services/warehouse/missing-table"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import {
	isOrgWarehouseQuarantined,
	quarantineOnConfigClassCause,
} from "@maple/backend/services/warehouse/warehouse-org-quarantine"
import { resolveOrgName } from "./resolve-org-name"

const DAY_MS = 24 * 60 * 60 * 1000
/** The email is a glance: three rows per list, the app has the rest. */
const TOP_ROWS = 3
/** Deep enough that a page in this week's top five almost always finds its previous-week row. */
const PREVIOUS_PAGES_LIMIT = 200
/** Below this many previous-week sessions, rate comparisons are noise. */
const RATE_MIN_BASE = 100

/** Human traffic only: the number a site owner means by "visitors", and the web app's default. */
const HUMANS = { traffic: "humans" } as const

const toPersistenceError = (error: unknown) =>
	new DigestPersistenceError({
		message: error instanceof Error ? error.message : `Web analytics digest error: ${String(error)}`,
	})

const crawlerProduct = new Map(AI_CRAWLERS.map((crawler) => [crawler.name, crawler.product]))
const referrerProduct = new Map(
	AI_PRODUCTS.flatMap((product) => product.referrerHosts.map((host) => [host, product.id] as const)),
)

/** Direct traffic, an AI assistant's mark, the site's favicon, or a generic link. */
function sourceIcon(referrerHost: string): string {
	if (referrerHost === WEB_ANALYTICS_UNSET) return emailIcon("direct")
	const host = referrerHost.toLowerCase().replace(/^www\./, "")
	const product = referrerProduct.get(host)
	if (product !== undefined) return aiProductIcon(product)
	return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? faviconIcon(host) : emailIcon("source")
}

/** A relative change in a rate, suppressed when last week's sample was too small to compare. */
function rateDelta(current: number | null, previous: number | null, previousBase: number): Delta {
	if (current === null || previous === null || previousBase < RATE_MIN_BASE || previous <= 0)
		return { kind: "none" }
	return { kind: "pct", value: ((current - previous) / previous) * 100 }
}

function withShares(
	rows: ReadonlyArray<{ icon: string | null; label: string; value: number; delta?: Delta }>,
	total: number,
): Array<WebAnalyticsRankRow> {
	return rows.map((row) => ({ ...row, share: total > 0 ? row.value / total : 0 }))
}

/** `/pricing`, or `docs.acme.com/pricing` once more than one host is in the list. */
function pageLabels<T extends { host: string; path: string }>(rows: ReadonlyArray<T>) {
	const multiHost = new Set(rows.map((row) => row.host)).size > 1
	return (row: T) => (multiHost ? `${row.host}${row.path}` : row.path)
}

export class WebAnalyticsDigestService extends Context.Service<WebAnalyticsDigestService>()(
	"@maple/api/services/WebAnalyticsDigestService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const email = yield* EmailService
			const env = yield* Env
			const warehouse = yield* WarehouseQueryService
			const edgeCache = yield* EdgeCacheService

			const generateData = Effect.fn("WebAnalyticsDigestService.generateData")(function* (
				orgId: OrgId,
			) {
				yield* Effect.annotateCurrentSpan("orgId", orgId)

				// Day-aligned to UTC midnight like the ops digest, so both weeks are
				// whole days and the daily page-view buckets split cleanly.
				const now = yield* Clock.currentTimeMillis
				const todayStartMs = Math.floor(now / DAY_MS) * DAY_MS
				const currentStartMs = todayStartMs - 7 * DAY_MS
				const previousStartMs = todayStartMs - 14 * DAY_MS

				const current = {
					orgId,
					startTime: formatWarehouseDateTime(currentStartMs),
					endTime: formatWarehouseDateTime(todayStartMs - 1000),
				}
				const previous = {
					orgId,
					startTime: formatWarehouseDateTime(previousStartMs),
					endTime: formatWarehouseDateTime(currentStartMs - 1000),
				}
				const fortnight = { ...current, startTime: previous.startTime }
				const currentStartDate = current.startTime.slice(0, 10)

				const tenant: TenantContext = {
					orgId,
					userId: UserId.make("system-web-analytics-digest"),
					roles: [RoleName.make("root")] as ReadonlyArray<RoleNameType>,
					authMode: "self_hosted",
				}
				yield* warehouse.warmRoute(tenant)

				const run = <T>(compiled: CompiledQueryInput<T>, context: string) =>
					warehouse.compiledQuery(tenant, compiled, { profile: "aggregation", context })

				// Page views read the `product_events` rollup, degrading to raw
				// `session_events` on a cluster that has not applied it (same rule as
				// the query-engine routes).
				const withRollup = <A, E, R>(read: (useProductEvents: boolean) => Effect.Effect<A, E, R>) =>
					read(true).pipe(
						Effect.catch((error) =>
							isMissingProductEvents(error) ? read(false) : Effect.fail(error),
						),
					)

				const [
					curSummary,
					prevSummary,
					pageviewSeries,
					curPages,
					prevPages,
					breakdowns,
					aiReferrals,
				] = yield* Effect.all(
					[
						run(
							CH.compile(CH.webAnalyticsSummaryQuery(HUMANS), current),
							"webAnalyticsDigestSummary",
						),
						run(
							CH.compile(CH.webAnalyticsSummaryQuery(HUMANS), previous),
							"webAnalyticsDigestSummary",
						),
						withRollup((useProductEvents) =>
							run(
								CH.compile(
									CH.webAnalyticsPageviewsTimeseriesQuery({
										...HUMANS,
										useProductEvents,
										bucketSeconds: 86_400,
									}),
									fortnight,
								),
								"webAnalyticsDigestPageviews",
							),
						),
						withRollup((useProductEvents) =>
							run(
								CH.compile(
									CH.webAnalyticsPagesQuery({
										...HUMANS,
										useProductEvents,
										limit: TOP_ROWS,
									}),
									current,
								),
								"webAnalyticsDigestPages",
							),
						),
						withRollup((useProductEvents) =>
							run(
								CH.compile(
									CH.webAnalyticsPagesQuery({
										...HUMANS,
										useProductEvents,
										limit: PREVIOUS_PAGES_LIMIT,
									}),
									previous,
								),
								"webAnalyticsDigestPages",
							),
						),
						run(
							CH.compileUnion(
								CH.webAnalyticsBreakdownsQuery({ ...HUMANS, limitPerDimension: TOP_ROWS }),
								current,
							),
							"webAnalyticsDigestBreakdowns",
						),
						run(
							CH.compile(
								CH.webAnalyticsAiReferralsQuery({ ...HUMANS, bucketSeconds: 86_400 }),
								fortnight,
							),
							"webAnalyticsDigestAiReferrals",
						),
					],
					{ concurrency: 4 },
				)

				// `ai_crawler_requests` arrives with a later migration than the rest,
				// and a BYO cluster may not have it: its absence drops the crawler
				// half of the AI section rather than the whole email.
				const crawlers = yield* Effect.all(
					[
						run(
							CH.compile(CH.webAnalyticsAiCrawlersQuery(), current),
							"webAnalyticsDigestAiCrawlers",
						),
						run(
							CH.compile(CH.webAnalyticsAiCrawlersQuery(), previous),
							"webAnalyticsDigestAiCrawlers",
						),
					],
					{ concurrency: 2 },
				).pipe(
					Effect.map(([cur, prev]) => ({ cur, prev })),
					// Only a missing table drops the card. Any other failure fails the
					// org, like the rest of the queries, rather than sending a week with
					// crawler figures silently missing.
					Effect.catch((error) =>
						isMissingAiCrawlerRequests(error)
							? Effect.logInfo(
									"ai_crawler_requests absent; sending without crawler stats",
								).pipe(Effect.annotateLogs({ orgId }), Effect.as(null))
							: Effect.fail(error),
					),
				)

				// Summary
				const summaryOf = (rows: ReadonlyArray<CH.WebAnalyticsSummaryOutput>) => {
					const row = rows[0]
					const identified = Number(row?.identifiedSessions) || 0
					return {
						visitors: Number(row?.visitors) || 0,
						sessions: Number(row?.sessions) || 0,
						identified,
						// Bounce is only measurable over sessions that report page views.
						bounceRate:
							identified > 0 ? ((Number(row?.bouncedSessions) || 0) / identified) * 100 : null,
						avgDurationMs: Number(row?.avgDurationMs) || 0,
					}
				}
				const cur = summaryOf(curSummary)
				const prev = summaryOf(prevSummary)

				let curPageViews = 0
				let prevPageViews = 0
				for (const row of pageviewSeries) {
					const views = Number(row.pageViews) || 0
					if (String(row.bucket).slice(0, 10) >= currentStartDate) curPageViews += views
					else prevPageViews += views
				}

				// Pages
				const prevViewsByPage = new Map(
					prevPages.map(
						(row) => [`${row.host}${row.pagePath}`, Number(row.pageViews) || 0] as const,
					),
				)
				// Last week's list is capped, so a page missing from a FULL list may
				// just have ranked lower: its baseline is unknown, not zero.
				const prevPagesTruncated = prevPages.length >= PREVIOUS_PAGES_LIMIT
				const pageDelta = (key: string, views: number): Delta => {
					const previousViews = prevViewsByPage.get(key)
					if (previousViews !== undefined) return computeDelta(views, previousViews)
					return prevPagesTruncated ? { kind: "none" } : computeDelta(views, 0)
				}
				const pageLabel = pageLabels(curPages.map((row) => ({ host: row.host, path: row.pagePath })))
				const topPages = withShares(
					curPages.map((row) => {
						const views = Number(row.pageViews) || 0
						return {
							icon: null,
							label: pageLabel({ host: row.host, path: row.pagePath }),
							value: views,
							delta: pageDelta(`${row.host}${row.pagePath}`, views),
						}
					}),
					curPageViews,
				)

				// Sources: session counts, shared against this week's sessions. The
				// empty referrer is direct traffic, as the web app labels it.
				const sources = withShares(
					breakdowns
						.filter((row) => row.facetType === "referrerHost")
						.map((row) => ({
							icon: sourceIcon(String(row.name)),
							label: row.name === WEB_ANALYTICS_UNSET ? "Direct" : String(row.name),
							value: Number(row.count) || 0,
						}))
						.sort((a, b) => b.value - a.value)
						.slice(0, TOP_ROWS),
					cur.sessions,
				)

				// AI referrals, split out of one fortnight read by bucket date.
				const referralsBy = (inCurrent: boolean) => {
					const totals = new Map<string, number>()
					for (const row of aiReferrals) {
						if (String(row.bucket).slice(0, 10) >= currentStartDate !== inCurrent) continue
						totals.set(row.product, (totals.get(row.product) ?? 0) + (Number(row.sessions) || 0))
					}
					return totals
				}
				const curReferrals = referralsBy(true)
				const prevReferrals = referralsBy(false)
				const sum = (values: Iterable<number>) => [...values].reduce((a, b) => a + b, 0)
				const curReferralTotal = sum(curReferrals.values())
				const byProduct = withShares(
					[...curReferrals.entries()]
						.map(([product, sessions]) => ({
							icon: aiProductIcon(product),
							label: aiProductById(product)?.label ?? product,
							value: sessions,
							delta: computeDelta(sessions, prevReferrals.get(product) ?? 0),
						}))
						.sort((a, b) => b.value - a.value)
						.slice(0, TOP_ROWS),
					curReferralTotal,
				)

				let crawlerStats: WebAnalyticsDigestProps["ai"]["crawlers"] = null
				if (crawlers !== null) {
					const requests = sum(crawlers.cur.map((row) => Number(row.requests) || 0))
					crawlerStats = {
						requests,
						delta: computeDelta(
							requests,
							sum(crawlers.prev.map((row) => Number(row.requests) || 0)),
						),
						byCrawler: withShares(
							crawlers.cur.slice(0, TOP_ROWS).map((row) => ({
								icon: aiProductIcon(crawlerProduct.get(row.crawler) ?? ""),
								label: row.crawler,
								value: Number(row.requests) || 0,
							})),
							requests,
						),
					}
				}

				const formatDate = (ms: number) =>
					new Date(ms).toLocaleDateString("en-US", {
						month: "short",
						day: "numeric",
						timeZone: "UTC",
					})
				// The exact week the email reports, not the `7d` preset: that one ends
				// now and would drop the email's first day for today's partial one.
				const weekRange = new URLSearchParams({
					startTime: current.startTime,
					endTime: current.endTime,
				})
				const analyticsUrl = `${env.MAPLE_APP_BASE_URL}/analytics?${weekRange.toString()}`

				const props: WebAnalyticsDigestProps = {
					orgName: yield* resolveOrgName(env, orgId),
					dateRange: { start: formatDate(currentStartMs), end: formatDate(todayStartMs - DAY_MS) },
					summary: {
						visitors: { value: cur.visitors, delta: computeDelta(cur.visitors, prev.visitors) },
						pageViews: { value: curPageViews, delta: computeDelta(curPageViews, prevPageViews) },
						bounceRate: {
							value: cur.bounceRate,
							delta: rateDelta(cur.bounceRate, prev.bounceRate, prev.identified),
						},
						avgSessionMs: {
							value: cur.avgDurationMs,
							delta: rateDelta(cur.avgDurationMs, prev.avgDurationMs, prev.sessions),
						},
					},
					topPages,
					sources,
					ai: {
						referrals: {
							sessions: curReferralTotal,
							delta: computeDelta(curReferralTotal, sum(prevReferrals.values())),
							byProduct,
						},
						crawlers: crawlerStats,
					},
					baseUrl: env.MAPLE_APP_BASE_URL,
					analyticsUrl,
					aiUrl: `${analyticsUrl}&tab=ai`,
					unsubscribeUrl: `${env.MAPLE_APP_BASE_URL}/settings/notifications`,
				}

				yield* Effect.annotateCurrentSpan({
					"maple.web_analytics_digest.visitors": cur.visitors,
					"maple.web_analytics_digest.ai_referrals": curReferralTotal,
					"maple.web_analytics_digest.crawler_requests": crawlerStats?.requests ?? -1,
				})
				return props
			})

			const render = (props: WebAnalyticsDigestProps) =>
				Effect.try({
					// Synchronous: the template is a compiled string, spliced in place.
					try: () => renderWebAnalyticsDigest(props),
					catch: (error) =>
						new DigestRenderError({
							message:
								error instanceof Error
									? error.message
									: "Failed to render web analytics email",
						}),
				})

			const preview = Effect.fn("WebAnalyticsDigestService.preview")(function* (orgId: OrgId) {
				if (!email.isConfigured) {
					return yield* new DigestNotConfiguredError({
						message: "Email delivery is not configured",
					})
				}
				const props = yield* generateData(orgId).pipe(Effect.mapError(toPersistenceError))
				return new DigestPreviewResponse({ html: yield* render(props) })
			})

			/**
			 * Runs on the ops digest's 15-minute tick, after it, so the Clerk member
			 * sweep has already seeded any new subscriber rows. Same weekday and
			 * once-a-day claim as the ops digest, on this email's own columns.
			 */
			const runTick = Effect.fn("WebAnalyticsDigestService.runTick")(function* () {
				if (!email.isConfigured) return { sentCount: 0, errorCount: 0, skipped: true }

				const now = yield* Clock.currentTimeMillis
				const sevenDaysAgo = now - 7 * DAY_MS
				const todayStartMs = now - (now % DAY_MS)
				const currentDayOfWeek = new Date(now).getUTCDay()

				const subs = yield* database
					.execute((db) =>
						db
							.select()
							.from(digestSubscriptions)
							.where(eq(digestSubscriptions.webAnalyticsEnabled, true)),
					)
					.pipe(Effect.mapError(toPersistenceError))

				const due = subs.filter(
					(s) =>
						s.dayOfWeek === currentDayOfWeek &&
						(s.webAnalyticsLastSentAt == null ||
							s.webAnalyticsLastSentAt.getTime() < sevenDaysAgo),
				)
				if (due.length === 0) return { sentCount: 0, errorCount: 0, skipped: false }

				const byOrg = Arr.groupBy(due, (s) => s.orgId)

				const results = yield* Effect.forEach(
					Object.entries(byOrg),
					([rawOrgId, orgSubs]) =>
						Effect.gen(function* () {
							const orgId = OrgId.make(rawOrgId)
							if (yield* isOrgWarehouseQuarantined(edgeCache, rawOrgId)) return []

							const claim = yield* database
								.execute((db) =>
									db
										.update(digestSubscriptions)
										.set({ webAnalyticsLastAttemptedAt: new Date(now) })
										.where(
											and(
												inArray(
													digestSubscriptions.id,
													orgSubs.map((s) => s.id),
												),
												or(
													isNull(digestSubscriptions.webAnalyticsLastAttemptedAt),
													lt(
														digestSubscriptions.webAnalyticsLastAttemptedAt,
														new Date(todayStartMs),
													),
												),
											),
										)
										.returning({ id: digestSubscriptions.id }),
								)
								.pipe(Effect.mapError(toPersistenceError))
							const claimed = new Set(claim.map((c) => c.id))
							const claimedSubs = orgSubs.filter((s) => claimed.has(s.id))
							if (claimedSubs.length === 0) return []

							const props = yield* generateData(orgId)
							// Only orgs whose browser SDK reported visits hear from us.
							if (!hasWebAnalyticsContent(props)) return []

							const html = yield* render(props)
							const { subject } = deriveWebAnalyticsHeadline(props)

							return yield* Effect.forEach(
								claimedSubs,
								(sub) =>
									email.send(sub.email, subject, html).pipe(
										Effect.tap(() =>
											Clock.currentTimeMillis.pipe(
												Effect.flatMap((sentAt) =>
													database.execute((db) =>
														db
															.update(digestSubscriptions)
															.set({ webAnalyticsLastSentAt: new Date(sentAt) })
															.where(eq(digestSubscriptions.id, sub.id)),
													),
												),
												// Already sent; the attempt claim still blocks a same-day resend.
												Effect.catchCause((cause) =>
													Cause.hasInterruptsOnly(cause)
														? Effect.interrupt
														: Effect.logWarning(
																"Failed to record web analytics digest send",
															).pipe(
																Effect.annotateLogs({
																	subscriptionId: sub.id,
																	error: summarizeCause(cause),
																}),
															),
												),
											),
										),
										Effect.match({
											onSuccess: () => ({ sent: true }),
											onFailure: () => ({ sent: false }),
										}),
									),
								{ concurrency: 1 },
							)
						}).pipe(
							Effect.catchCause((cause) =>
								Cause.hasInterruptsOnly(cause)
									? Effect.interrupt
									: Effect.gen(function* () {
											const quarantined = yield* quarantineOnConfigClassCause(
												edgeCache,
												rawOrgId,
												cause,
												now,
											)
											if (!quarantined) {
												yield* Effect.logError(
													"Web analytics digest failed for org",
												).pipe(
													Effect.annotateLogs({
														orgId: rawOrgId,
														error: summarizeCause(cause),
													}),
												)
											}
											return orgSubs.map(() => ({ sent: false }))
										}),
							),
						),
					{ concurrency: 1 },
				)

				const all = results.flat()
				const sentCount = all.filter((r) => r.sent).length
				const errorCount = all.length - sentCount
				yield* Effect.annotateCurrentSpan({ sentCount, errorCount })
				return { sentCount, errorCount, skipped: false }
			})

			return { generateData, preview, runTick }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(WarehouseQueryService.layer, EmailService.layer)),
	)
}
