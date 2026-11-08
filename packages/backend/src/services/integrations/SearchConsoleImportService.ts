// Google Search Console importer: each tick claims due properties and runs one import each, HEAD
// (trailing days through today) or BACKFILL (toward the 16-month floor), one day at a time at all
// three grains. A failure keeps the frontier past the last whole day and backs the property off.
import { IntegrationsPersistenceError, type OrgId } from "@maple/domain/http"
import type { SearchConsoleDailyRow } from "@maple/domain/tinybird"
import * as PG from "@maple-dev/effect-orm/postgres"
import { OAuthConnections, SearchConsoleSites, type SearchConsoleSiteRow } from "@maple/db/tables"
import { Cause, Clock, Context, Effect, Layer, Option, Ref, Result, Schema, Array as Arr } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { systemTenant } from "@maple/backend/services/alerts/system-tenant"
import { GoogleOAuthService } from "@maple/backend/services/auth/GoogleOAuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import {
	querySearchAnalytics,
	SEARCH_ANALYTICS_MAX_ROW_LIMIT,
	SearchConsoleApiError,
	type SearchAnalyticsRow,
} from "./google-search-console/client"
import {
	daysBetween,
	GRAINS,
	type ImportPlan,
	pacificToday,
	planImport,
	SEARCH_CONSOLE_DATASOURCE,
	toDailyRows,
	toWarehouseDateTime64,
	addDays,
	HEAD_REFETCH_DAYS,
	historyFloor,
} from "./google-search-console/import-plan"

/** Longer than the lane deadline, so a live tick never loses its claim. */
const LEASE_MS = 15 * 60_000
/** How often a current property re-imports its head. */
export const HEAD_INTERVAL_MS = 6 * 60 * 60_000
/** A 429 sits the property out at least this long. */
const QUOTA_HOLD_MS = 25 * 60_000
/** Backoff after a claim: doubles per consecutive failure, up to a day. */
const BACKOFF_BASE_MS = 15 * 60_000
const BACKOFF_MAX_MS = 24 * 60 * 60_000
/** A tick that starts a little early still picks up a backoff that ends on its schedule. */
const TICK_SLACK_MS = 60_000
const MAX_SITES_PER_TICK = 20
const SITE_CONCURRENCY = 2
/** 100 pages of 25k rows: past it one day of a grain is too large to hold in memory. */
const MAX_PAGES_PER_QUERY = 100
/** Rows per `ingest` request, so a full Google page splits into bounded Events API bodies. */
const INGEST_BATCH_ROWS = 10_000

export class SearchConsoleImportWriteError extends Schema.TaggedError<SearchConsoleImportWriteError>()(
	"@maple/backend/integrations/SearchConsoleImportWriteError",
	{ message: Schema.String },
) {}

export class SearchConsoleImportRowLimitError extends Schema.TaggedError<SearchConsoleImportRowLimitError>()(
	"@maple/backend/integrations/SearchConsoleImportRowLimitError",
	{ message: Schema.String },
) {}

export interface SearchConsoleImportSummary {
	/** Due properties this tick looked at. */
	readonly due: number
	readonly imported: number
	/** Claimed by another tick, or nothing to do. */
	readonly skipped: number
	readonly failures: number
	readonly rowsWritten: number
	readonly days: number
}

export interface SearchConsoleImportServiceApi {
	readonly pollAllSites: Effect.Effect<SearchConsoleImportSummary, IntegrationsPersistenceError>
}

interface SiteOutcome {
	readonly status: "imported" | "skipped" | "failed"
	readonly rowsWritten: number
	readonly days: number
}

const isSearchConsoleApiError = Schema.is(SearchConsoleApiError)

/** The backoff a claim sets: 15 minutes doubled per consecutive failure, capped at a day. */
export const nextBackoffMs = (consecutiveFailures: number): number =>
	Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(consecutiveFailures, 16))

const SKIPPED: SiteOutcome = { status: "skipped", rowsWritten: 0, days: 0 }
const FAILED: SiteOutcome = { status: "failed", rowsWritten: 0, days: 0 }

export class SearchConsoleImportService extends Context.Service<
	SearchConsoleImportService,
	SearchConsoleImportServiceApi
