// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
/**
 * Google Analytics 4 collector.
 *
 * Polls the GA4 Data API for every org with a connected Google account and writes the results
 * into the regular OTel metrics pipeline (`metrics_sum`), so the metric explorer, dashboard
 * builder and alerting all work on web-analytics data with zero new query paths — the same trade
 * that makes {@link CloudflareAnalyticsService} cheap.
 *
 * The datasets are described by the {@link DATASETS} registry; one generic poll pipeline drives
 * them all, one Data API call per (property, dataset, window).
 *
 * State lives in `google_analytics_state` (one row per org × property × dataset, plus a discovery
 * anchor row per org) and `google_analytics_ledger`. Three frontiers, not Cloudflare's two:
 *
 * - `watermarkAt` — HEAD: end of the newest hour ingested.
 * - `backfillAt` — history, walking down toward {@link BACKFILL_FLOOR_MS}.
 * - `frozenThroughAt` — the one GA4 forces on us. GA4 revises `dateHour` for ~48h, so an hour is
 *   only final once it falls behind this line. Everything between here and HEAD is re-polled and
 *   emitted as a DELTA against the ledger (see `reconcile.ts`); everything behind it is frozen and
 *   its ledger rows are pruned.
 *
 * Delivery is at-least-once in the same narrow sense as the Cloudflare poller: a crash between the
 * gateway accepting a batch and the ledger write landing re-emits that window's deltas next tick.
 * Unlike Cloudflare's replay, this one self-heals — the next successful reconcile diffs against
 * the last PERSISTED ledger, so the bucket converges on GA4's answer rather than drifting.
 */
import {
	IntegrationsPersistenceError,
	IntegrationsRevokedError,
	IntegrationsUpstreamError,
	UserId as UserIdSchema,
	type OrgId,
} from "@maple/domain/http"
import {
	googleAnalyticsLedger,
	googleAnalyticsState,
	oauthConnections,
	type GoogleAnalyticsStateRow,
} from "@maple/db"
import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Database } from "@/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@/platform/db-execute"
import { Env } from "@/platform/Env"
import { msToDate } from "@/platform/time"
import type { MetricSumRow } from "@/services/warehouse/metric-rows"
import { GoogleAnalyticsOAuthService } from "@/services/auth/GoogleAnalyticsOAuthService"
import { OrgIngestKeysService } from "@/services/org/OrgIngestKeysService"
import {
	getPropertyTimeZone,
	listProperties,
	runReport,
	GA_QUOTA_STATUS,
	type GoogleAnalyticsProperty,
} from "./GoogleAnalyticsApi"
import {
	DATASETS,
	DISCOVERY_DATASET,
	DISCOVERY_PROPERTY_ID,
	type GaDatasetDef,
} from "./google-analytics/datasets"
import { mapReport } from "./google-analytics/mapping"
import { type LedgerBucket, parseLedger, reconcile, serializeLedger } from "./google-analytics/reconcile"
import { utcMsToZonedDate } from "./google-analytics/timezone"
import { metricRowsToOtlp } from "./shared/otlp"

const HOUR_MS = 3_600_000

/**
 * How long GA4 may keep revising an hour. Google documents "up to 48 hours" for full processing
 * of a standard property; everything inside this window is re-polled and reconciled.
 */
const RESTATEMENT_WINDOW_MS = 48 * HOUR_MS

/**
 * Re-polled on EVERY tick. Fresh data changes fastest, so the cheap frequent pass covers only the
 * recent tail; the expensive full-window sweep runs on {@link FULL_RECONCILE_INTERVAL_MS}.
 */
const HEAD_WINDOW_MS = 3 * HOUR_MS

/** How often the whole 48h restatement window is swept. Hourly is well inside GA4's revision pace. */
const FULL_RECONCILE_INTERVAL_MS = HOUR_MS

/** How far back a newly connected property backfills. */
const BACKFILL_FLOOR_MS = 30 * 24 * HOUR_MS

/** One backfill round per dataset per tick, so history fills in behind live data. */
const BACKFILL_ROUND_MS = 24 * HOUR_MS

/**
 * Lease held while a tick polls an org. Longer than the 15-minute cron interval would stall
 * recovery after a crash; shorter than a slow tick would let two ticks overlap.
 */
const LEASE_MS = 10 * 60_000

/**
 * Held (not cleared) after a quota rejection so the next tick skips the org instead of
 * re-depleting the property's GA4 token budget — the lesson the Cloudflare poller learned the
 * expensive way.
 */
const QUOTA_BACKOFF_MS = 30 * 60_000

/**
 * Ceiling on Data API calls per org per tick. GA4 meters tokens per property per day and per
 * hour, and a grant may cover many properties; the budget is what stops one agency-sized org from
 * spending its whole hourly allowance in a single tick.
 */
const MAX_CALLS_PER_ORG_TICK = 30

