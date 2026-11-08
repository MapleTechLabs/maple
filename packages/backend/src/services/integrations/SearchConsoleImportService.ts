/**
 * Daily Google Search Console importer. Each tick claims due enabled properties by lease, least
 * recently synced first, and runs one import per property: HEAD re-fetches the trailing days up
 * to today (Google's Pacific day) so revised days replace their rows, BACKFILL walks history down
 * toward Google's 16-month limit once HEAD is current. Every import writes the three grains to
 * `search_console_daily` through `warehouse.ingest`; a failed import records `lastError` and keeps
 * its frontier, so the next tick repeats it and the ReplacingMergeTree absorbs the overlap.
 */
import { IntegrationsPersistenceError, type OrgId } from "@maple/domain/http"
import type { SearchConsoleDailyRow } from "@maple/domain/tinybird"
import * as PG from "@maple-dev/effect-orm/postgres"
import { OAuthConnections, SearchConsoleSites, type SearchConsoleSiteRow } from "@maple/db/tables"
import { Cause, Clock, Context, Effect, Layer, Schema, Array as Arr } from "effect"
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
/** A 429 sits the property out; under `2 * LEASE_MS`, which the claim treats as corrupt. */
const QUOTA_HOLD_MS = 25 * 60_000
const MAX_SITES_PER_TICK = 20
const SITE_CONCURRENCY = 2
/** 100 pages of 25k rows: past it a property is too large for one chunk. */
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

		/** Enabled properties under a live grant with work to do, least recently synced first. */
		const loadDue = (now: number) => {
			const today = pacificToday(now)
			return dbExecute((db) =>
				db.run(
					PG.from(SearchConsoleSites, "s")
						.innerJoin(OAuthConnections, "c", (site, connection) =>
							connection.id.eq(site.oauthConnectionId),
						)
						.select(($) => ({ id: $.id, orgId: $.orgId }))
						.where(($) => [
							$.enabled.eq(true),
							$.c.revokedAt.isNull(),
							leaseFree($, now),
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
							[PG.asBoolean($.lastSyncedAt.isNull()), "desc"],
							[$.lastSyncedAt, "asc"],
							[$.updatedAt, "asc"],
						])
						.limit(MAX_SITES_PER_TICK),
				),
			)
		}

		const claim = (id: SearchConsoleSiteRow["id"], now: number) =>
			dbExecute((db) =>
				db.run(
					PG.update(SearchConsoleSites)
						.set({ leaseUntil: now + LEASE_MS })
						.where(($) => [$.id.eq(id), $.enabled.eq(true), leaseFree($, now)])
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

		/** Every page of one grain over the range, each written as it arrives. */
		const importGrain = Effect.fn("SearchConsoleImportService.importGrain")(function* (
			accessToken: string,
			site: SearchConsoleSiteRow,
			grain: (typeof GRAINS)[number],
			range: { readonly startDate: string; readonly endDate: string },
			ingestedAt: string,
		) {
			yield* Effect.annotateCurrentSpan("maple.search_console.grain", grain.grain)
			const context = {
				orgId: site.orgId,
				siteUrl: site.siteUrl,
				grain: grain.grain,
				dimensions: grain.dimensions,
				ingestedAt,
			}
			const fetchPages = (
				startRow: number,
				pages: number,
				written: number,
			): Effect.Effect<
				number,
				| SearchConsoleImportWriteError
				| SearchConsoleImportRowLimitError
				| Effect.Error<ReturnType<typeof querySearchAnalytics>>
			> =>
				Effect.gen(function* () {
					if (pages >= MAX_PAGES_PER_QUERY) {
						return yield* new SearchConsoleImportRowLimitError({
							message: `Google returned more than ${MAX_PAGES_PER_QUERY * SEARCH_ANALYTICS_MAX_ROW_LIMIT} ${grain.grain} rows for ${range.startDate} to ${range.endDate}`,
						})
					}
					const page = yield* querySearchAnalytics(httpClient, accessToken, site.siteUrl, {
						...range,
						dimensions: grain.dimensions,
						startRow,
						dataState: "all",
					})
					yield* write(site.orgId, toDailyRows(context, page.rows))
					const total = written + page.rows.length
					return page.nextStartRow === null
						? total
						: yield* fetchPages(page.nextStartRow, pages + 1, total)
				})
			const rowsWritten = yield* fetchPages(0, 0, 0)
			yield* Effect.annotateCurrentSpan("maple.search_console.rows_written", rowsWritten)
			return rowsWritten
		})

		const runImport = (
			site: SearchConsoleSiteRow,
			plan: Exclude<ImportPlan, { readonly mode: "idle" }>,
			now: number,
		) =>
			google.withAccessToken(site.orgId, (accessToken) =>
				Effect.forEach(GRAINS, (grain) =>
					importGrain(accessToken, site, grain, plan, toWarehouseDateTime64(now)),
				).pipe(Effect.map((counts) => Arr.reduce(counts, 0, (sum, count) => sum + count))),
			)

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
				yield* finish(site, {}, now)
				return SKIPPED
			}
			const days = daysBetween(plan.startDate, plan.endDate)
			yield* Effect.annotateCurrentSpan({
				"maple.search_console.start_date": plan.startDate,
				"maple.search_console.end_date": plan.endDate,
				"maple.search_console.days": days,
			})
			const outcome = yield* runImport(site, plan, now).pipe(
				Effect.map((rowsWritten) => ({ ok: true as const, rowsWritten })),
				// Every failure is the property's state, recorded on its row, not a fault of the tick.
				Effect.catch((error) =>
					Effect.succeed({
						ok: false as const,
						message: error.message,
						quota: isSearchConsoleApiError(error) && error.status === 429,
					}),
				),
			)
			if (!outcome.ok) {
				// The frontier stays: the next tick repeats this range.
				yield* Effect.annotateCurrentSpan("maple.search_console.outcome", "failed")
				yield* finish(
					site,
					{ lastError: outcome.message, leaseUntil: outcome.quota ? now + QUOTA_HOLD_MS : null },
					now,
				)
				return FAILED
			}
			yield* finish(
				site,
				plan.mode === "head"
					? {
							// Never move the head back: a catch-up step ends before today.
							watermarkDate:
								site.watermarkDate !== null && site.watermarkDate > plan.endDate
									? site.watermarkDate
									: plan.endDate,
							backfillDate: site.backfillDate ?? plan.startDate,
							lastSyncedAt: now,
							lastError: null,
						}
					: { backfillDate: plan.startDate, lastError: null },
				now,
			)
			yield* Effect.annotateCurrentSpan({
				"maple.search_console.outcome": "imported",
				"maple.search_console.rows_written": outcome.rowsWritten,
			})
			return { status: "imported", rowsWritten: outcome.rowsWritten, days } satisfies SiteOutcome
		})

		const pollAllSites = Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const due = yield* loadDue(now)
			yield* Effect.annotateCurrentSpan("maple.search_console.due_sites", due.length)
			const outcomes = yield* Effect.forEach(
				due,
				(candidate) =>
					Effect.gen(function* () {
						const site = yield* claim(candidate.id, now)
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