>()("@maple/backend/services/SearchConsoleImportService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const google = yield* GoogleOAuthService
		const warehouse = yield* WarehouseQueryService
		const httpClient = yield* HttpClient.HttpClient
		const dbExecute = makeDbExecute(
			database,
			"SearchConsoleImportService",
			makePersistenceErrorMapper(IntegrationsPersistenceError, "Search Console import database error"),
		)

		const leaseFree = ($: PG.ColumnAccessor<typeof SearchConsoleSites.columns>, now: number) =>
			PG.or(
				$.leaseUntil.isNull(),
				$.leaseUntil.lt(now),
				// A live lease never reaches past now + LEASE_MS; anything further is a corrupt value.
				$.leaseUntil.gt(now + 2 * LEASE_MS),
			)

		/** Enabled properties under a live grant with work to do and no backoff, healthy ones first. */
		const loadDue = (now: number) => {
			const today = pacificToday(now)
			return dbExecute((db) =>
				db.run(
					PG.from(SearchConsoleSites, "s")
						.innerJoin(OAuthConnections, "c", (site, connection) =>
							connection.id.eq(site.oauthConnectionId),
						)
						.select(($) => ({
							id: $.id,
							orgId: $.orgId,
							consecutiveFailures: $.consecutiveFailures,
						}))
						.where(($) => [
							$.enabled.eq(true),
							$.c.revokedAt.isNull(),
							leaseFree($, now),
							PG.or($.nextAttemptAt.isNull(), $.nextAttemptAt.lte(now + TICK_SLACK_MS)),
							PG.or(
								$.watermarkDate.isNull(),
								$.lastSyncedAt.isNull(),
								$.lastSyncedAt.lt(now - HEAD_INTERVAL_MS),
								$.watermarkDate.lt(addDays(today, -HEAD_REFETCH_DAYS)),
								$.backfillDate.isNull(),
								$.backfillDate.gt(historyFloor(today)),
							),
						])
						.orderBy(($) => [
							// Failing properties go last, so a pile of them cannot take every slot.
							[PG.asBoolean($.lastError.isNull()), "desc"],
							[PG.asBoolean($.lastSyncedAt.isNull()), "desc"],
							[$.lastSyncedAt, "asc"],
							[$.updatedAt, "asc"],
						])
						.limit(MAX_SITES_PER_TICK),
				),
			)
		}

		/**
		 * Lease the row and back it off up front, counting the attempt as a failure until it succeeds,
		 * so an import killed mid-way also waits, longer each time. Success resets the count.
		 */
		const claim = (candidate: Pick<SearchConsoleSiteRow, "id" | "consecutiveFailures">, now: number) =>
			dbExecute((db) =>
				db.run(
					PG.update(SearchConsoleSites)
						.set({
							leaseUntil: now + LEASE_MS,
							nextAttemptAt: now + nextBackoffMs(candidate.consecutiveFailures),
							consecutiveFailures: candidate.consecutiveFailures + 1,
							updatedAt: now,
						})
						.where(($) => [$.id.eq(candidate.id), $.enabled.eq(true), leaseFree($, now)])
						.returning(),
				),
			).pipe(Effect.map((rows) => rows[0] ?? null))

		/** Compare-and-set on the claimed lease, so a tick that outlived it never touches a successor's row. */
		const finish = (
			site: SearchConsoleSiteRow,
			set: PG.UpdateSetOf<typeof SearchConsoleSites>,
			now: number,
		) =>
			dbExecute((db) =>
				db.run(
					PG.update(SearchConsoleSites)
						.set({ leaseUntil: null, updatedAt: now, ...set })
						.where(($) => [
							$.id.eq(site.id),
							site.leaseUntil === null
								? $.leaseUntil.isNull()
								: $.leaseUntil.eq(site.leaseUntil),
						]),
				),
			)

		const write = (orgId: OrgId, rows: ReadonlyArray<SearchConsoleDailyRow>) =>
			Effect.forEach(
				Arr.chunksOf(rows, INGEST_BATCH_ROWS),
				(batch) => warehouse.ingest(systemTenant(orgId), SEARCH_CONSOLE_DATASOURCE, batch),
				{ discard: true },
			).pipe(
				Effect.mapError(
					(error) =>
						new SearchConsoleImportWriteError({
							message: `Maple could not store the Search Console rows: ${error.message}`,
						}),
				),
			)

		/** Every page of one grain for one day, held in memory: nothing is written until all arrived. */
		const fetchDayGrain = (
			accessToken: string,
			site: SearchConsoleSiteRow,
			grain: (typeof GRAINS)[number],
			day: string,
		) => {
			const fetchPages = (
				startRow: number,
				pages: ReadonlyArray<ReadonlyArray<SearchAnalyticsRow>>,
			): Effect.Effect<
				ReadonlyArray<SearchAnalyticsRow>,
				SearchConsoleImportRowLimitError | Effect.Error<ReturnType<typeof querySearchAnalytics>>
			> =>
				Effect.gen(function* () {
					if (pages.length >= MAX_PAGES_PER_QUERY) {
						return yield* new SearchConsoleImportRowLimitError({
							message: `Google returned more than ${MAX_PAGES_PER_QUERY * SEARCH_ANALYTICS_MAX_ROW_LIMIT} ${grain.grain} rows for ${day}`,
						})
					}
					const page = yield* querySearchAnalytics(httpClient, accessToken, site.siteUrl, {
						startDate: day,
						endDate: day,
						dimensions: grain.dimensions,
						startRow,
						dataState: "all",
					})
					const fetched = Arr.append(pages, page.rows)
					return page.nextStartRow === null
						? Arr.flatten(fetched)
						: yield* fetchPages(page.nextStartRow, fetched)
				})
			return fetchPages(0, [])
		}

		/**
		 * One day at every grain: all pages of all grains first, then the writes, each grain with one
		 * `IngestedAt`. A fetch failure writes nothing, so the day's previous complete import stays newest.
		 */
		const importDay = Effect.fn("SearchConsoleImportService.importDay")(function* (
			accessToken: string,
			site: SearchConsoleSiteRow,
			day: string,
			ingestedAt: string,
		) {
			yield* Effect.annotateCurrentSpan("maple.search_console.day", day)
			const fetched = yield* Effect.forEach(GRAINS, (grain) =>
				fetchDayGrain(accessToken, site, grain, day).pipe(
					Effect.map((rows) =>
						toDailyRows(
							{
								orgId: site.orgId,
								siteUrl: site.siteUrl,
								grain: grain.grain,
								dimensions: grain.dimensions,
								ingestedAt,
							},
							rows,
						),
					),
				),
			)
			const rows = Arr.flatten(fetched)
			yield* write(site.orgId, rows)
			yield* Effect.annotateCurrentSpan("maple.search_console.rows_written", rows.length)
			return rows.length
		})

		/** Head walks up from its start, backfill down from its end, so either frontier moves day by day. */
		const daysOf = (plan: Exclude<ImportPlan, { readonly mode: "idle" }>): ReadonlyArray<string> => {
			const ascending = Arr.map(Arr.range(0, daysBetween(plan.startDate, plan.endDate) - 1), (offset) =>
				addDays(plan.startDate, offset),
			)
			return plan.mode === "head" ? ascending : Arr.reverse(ascending)
		}

		/** The days written in full, in import order, and the failure that stopped the import, if any. */
		const runImport = (
			site: SearchConsoleSiteRow,
			plan: Exclude<ImportPlan, { readonly mode: "idle" }>,
			now: number,
		) =>
			Effect.gen(function* () {
				// Readers keep only the newest `IngestedAt` per day and grain, so each must be a whole import.
				const ingestedAt = toWarehouseDateTime64(now)
				const completed = yield* Ref.make<ReadonlyArray<string>>([])
				const rowsWritten = yield* Ref.make(0)
				const result = yield* google
					.withAccessToken(site.orgId, (accessToken) =>
						Effect.forEach(
							daysOf(plan),
							(day) =>
								importDay(accessToken, site, day, ingestedAt).pipe(
									Effect.flatMap((rows) =>
										Effect.andThen(
											Ref.update(rowsWritten, (sum) => sum + rows),
											Ref.update(completed, Arr.append(day)),
										),
									),
								),
							{ discard: true },
						),
					)
					.pipe(Effect.result)
				return {
					completed: yield* Ref.get(completed),
					rowsWritten: yield* Ref.get(rowsWritten),
					failure: Result.isFailure(result) ? result.failure : null,
				}
			})

		const importSite = Effect.fn("SearchConsoleImportService.importSite")(function* (
			site: SearchConsoleSiteRow,
			now: number,
		) {
			const plan = planImport(site, now, HEAD_INTERVAL_MS)
			yield* Effect.annotateCurrentSpan({
				orgId: site.orgId,
				"maple.search_console.site_url": site.siteUrl,
				"maple.search_console.mode": plan.mode,
			})
			if (plan.mode === "idle") {
				yield* finish(site, { nextAttemptAt: null, consecutiveFailures: 0 }, now)
				return SKIPPED
			}
			yield* Effect.annotateCurrentSpan({
				"maple.search_console.start_date": plan.startDate,
				"maple.search_console.end_date": plan.endDate,
				"maple.search_console.days": daysBetween(plan.startDate, plan.endDate),
			})
			const { completed, rowsWritten, failure } = yield* runImport(site, plan, now)
			// The frontier moves over whole days only: head up to its last, backfill down to its last.
			const last = Arr.last(completed)
			const frontier: PG.UpdateSetOf<typeof SearchConsoleSites> = Option.isNone(last)
				? {}
				: plan.mode === "head"
					? {
							// Never move the head back: a catch-up step ends before today.
							watermarkDate:
								site.watermarkDate !== null && site.watermarkDate > last.value
									? site.watermarkDate
									: last.value,
							backfillDate: site.backfillDate ?? plan.startDate,
						}
					: { backfillDate: last.value }
			yield* Effect.annotateCurrentSpan({
				"maple.search_console.days_completed": completed.length,
				"maple.search_console.rows_written": rowsWritten,
			})
			if (failure !== null) {
				// The claim already counted this failure and set its backoff; a 429 waits at least the quota hold.
				yield* Effect.annotateCurrentSpan("maple.search_console.outcome", "failed")
				const backoffUntil = site.nextAttemptAt ?? now + BACKOFF_BASE_MS
				const quota = isSearchConsoleApiError(failure) && failure.status === 429
				yield* finish(
					site,
					{
						...frontier,
						lastError: failure.message,
						nextAttemptAt: quota ? Math.max(backoffUntil, now + QUOTA_HOLD_MS) : backoffUntil,
					},
					now,
				)
				return { status: "failed", rowsWritten, days: completed.length } satisfies SiteOutcome
			}
			yield* finish(
				site,
				{
					...frontier,
					lastSyncedAt: plan.mode === "head" ? now : site.lastSyncedAt,
					lastError: null,
					nextAttemptAt: null,
					consecutiveFailures: 0,
				},
				now,
			)
			yield* Effect.annotateCurrentSpan("maple.search_console.outcome", "imported")
			return { status: "imported", rowsWritten, days: completed.length } satisfies SiteOutcome
		})

		const pollAllSites = Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const due = yield* loadDue(now)
			yield* Effect.annotateCurrentSpan("maple.search_console.due_sites", due.length)
			const outcomes = yield* Effect.forEach(
				due,
				(candidate) =>
					Effect.gen(function* () {
						const site = yield* claim(candidate, now)
						return site === null ? SKIPPED : yield* importSite(site, now)
					}).pipe(
						// One property's database failure must not fail the tick.
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.interrupt
								: Effect.logWarning("search console import failed").pipe(
										Effect.annotateLogs({
											orgId: candidate.orgId,
											siteId: candidate.id,
											error: summarizeCause(cause),
										}),
										Effect.as(FAILED),
									),
						),
					),
				{ concurrency: SITE_CONCURRENCY },
			)
			const count = (status: SiteOutcome["status"]) =>
				Arr.filter(outcomes, (outcome) => outcome.status === status).length
			const summary = {
				due: due.length,
				imported: count("imported"),
				skipped: count("skipped"),
				failures: count("failed"),
				rowsWritten: Arr.reduce(outcomes, 0, (sum, outcome) => sum + outcome.rowsWritten),
				days: Arr.reduce(outcomes, 0, (sum, outcome) => sum + outcome.days),
			} satisfies SearchConsoleImportSummary
			yield* Effect.annotateCurrentSpan({
				"maple.search_console.imported_sites": summary.imported,
				"maple.search_console.failed_sites": summary.failures,
				"maple.search_console.rows_written": summary.rowsWritten,
			})
			return summary
		}).pipe(Effect.withSpan("SearchConsoleImportService.pollAllSites"))

		return { pollAllSites } satisfies SearchConsoleImportServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(Layer.mergeAll(GoogleOAuthService.layer, WarehouseQueryService.layer)),
	)
}