const ORG_CONCURRENCY = 3

/** Property discovery TTL. Properties are created rarely; hourly is generous. */
const DISCOVERY_TTL_MS = HOUR_MS

/** GA4 caps a report at 250k rows; 10k is ample per page and keeps responses small. */
const REPORT_ROW_LIMIT = 10_000

/**
 * Page ceiling per (property, dataset, window). A report needing more than this is not one we can
 * reconcile honestly, so the window fails rather than half-landing — see `pollWindow`.
 */
const MAX_REPORT_PAGES = 5

/** Attribution for the ingest key this collector mints on an org's behalf. */
const SYSTEM_USER_ID = Schema.decodeUnknownSync(UserIdSchema)("system-google-analytics")

const floorToHour = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS

export interface GoogleAnalyticsPropertyStatus {
	readonly propertyId: string
	readonly propertyName: string | null
	readonly accountName: string | null
	readonly timeZone: string | null
	readonly enabled: boolean
	readonly lastSyncedAt: number | null
	readonly lastError: string | null
	readonly watermarkAt: number | null
	readonly backfillAt: number | null
}

export interface GoogleAnalyticsIntegrationStatus {
	readonly connected: boolean
	readonly connectedAt: number | null
	readonly externalUserEmail: string | null
	readonly revoked: boolean
	readonly properties: ReadonlyArray<GoogleAnalyticsPropertyStatus>
}

export interface GoogleAnalyticsPollResult {
	readonly properties: number
	readonly rowsIngested: number
	readonly skipped: number
	readonly failures: number
}

interface GoogleAnalyticsServiceApi {
	/** Cron entry point: every org with a live grant, bounded concurrency. */
	readonly pollAllOrgs: () => Effect.Effect<GoogleAnalyticsPollResult>
	/** One org, used by the cron fan-out and by the post-connect prime. */
	readonly pollOrg: (orgId: OrgId) => Effect.Effect<GoogleAnalyticsPollResult>
	readonly getIntegrationStatus: (
		orgId: OrgId,
	) => Effect.Effect<GoogleAnalyticsIntegrationStatus, IntegrationsPersistenceError>
	readonly setPropertyEnabled: (
		orgId: OrgId,
		propertyId: string,
		enabled: boolean,
	) => Effect.Effect<void, IntegrationsPersistenceError>
}

/**
 * There is deliberately no `resetOrgState`, and a disconnect leaves both tables alone.
 *
 * Metrics already collected are RETAINED when an org disconnects, so the ledger is the only record
 * of what has been emitted for the hours still inside the restatement window. Dropping it and then
 * reconnecting within 48h would re-emit each of those hours in full on top of rows already in the
 * warehouse — the exact double-count the ledger exists to prevent. Dropping the state rows is worse
 * again: it resets `backfillAt`, so the 30-day backfill re-runs over hours whose ledger entries have
 * already been pruned, and every one of them double-counts with nothing left to reconcile against.
 *
 * Reconnecting with a different Google account needs no cleanup either — discovery soft-disables
 * properties the new grant cannot see, and their ledger rows age out of the restatement window.
 * Org DELETION is the case where these rows genuinely should go, and that is handled deliberately
 * by the registry in `OrganizationService` rather than here.
 */

export class GoogleAnalyticsService extends Context.Service<
	GoogleAnalyticsService,
	GoogleAnalyticsServiceApi
>()("@maple/api/services/GoogleAnalyticsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const oauth = yield* GoogleAnalyticsOAuthService
		const ingestKeys = yield* OrgIngestKeysService
		const httpClient = yield* HttpClient.HttpClient

		const toPersistenceError = makePersistenceErrorMapper(
			IntegrationsPersistenceError,
			"Google Analytics integration storage is unavailable",
		)
		const dbExecute = makeDbExecute(database, "GoogleAnalyticsService", toPersistenceError)

		const adminBaseUrl = env.MAPLE_GOOGLE_ANALYTICS_ADMIN_API_BASE_URL
		const dataBaseUrl = env.MAPLE_GOOGLE_ANALYTICS_DATA_API_BASE_URL
		const ingestMetricsUrl = `${env.MAPLE_INGEST_PUBLIC_URL.replace(/\/+$/, "")}/v1/metrics`

		// ── State access ──────────────────────────────────────────────────────

		const loadRows = (orgId: OrgId) =>
			dbExecute((db) =>
				db.select().from(googleAnalyticsState).where(eq(googleAnalyticsState.orgId, orgId)),
			)

		const rowId = (orgId: OrgId, propertyId: string, dataset: string) =>
			`${orgId}:${propertyId}:${dataset}`

		const upsertRow = (row: {
			readonly orgId: OrgId
			readonly propertyId: string
			readonly dataset: string
			readonly propertyName: string | null
			readonly accountName: string | null
			readonly now: number
		}) =>
			dbExecute((db) =>
				db
					.insert(googleAnalyticsState)
					.values({
						id: rowId(row.orgId, row.propertyId, row.dataset),
						orgId: row.orgId,
						propertyId: row.propertyId,
						dataset: row.dataset,
						propertyName: row.propertyName,
						accountName: row.accountName,
						createdAt: msToDate(row.now),
						updatedAt: msToDate(row.now),
					})
					.onConflictDoUpdate({
						target: [
							googleAnalyticsState.orgId,
							googleAnalyticsState.propertyId,
							googleAnalyticsState.dataset,
						],
						// Names refresh on every discovery, but `enabled` is deliberately NOT reset:
						// a property the user switched off must stay off across discovery passes.
						set: {
							propertyName: row.propertyName,
							accountName: row.accountName,
							updatedAt: msToDate(row.now),
						},
					}),
			)

		const patchRow = (id: string, patch: Partial<GoogleAnalyticsStateRow>) =>
			dbExecute((db) => db.update(googleAnalyticsState).set(patch).where(eq(googleAnalyticsState.id, id)))

		/**
		 * Claim the org for this tick. One conditional UPDATE across the org's rows: whoever moves
		 * `leaseUntil` past now owns the tick, and a competing tick reads zero updated rows and
		 * skips. Returns false when the org is already claimed.
		 */
		const claimLease = Effect.fn("GoogleAnalyticsService.claimLease")(function* (
			orgId: OrgId,
			now: number,
		) {
			const claimed = yield* dbExecute((db) =>
				db
					.update(googleAnalyticsState)
					.set({ leaseUntil: msToDate(now + LEASE_MS), updatedAt: msToDate(now) })
					.where(
						and(
							eq(googleAnalyticsState.orgId, orgId),
							or(isNull(googleAnalyticsState.leaseUntil), lt(googleAnalyticsState.leaseUntil, msToDate(now))),
						),
					)
					.returning({ id: googleAnalyticsState.id }),
			)
			return claimed.length > 0
		})

		const releaseLease = (orgId: OrgId, until: number | null, now: number) =>
			dbExecute((db) =>
				db
					.update(googleAnalyticsState)
					.set({ leaseUntil: until === null ? null : msToDate(until), updatedAt: msToDate(now) })
					.where(eq(googleAnalyticsState.orgId, orgId)),
			)

		const recordOrgError = (orgId: OrgId, message: string, now: number) =>
			dbExecute((db) =>
				db
					.update(googleAnalyticsState)
					.set({
						lastError: message.slice(0, 500),
						lastErrorAt: msToDate(now),
						updatedAt: msToDate(now),
					})
					.where(eq(googleAnalyticsState.orgId, orgId)),
			)

		// ── Ledger ────────────────────────────────────────────────────────────

		const loadLedger = (orgId: OrgId, propertyId: string, dataset: string, fromMs: number) =>
			dbExecute((db) =>
				db
					.select()
					.from(googleAnalyticsLedger)
					.where(
						and(
							eq(googleAnalyticsLedger.orgId, orgId),
							eq(googleAnalyticsLedger.propertyId, propertyId),
							eq(googleAnalyticsLedger.dataset, dataset),
							gte(googleAnalyticsLedger.bucketAt, msToDate(fromMs)),
						),
					),
			).pipe(
				Effect.map((rows): ReadonlyArray<LedgerBucket> =>
					rows.map((row) => ({
						bucketMs: row.bucketAt.getTime(),
						emitted: parseLedger(row.emittedJson),
					})),
				),
			)

		const saveLedger = Effect.fn("GoogleAnalyticsService.saveLedger")(function* (options: {
			readonly orgId: OrgId
			readonly propertyId: string
			readonly dataset: string
			readonly buckets: ReadonlyArray<LedgerBucket>
			readonly now: number
		}) {
			// Buckets that ended up with nothing emitted carry no information and are deleted
			// rather than stored as `{}` — otherwise a quiet property accretes a row per hour.
			const empty = options.buckets.filter((bucket) => Object.keys(bucket.emitted).length === 0)
			const populated = options.buckets.filter((bucket) => Object.keys(bucket.emitted).length > 0)

			if (populated.length > 0) {
				yield* dbExecute((db) =>
					db
						.insert(googleAnalyticsLedger)
						.values(
							populated.map((bucket) => ({
								id: `${options.orgId}:${options.propertyId}:${options.dataset}:${bucket.bucketMs}`,
								orgId: options.orgId,
								propertyId: options.propertyId,
								dataset: options.dataset,
								bucketAt: msToDate(bucket.bucketMs),
								emittedJson: serializeLedger(bucket.emitted),
								createdAt: msToDate(options.now),
								updatedAt: msToDate(options.now),
							})),
						)
						.onConflictDoUpdate({
							target: [
								googleAnalyticsLedger.orgId,
								googleAnalyticsLedger.propertyId,
								googleAnalyticsLedger.dataset,
								googleAnalyticsLedger.bucketAt,
							],
							// `excluded` is the row this statement tried to insert — the multi-row upsert
							// needs each conflict to take ITS OWN new blob, not one value for all.
							set: {
								emittedJson: sql`excluded.emitted_json`,
								updatedAt: msToDate(options.now),
							},
						}),
				)
			}

			if (empty.length > 0) {
				yield* dbExecute((db) =>
					db.delete(googleAnalyticsLedger).where(
						and(
							eq(googleAnalyticsLedger.orgId, options.orgId),
							eq(googleAnalyticsLedger.propertyId, options.propertyId),
							eq(googleAnalyticsLedger.dataset, options.dataset),
							inArray(
								googleAnalyticsLedger.bucketAt,
								empty.map((bucket) => msToDate(bucket.bucketMs)),
							),
						),
					),
				)
			}
		})

		/** Drop ledger rows for hours GA4 can no longer revise — they are settled by definition. */
		const pruneLedger = (orgId: OrgId, propertyId: string, dataset: string, frozenThroughMs: number) =>
			dbExecute((db) =>
				db
					.delete(googleAnalyticsLedger)
					.where(
						and(
							eq(googleAnalyticsLedger.orgId, orgId),
							eq(googleAnalyticsLedger.propertyId, propertyId),
							eq(googleAnalyticsLedger.dataset, dataset),
							lt(googleAnalyticsLedger.bucketAt, msToDate(frozenThroughMs)),
						),
					),
			)

		// ── Ingest ────────────────────────────────────────────────────────────

		const getOrgIngestKey = (orgId: OrgId) =>
			ingestKeys.getOrCreate(orgId, SYSTEM_USER_ID).pipe(Effect.map((keys) => keys.publicKey))

		/**
		 * Ship reconciled deltas to the ingest gateway as one OTLP/JSON request, so per-org routing
		 * (managed Tinybird vs BYO ClickHouse), schema-version gating, WAL durability and Autumn
		 * metering all apply exactly as they do for the org's own telemetry.
		 */
		const emitMetrics = Effect.fn("GoogleAnalyticsService.emitMetrics")(
			function* (ingestKey: string, rows: ReadonlyArray<MetricSumRow>) {
				if (rows.length === 0) return 0
				const request = HttpClientRequest.post(ingestMetricsUrl, {
					headers: { authorization: `Bearer ${ingestKey}`, "content-type": "application/json" },
				}).pipe(HttpClientRequest.bodyJsonUnsafe(metricRowsToOtlp(rows, [])))
				const response = yield* httpClient
					.execute(request)
					.pipe(Effect.annotateSpans("peer.service", "ingest"))
				if (response.status >= 300) {
					const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
					return yield* Effect.fail(
						new IntegrationsUpstreamError({
							message: `Google Analytics metrics ingest returned ${response.status}: ${body.slice(0, 300)}`,
							status: response.status,
						}),
					)
				}
				return rows.length
			},
			(effect) =>
				effect.pipe(
					Effect.mapError((error) =>
						error instanceof IntegrationsUpstreamError
							? error
							: new IntegrationsUpstreamError({
									message: `Google Analytics metrics ingest request failed: ${error instanceof Error ? error.message : String(error)}`,
									cause: error,
								}),
					),
				),
		)

		// ── Poll ──────────────────────────────────────────────────────────────

		/**
		 * One (property, dataset, window): fetch, map, reconcile against the ledger, ingest, then
		 * persist. The ledger is written only AFTER the gateway accepts the batch — the other order
		 * would record deltas as emitted that never landed, and those are unrecoverable.
		 */
		const pollWindow = Effect.fn("GoogleAnalyticsService.pollWindow")(function* (context: {
			readonly orgId: OrgId
			readonly row: GoogleAnalyticsStateRow
			readonly dataset: GaDatasetDef
			readonly accessToken: string
			readonly ingestKey: string
			readonly timeZone: string
			readonly fromMs: number
			readonly toMs: number
			readonly now: number
		}) {
			const { dataset, fromMs, toMs, timeZone } = context
			const startDate = utcMsToZonedDate(fromMs, timeZone)
			// GA4 date ranges are inclusive on both ends and expressed in property-local dates, so
			// the end date is the local date of the last covered instant, not of the exclusive bound.
			const endDate = utcMsToZonedDate(toMs - 1, timeZone)
			if (startDate === null || endDate === null) return 0

			// Paged to COMPLETION, and that is a correctness requirement rather than a nicety.
			// Reconciliation reads a series that is in the ledger but absent from the response as
			// "revised to zero" and retracts it. A half-fetched report would therefore retract real
			// data — and flap, re-emitting it next tick as the truncation point moved. `dateHour` ×
			// `pagePath` over a 48h window exceeds one page on any busy site, so this is reachable,
			// not theoretical.
			let response = yield* runReport({
				accessToken: context.accessToken,
				dataBaseUrl,
				propertyId: context.row.propertyId,
				request: {
					dimensions: dataset.breakdown
						? ["dateHour", dataset.breakdown.dimension]
						: ["dateHour"],
					metrics: dataset.metrics.map((metric) => metric.ga),
					startDate,
					endDate,
					limit: REPORT_ROW_LIMIT,
					// Only a breakdown has a tail to rank; the totals dataset returns one row per hour.
					orderByMetric: dataset.breakdown?.rankBy,
				},
			})
			const merged = [...(response.rows ?? [])]
			const total = response.rowCount ?? merged.length
			for (
				let page = 1;
				merged.length < total && page < MAX_REPORT_PAGES;
				page++
			) {
				const next = yield* runReport({
					accessToken: context.accessToken,
					dataBaseUrl,
					propertyId: context.row.propertyId,
					request: {
						dimensions: dataset.breakdown
							? ["dateHour", dataset.breakdown.dimension]
							: ["dateHour"],
						metrics: dataset.metrics.map((metric) => metric.ga),
						startDate,
						endDate,
						limit: REPORT_ROW_LIMIT,
						offset: merged.length,
						orderByMetric: dataset.breakdown?.rankBy,
					},
				})
				const nextRows = next.rows ?? []
				// A page that returns nothing while `rowCount` still claims more would spin the
				// loop; stop and let the incompleteness check below decide.
				if (nextRows.length === 0) break
				merged.push(...nextRows)
			}

			// Still short: emit nothing rather than retract series the report simply did not reach.
			// The frontier does not advance, so the window is retried next tick.
			if (merged.length < total) {
				return yield* Effect.fail(
					new IntegrationsUpstreamError({
						message: `Google Analytics report for ${dataset.id} returned ${merged.length} of ${total} rows after ${MAX_REPORT_PAGES} pages — refusing to reconcile a partial window`,
					}),
				)
			}
			response = { ...response, rows: merged }

			// The date range is whole property-local DAYS, so it necessarily overreaches the
			// requested hour window at both ends. Reconciliation must only judge the hours actually
			// asked about, hence the explicit covered bounds rather than the response's own extent.
			const points = mapReport({ dataset, response, timeZone })
			const ledger = yield* loadLedger(context.orgId, context.row.propertyId, dataset.id, fromMs)
			const result = reconcile({
				orgId: context.orgId,
				propertyId: context.row.propertyId,
				propertyName: context.row.propertyName,
				accountName: context.row.accountName,
				dataset,
				points,
				ledger,
				coveredFromMs: fromMs,
				coveredToMs: toMs,
			})

			const ingested = yield* emitMetrics(context.ingestKey, result.rows)
			yield* saveLedger({
				orgId: context.orgId,
				propertyId: context.row.propertyId,
				dataset: dataset.id,
				buckets: result.ledger.filter(
					(bucket) => bucket.bucketMs >= fromMs && bucket.bucketMs < toMs,
				),
				now: context.now,
			})
			return ingested
		})

		/**
		 * Property discovery, on an hourly TTL. Rows for properties that vanished are soft-disabled
		 * rather than deleted, so a property that comes back resumes from its old watermark instead
		 * of re-backfilling a month of history.
		 */
		const discoverProperties = Effect.fn("GoogleAnalyticsService.discoverProperties")(function* (
			orgId: OrgId,
			accessToken: string,
			existing: ReadonlyArray<GoogleAnalyticsStateRow>,
			now: number,
		) {
			const properties = yield* listProperties({ accessToken, adminBaseUrl })
			const live = new Set(properties.map((property) => property.propertyId))

			for (const property of properties) {
				for (const dataset of DATASETS) {
					yield* upsertRow({
						orgId,
						propertyId: property.propertyId,
						dataset: dataset.id,
						propertyName: property.propertyName,
						accountName: property.accountName,
						now,
					})
				}
			}

			const vanished = existing.filter(
				(row) =>
					row.dataset !== DISCOVERY_DATASET && row.enabled && !live.has(row.propertyId),
			)
			for (const row of vanished) {
				yield* patchRow(row.id, { enabled: false, updatedAt: msToDate(now) })
			}

			yield* dbExecute((db) =>
				db
					.insert(googleAnalyticsState)
					.values({
						id: rowId(orgId, DISCOVERY_PROPERTY_ID, DISCOVERY_DATASET),
						orgId,
						propertyId: DISCOVERY_PROPERTY_ID,
						dataset: DISCOVERY_DATASET,
						discoveredAt: msToDate(now),
						createdAt: msToDate(now),
						updatedAt: msToDate(now),
					})
					.onConflictDoUpdate({
						target: [
							googleAnalyticsState.orgId,
							googleAnalyticsState.propertyId,
							googleAnalyticsState.dataset,
						],
						set: { discoveredAt: msToDate(now), updatedAt: msToDate(now) },
					}),
			)

			return properties
		})

		/**
		 * Resolve and cache a property's reporting timezone. Without it nothing can be polled.
		 *
		 * `resolved` is the per-tick memo, and it is what makes this once per PROPERTY rather than
		 * once per property × dataset. `rows` is a snapshot taken before the loop and `patchRow`
		 * writes the database, not the snapshot — so without the memo every one of a property's six
		 * dataset rows would miss, and a newly connected property would spend six Admin API calls
		 * and thirty-six row writes resolving one timezone. The memo also holds a null, so a
		 * property whose zone cannot be resolved is asked about once per tick, not six times.
		 */
		const ensureTimeZone = Effect.fn("GoogleAnalyticsService.ensureTimeZone")(function* (
			rows: ReadonlyArray<GoogleAnalyticsStateRow>,
			resolved: Map<string, string | null>,
			accessToken: string,
			propertyId: string,
			now: number,
		) {
			const memoized = resolved.get(propertyId)
			if (memoized !== undefined) return memoized
			const known = rows.find((row) => row.propertyId === propertyId && row.timeZone != null)
			if (known?.timeZone != null) {
				resolved.set(propertyId, known.timeZone)
				return known.timeZone
			}
			const detail = yield* getPropertyTimeZone({ accessToken, adminBaseUrl, propertyId })
			resolved.set(propertyId, detail.timeZone)
			if (detail.timeZone === null) return null
			for (const row of rows.filter((candidate) => candidate.propertyId === propertyId)) {
				yield* patchRow(row.id, { timeZone: detail.timeZone, updatedAt: msToDate(now) })
			}
			return detail.timeZone
		})

		/**
		 * Which failures end the whole tick rather than just this window.
		 *
		 * A dead grant and an exhausted quota are properties of the CONNECTION, not of one report:
		 * grinding through the remaining (property, dataset) pairs would produce the identical
		 * failure each time, and in the quota case would spend the org's remaining GA4 budget doing
		 * it. Everything else is local — a malformed report for one dataset says nothing about the
		 * next — so it is recorded and the loop continues with that window's frontier untouched.
		 */
		const isConnectionFatal = (error: unknown) =>
			error instanceof IntegrationsRevokedError ||
			(error instanceof IntegrationsUpstreamError && error.status === GA_QUOTA_STATUS)

		/**
		 * Per-window recovery: re-raise the connection-fatal failures so `pollOrgSafely` can stamp
		 * the grant or start a quota backoff, and turn everything else into `null` after recording
		 * it on the row. Swallowing all of them — the obvious `Effect.option` — is what would let a
		 * dead grant retry forever, silently, on every tick.
		 */
		const recoverWindow =
			(stateRowId: string, now: number) =>
			<R>(
				effect: Effect.Effect<number, IntegrationsUpstreamError | IntegrationsRevokedError | IntegrationsPersistenceError, R>,
			) =>
				effect.pipe(
					Effect.catch((error) =>
						isConnectionFatal(error)
							? Effect.fail(error)
							: patchRow(stateRowId, {
									lastError: String(error instanceof Error ? error.message : error).slice(0, 500),
									lastErrorAt: msToDate(now),
									updatedAt: msToDate(now),
								}).pipe(
									Effect.ignore,
									Effect.as(null),
								),
					),
				)

		const pollOrg = Effect.fn("GoogleAnalyticsService.pollOrg")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const now = yield* Clock.currentTimeMillis
			let rowsIngested = 0
			let failures = 0
			let skipped = 0
			const seenProperties = new Set<string>()

			const claimed = yield* claimLease(orgId, now)
			// A brand-new connection has no rows yet, so nothing to claim — discovery below creates
			// them. Only an org that HAS rows and failed to claim is genuinely busy.
			const existingBefore = yield* loadRows(orgId)
			if (!claimed && existingBefore.length > 0) {
				return { properties: 0, rowsIngested: 0, skipped: 1, failures: 0 }
			}

			const { accessToken } = yield* oauth.getValidAccessToken(orgId)
			const ingestKey = yield* getOrgIngestKey(orgId)

			const anchor = existingBefore.find((row) => row.dataset === DISCOVERY_DATASET)
			const discoveryDue =
				anchor?.discoveredAt == null || now - anchor.discoveredAt.getTime() >= DISCOVERY_TTL_MS
			let properties: ReadonlyArray<GoogleAnalyticsProperty> = []
			if (discoveryDue) {
				properties = yield* discoverProperties(orgId, accessToken, existingBefore, now)
			}

			const rows = yield* loadRows(orgId)
			const pollable = rows.filter((row) => row.dataset !== DISCOVERY_DATASET && row.enabled)

			/** Per-tick timezone memo — see `ensureTimeZone`. */
			const timeZones = new Map<string, string | null>()

			// Budget is shared across the org's properties: GA4 meters per property, but a grant
			// covering 200 of them would still blow through a tick's wall-clock and the gateway's
			// patience without a ceiling here.
			let calls = 0

			for (const row of pollable) {
				if (calls >= MAX_CALLS_PER_ORG_TICK) {
					skipped += 1
					continue
				}
				const dataset = DATASETS.find((candidate) => candidate.id === row.dataset)
				if (dataset === undefined) continue

				const timeZone = yield* ensureTimeZone(rows, timeZones, accessToken, row.propertyId, now)
				if (timeZone === null) {
					skipped += 1
					continue
				}
				seenProperties.add(row.propertyId)

				const frozenThrough = floorToHour(now - RESTATEMENT_WINDOW_MS)
				const head = floorToHour(now) + HOUR_MS
				const fullSweepDue =
					row.lastSuccessAt == null || now - row.lastSuccessAt.getTime() >= FULL_RECONCILE_INTERVAL_MS
				const from = Math.max(frozenThrough, head - (fullSweepDue ? RESTATEMENT_WINDOW_MS : HEAD_WINDOW_MS))

				calls += 1
				const ingested = yield* pollWindow({
					orgId,
					row,
					dataset,
					accessToken,
					ingestKey,
					timeZone,
					fromMs: from,
					toMs: head,
					now,
				}).pipe(recoverWindow(row.id, now))

				if (ingested === null) {
					failures += 1
					continue
				}
				rowsIngested += ingested

				yield* patchRow(row.id, {
					watermarkAt: msToDate(head),
					frozenThroughAt: msToDate(frozenThrough),
					backfillAt: row.backfillAt ?? msToDate(from),
					lastSuccessAt: msToDate(now),
					lastError: null,
					lastErrorAt: null,
					updatedAt: msToDate(now),
				})
				yield* pruneLedger(orgId, row.propertyId, dataset.id, frozenThrough)

				// History fills in behind live data, one round per dataset per tick, and only from
				// hours GA4 can no longer revise — a backfilled hour needs no ledger entry.
				const backfillTo = row.backfillAt?.getTime() ?? from
				const floor = floorToHour(now - BACKFILL_FLOOR_MS)
				if (backfillTo > floor && calls < MAX_CALLS_PER_ORG_TICK) {
					const backfillFrom = Math.max(floor, backfillTo - BACKFILL_ROUND_MS)
					calls += 1
					const backfilled = yield* pollWindow({
						orgId,
						row,
						dataset,
						accessToken,
						ingestKey,
						timeZone,
						fromMs: backfillFrom,
						toMs: backfillTo,
						now,
					}).pipe(recoverWindow(row.id, now))
					if (backfilled !== null) {
						rowsIngested += backfilled
						yield* patchRow(row.id, {
							backfillAt: msToDate(backfillFrom),
							updatedAt: msToDate(now),
						})
					}
				}
			}

			return {
				properties: seenProperties.size || properties.length,
				rowsIngested,
				skipped,
				failures,
			}
		})

		/**
		 * Wrap one org's poll with the outcomes the cron cares about. A revoked grant stamps the
		 * connection and stops; a quota rejection holds the lease through a backoff; anything else
		 * is recorded and retried next tick with the frontiers untouched.
		 */
		const FAILED_TICK: GoogleAnalyticsPollResult = {
			properties: 0,
			rowsIngested: 0,
			skipped: 0,
			failures: 1,
		}

		const pollOrgSafely = (orgId: OrgId): Effect.Effect<GoogleAnalyticsPollResult> =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				// Branch on the error VALUE, not on `catchTags`: these failures carry namespaced tags
				// ("@maple/http/errors/IntegrationsRevokedError"), so a tag-keyed catch silently
				// matches nothing and every case falls through to the generic handler.
				return yield* pollOrg(orgId).pipe(
					Effect.catch((error) =>
						Effect.gen(function* () {
							if (error instanceof IntegrationsRevokedError) {
								yield* oauth.markConnectionRevoked(orgId)
								yield* recordOrgError(orgId, error.message, now).pipe(Effect.ignore)
								return FAILED_TICK
							}
							if (error instanceof IntegrationsUpstreamError) {
								yield* recordOrgError(orgId, error.message, now).pipe(Effect.ignore)
								if (error.status === GA_QUOTA_STATUS) {
									// Hold the lease rather than clearing it, so the next tick skips this
									// org instead of spending the rest of its GA4 budget.
									yield* releaseLease(orgId, now + QUOTA_BACKOFF_MS, now).pipe(Effect.ignore)
								}
								return FAILED_TICK
							}
							yield* recordOrgError(orgId, String(error), now).pipe(Effect.ignore)
							return FAILED_TICK
						}),
					),
					Effect.catchCause((cause) =>
						Effect.logError("Google Analytics poll failed", cause).pipe(Effect.as(FAILED_TICK)),
					),
				)
			}).pipe(
				// The lease is only cleared on a clean finish. A quota backoff has already set its
				// own future lease above, and `ensuring` must not undo it.
				Effect.tap((result) =>
					result.failures === 0
						? Clock.currentTimeMillis.pipe(
								Effect.flatMap((now) => releaseLease(orgId, null, now)),
								Effect.ignore,
							)
						: Effect.void,
				),
			)

		const pollAllOrgs = Effect.fn("GoogleAnalyticsService.pollAllOrgs")(function* () {
			const connections = yield* dbExecute((db) =>
				db
					.select({ orgId: oauthConnections.orgId })
					.from(oauthConnections)
					.where(
						and(
							eq(oauthConnections.provider, "google_analytics"),
							isNull(oauthConnections.revokedAt),
						),
					),
			).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<{ orgId: OrgId }>))

			const results = yield* Effect.forEach(connections, (connection) => pollOrgSafely(connection.orgId), {
				concurrency: ORG_CONCURRENCY,
			})

			return results.reduce<GoogleAnalyticsPollResult>(
				(total, result) => ({
					properties: total.properties + result.properties,
					rowsIngested: total.rowsIngested + result.rowsIngested,
					skipped: total.skipped + result.skipped,
					failures: total.failures + result.failures,
				}),
				{ properties: 0, rowsIngested: 0, skipped: 0, failures: 0 },
			)
		})

		// ── Read surface ──────────────────────────────────────────────────────

		const getIntegrationStatus = Effect.fn("GoogleAnalyticsService.getIntegrationStatus")(
			function* (orgId: OrgId) {
				// A status read must never 500 because the connection row is unreadable: the card
				// then shows "not connected", which is the honest answer from the caller's side.
				const connection = yield* oauth.getStatus(orgId).pipe(
					Effect.orElseSucceed(() => ({
						connected: false,
						connectedAt: null,
						externalUserEmail: null,
						connectedByUserId: null,
						scope: "",
						revoked: false,
					})),
				)
				const rows = yield* loadRows(orgId)

				// One status entry per PROPERTY, not per row: the datasets are an implementation
				// detail, so the property's health is the worst of its datasets and its progress the
				// least advanced of them.
				const byProperty = new Map<string, Array<GoogleAnalyticsStateRow>>()
				for (const row of rows) {
					if (row.dataset === DISCOVERY_DATASET) continue
					const group = byProperty.get(row.propertyId)
					if (group === undefined) byProperty.set(row.propertyId, [row])
					else group.push(row)
				}

				const properties = [...byProperty.entries()]
					.map(([propertyId, group]): GoogleAnalyticsPropertyStatus => {
						const withError = group.find((row) => row.lastError != null)
						const oldest = (pick: (row: GoogleAnalyticsStateRow) => Date | null) =>
							group
								.map(pick)
								.filter((value): value is Date => value != null)
								.reduce<number | null>(
									(min, value) => (min === null ? value.getTime() : Math.min(min, value.getTime())),
									null,
								)
						return {
							propertyId,
							propertyName: group[0]?.propertyName ?? null,
							accountName: group[0]?.accountName ?? null,
							timeZone: group[0]?.timeZone ?? null,
							enabled: group.some((row) => row.enabled),
							lastSyncedAt: oldest((row) => row.lastSuccessAt),
							lastError: withError?.lastError ?? null,
							watermarkAt: oldest((row) => row.watermarkAt),
							backfillAt: oldest((row) => row.backfillAt),
						}
					})
					.sort((a, b) => a.propertyId.localeCompare(b.propertyId))

				return {
					connected: connection.connected,
					connectedAt: connection.connectedAt,
					externalUserEmail: connection.externalUserEmail,
					revoked: connection.revoked,
					properties,
				} satisfies GoogleAnalyticsIntegrationStatus
			},
		)

		const setPropertyEnabled = Effect.fn("GoogleAnalyticsService.setPropertyEnabled")(function* (
			orgId: OrgId,
			propertyId: string,
			enabled: boolean,
		) {
			const now = yield* Clock.currentTimeMillis
			yield* dbExecute((db) =>
				db
					.update(googleAnalyticsState)
					.set({ enabled, updatedAt: msToDate(now) })
					.where(
						and(
							eq(googleAnalyticsState.orgId, orgId),
							eq(googleAnalyticsState.propertyId, propertyId),
						),
					),
			)
		})

		return {
			pollAllOrgs,
			pollOrg: (orgId: OrgId) => pollOrgSafely(orgId),
			getIntegrationStatus,
			setPropertyEnabled,
		} satisfies GoogleAnalyticsServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
