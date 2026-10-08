/**
 * Google Cloud metrics and resource poller. On each alerting tick it reads the curated Cloud
 * Monitoring metrics (`@maple/domain/gcp-metrics`) of every connector that has metrics enabled
 * and ships them to the ingest gateway as OTLP, so routing, metering and durability are the
 * gateway's. Hourly it also syncs the connector's resource inventory into `gcp_resources`.
 *
 * A connector covers one scope: a project, a folder or an organization. Both APIs are queried at
 * that scope, so a poll costs about one call per curated metric however many projects it holds.
 * Maple signs in as its own service account once per tick, then mints a short-lived token for
 * each connector's reader account (the one the setup script created).
 *
 * Work per tick is bounded: connectors are taken least recently polled first, at most
 * {@link MAX_CONNECTORS_PER_ORG_TICK} per organization, until a budget runs out. One that waits
 * covers a longer window next time. A poll that reaches its own budget keeps what it read and
 * moves on, and a metric query that fails twice is skipped for that window. The watermark stays
 * only when nothing was shipped (no access, out of quota, nothing readable) or storing failed, so
 * a window is ingested twice only if a poll dies between a flush and the watermark write.
 */
import { GCP_METRIC_GROUPS } from "@maple/domain/gcp-metrics"
import { IntegrationsPersistenceError, UserId } from "@maple/domain/http"
import type { OrgId } from "@maple/domain/primitives"
import { gcpConnectors, gcpResources, type GcpConnectorRow } from "@maple/db"
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm"
import { Cause, Clock, Context, Duration, Effect, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { Env } from "@maple/backend/platform/Env"
import { dateToMs, msToDate } from "@maple/backend/platform/time"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { metricRowsToOtlp } from "./cloudflare-analytics/otlp"
import {
	fetchMapleAccessToken,
	GcpApiError,
	importServiceAccountKey,
	impersonateReader,
	listTimeSeriesPage,
	searchResourcesPage,
	type GcpReader,
	type GcpTimeSeriesQuery,
} from "./gcp/api"
import { mapGcpResource, mapGcpTimeSeries, type GcpMetricRows } from "./gcp/mapping"

const MINUTE_MS = 60_000
/** The curated metrics document up to 240 s between a sample and its visibility. */
const INGESTION_LAG_MS = 5 * MINUTE_MS
/** How far back the first poll starts, and the most one poll catches up. */
const MAX_WINDOW_MS = 60 * MINUTE_MS
/**
 * A tick must finish inside its lease. No connector starts after the tick budget, a poll stops
 * reading at its own budget and is cut off at the timeout, so the last one ends 3.5 minutes in.
 */
const LEASE_MS = 4 * MINUTE_MS
const TICK_BUDGET_MS = 1.5 * MINUTE_MS
const POLL_BUDGET_MS = MINUTE_MS
const CONNECTOR_TIMEOUT = Duration.minutes(2)
const INGEST_TIMEOUT = Duration.seconds(30)
const RESOURCE_SYNC_TIMEOUT = Duration.seconds(30)
/** The alerting Worker gets 10,000 subrequests per invocation, shared with the other ticks. */
const MAX_CALLS_PER_TICK = 3_000
/** Read caps, sized so a tick's decoding and re-encoding stays a few CPU seconds of the cron's 30. */
export const MAX_PAGES_PER_METRIC = 10
const MAX_POINTS_PER_POLL = 100_000
const MAX_POINTS_PER_TICK = 300_000
const MAX_CONNECTORS_PER_ORG_TICK = 10
const CONNECTOR_CONCURRENCY = 3
/** Rows buffered per connector before they are shipped. */
const FLUSH_ROWS = 5_000
/** An organization over its plan limit is not read again for this long. */
const BILLING_HOLD_MS = 60 * MINUTE_MS
const RESOURCE_SYNC_INTERVAL_MS = 60 * MINUTE_MS
/** 500 resources per page. */
export const MAX_RESOURCE_PAGES = 20

const METRICS = GCP_METRIC_GROUPS.flatMap((group) => group.metrics.map((metric) => ({ group, metric })))

const SYSTEM_USER_ID = Schema.decodeUnknownSync(UserId)("system-gcp-metrics")

const SETUP_HINT =
	"Run the setup script in Cloud Shell to grant Maple read access; if it already ran, wait a few minutes for the grant to apply."

const describeApiError = (error: GcpApiError) =>
	error.kind === "denied" || error.kind === "not_found" ? `${error.message}. ${SETUP_HINT}` : error.message

const toPersistenceError = makePersistenceErrorMapper(
	IntegrationsPersistenceError,
	"Google Cloud metrics database error",
)

class GcpMetricsIngestError extends Schema.TaggedError<GcpMetricsIngestError>()(
	"@maple/api/integrations/GcpMetricsIngestError",
	{ message: Schema.String, status: Schema.optionalKey(Schema.Number) },
) {}

/** Next window for a connector, on minute boundaries, or null when it is caught up. */
export const nextWindow = (watermarkAt: Date | null, now: number) => {
	const horizonMs = now - INGESTION_LAG_MS - ((now - INGESTION_LAG_MS) % MINUTE_MS)
	const startMs = watermarkAt === null ? horizonMs - MAX_WINDOW_MS : dateToMs(watermarkAt)
	// Cap the end, not the start: a long gap catches up one window per poll instead of being skipped.
	const endMs = Math.min(horizonMs, startMs + MAX_WINDOW_MS)
	return startMs < endMs ? { startMs, endMs } : null
}

export interface GcpMetricsPollSummary {
	/** Connectors polled this tick. */
	readonly polled: number
	/** Due connectors left for a later tick: over a cap or budget, or claimed by an overlapping tick. */
	readonly deferred: number
	readonly rowsIngested: number
	readonly failures: number
	/** Metric queries cut short or left unread at a per-poll budget. */
	readonly incompleteMetrics: number
	readonly calls: number
}

const IDLE: GcpMetricsPollSummary = {
	polled: 0,
	deferred: 0,
	rowsIngested: 0,
	failures: 0,
	incompleteMetrics: 0,
	calls: 0,
}

interface Tick {
	readonly now: number
	/** Counts every outbound request into `budget`. */
	readonly httpClient: HttpClient.HttpClient
	readonly mapleToken: Redacted.Redacted<string>
	readonly budget: { calls: number; points: number }
}

interface ConnectorOutcome {
	readonly rowsIngested: number
	readonly failed: boolean
	readonly incompleteMetrics: number
}

export interface GcpMetricsServiceApi {
	/** No-op unless `MAPLE_GCP_SERVICE_ACCOUNT_KEY` is set. */
	readonly pollAll: () => Effect.Effect<GcpMetricsPollSummary, IntegrationsPersistenceError | GcpApiError>
}

export class GcpMetricsService extends Context.Service<GcpMetricsService, GcpMetricsServiceApi>()(
	"@maple/api/services/GcpMetricsService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const baseHttpClient = yield* HttpClient.HttpClient
			const ingestKeys = yield* OrgIngestKeysService
			const ingestMetricsUrl = `${env.MAPLE_INGEST_PUBLIC_URL.replace(/\/+$/, "")}/v1/metrics`
			const dbExecute = makeDbExecute(database, "GcpMetricsService", toPersistenceError)

			const updateConnector = (
				id: GcpConnectorRow["id"],
				set: Partial<typeof gcpConnectors.$inferInsert>,
			) => dbExecute((db) => db.update(gcpConnectors).set(set).where(eq(gcpConnectors.id, id)))

			/** A failed poll leaves the watermark alone and says why on the connector. */
			const recordFailure = Effect.fnUntraced(function* (
				connector: GcpConnectorRow,
				now: number,
				message: string,
				holdMs?: number,
			) {
				yield* Effect.annotateCurrentSpan({ "maple.gcp.poll_failed": true })
				yield* Effect.logWarning("gcp connector poll failed", {
					orgId: connector.orgId,
					connectorId: connector.id,
					error: message,
				})
				yield* updateConnector(connector.id, {
					lastMetricsError: message,
					...(holdMs === undefined ? undefined : { metricsLeaseUntil: msToDate(now + holdMs) }),
				})
				return { rowsIngested: 0, failed: true, incompleteMetrics: 0 } satisfies ConnectorOutcome
			})

			const emitMetrics = Effect.fnUntraced(
				function* (httpClient: HttpClient.HttpClient, ingestKey: string, rows: GcpMetricRows) {
					const total = rows.sumRows.length + rows.gaugeRows.length
					if (total === 0) return 0
					const response = yield* httpClient
						.execute(
							HttpClientRequest.post(ingestMetricsUrl).pipe(
								HttpClientRequest.bearerToken(ingestKey),
								HttpClientRequest.bodyJsonUnsafe(
									metricRowsToOtlp(rows.sumRows, rows.gaugeRows),
								),
							),
						)
						.pipe(
							Effect.annotateSpans("peer.service", "ingest"),
							Effect.mapError(
								() => new GcpMetricsIngestError({ message: "Metrics ingest request failed" }),
							),
						)
					if (response.status >= 300) {
						return yield* new GcpMetricsIngestError({
							message: `Metrics ingest returned ${response.status}`,
							status: response.status,
						})
					}
					return total
				},
				Effect.timeoutOrElse({
					duration: INGEST_TIMEOUT,
					orElse: () =>
						Effect.fail(new GcpMetricsIngestError({ message: "Metrics ingest timed out" })),
				}),
			)

			/**
			 * Replace the connector's inventory with what the scope holds now. Returns why it is
			 * incomplete, or null. Rows the sync did not return are removed only once every page
			 * was read.
			 */
			const syncResources = Effect.fnUntraced(function* (
				connector: GcpConnectorRow,
				tick: Tick,
				scope: string,
				reader: GcpReader,
			) {
				const lastSeenAt = msToDate(tick.now)
				let pageToken: string | undefined
				for (let page = 0; page < MAX_RESOURCE_PAGES; page++) {
					const body = yield* searchResourcesPage(tick.httpClient, reader, scope, pageToken)
					// Keyed by name: one statement cannot upsert the same row twice.
					const rows = new Map(
						(body.results ?? []).flatMap((result) => {
							const resource = mapGcpResource(result)
							return resource === undefined ? [] : [[resource.name, resource] as const]
						}),
					)
					if (rows.size > 0) {
						yield* dbExecute((db) =>
							db
								.insert(gcpResources)
								.values(
									[...rows.values()].map((resource) => ({
										...resource,
										connectorId: connector.id,
										orgId: connector.orgId,
										lastSeenAt,
									})),
								)
								.onConflictDoUpdate({
									target: [gcpResources.connectorId, gcpResources.name],
									set: {
										assetType: sql`excluded.asset_type`,
										projectId: sql`excluded.project_id`,
										location: sql`excluded.location`,
										displayName: sql`excluded.display_name`,
										state: sql`excluded.state`,
										labels: sql`excluded.labels`,
										resourceCreatedAt: sql`excluded.resource_created_at`,
										resourceUpdatedAt: sql`excluded.resource_updated_at`,
										lastSeenAt: sql`excluded.last_seen_at`,
									},
								}),
						)
					}
					pageToken = body.nextPageToken
					if (pageToken === undefined) {
						yield* dbExecute((db) =>
							db
								.delete(gcpResources)
								.where(
									and(
										eq(gcpResources.connectorId, connector.id),
										lt(gcpResources.lastSeenAt, lastSeenAt),
									),
								),
						)
						return null
					}
				}
				return `The scope holds more than ${MAX_RESOURCE_PAGES * 500} resources; the inventory is incomplete.`
			})

			/**
			 * The connector's inventory sync, as the columns to write. It has its own outcome: a
			 * sync that is denied or cannot be stored is retried next tick, one that runs out of
			 * pages or time waits for the next hour, and none of them holds the metrics back.
			 */
			const resourceSyncOutcome = (
				connector: GcpConnectorRow,
				tick: Tick,
				scope: string,
				reader: GcpReader,
			) =>
				syncResources(connector, tick, scope, reader).pipe(
					Effect.timeoutOrElse({
						duration: RESOURCE_SYNC_TIMEOUT,
						orElse: () => Effect.succeed("The inventory sync ran out of time; it is incomplete."),
					}),
					Effect.map((note) => ({
						lastResourcesError: note,
						resourcesSyncedAt: msToDate(tick.now),
					})),
					Effect.catchTags({
						"@maple/api/integrations/GcpApiError": (error) =>
							Effect.succeed({ lastResourcesError: describeApiError(error) }),
						"@maple/http/errors/IntegrationsPersistenceError": () =>
							Effect.succeed({ lastResourcesError: "Maple could not store the inventory." }),
					}),
				)

			/**
			 * One connector: its inventory sync when due, then its metrics window. Fails when the
			 * window could not be read or stored at all.
			 */
			const pollConnector = Effect.fn("GcpMetricsService.pollConnector")(
				function* (connector: GcpConnectorRow, tick: Tick) {
					// The id is validated when the connector is created; encoding keeps it inside the path.
					const scope = `${connector.scopeType}s/${encodeURIComponent(connector.scopeId)}`
					yield* Effect.annotateCurrentSpan({
						orgId: connector.orgId,
						"maple.gcp.connector_id": connector.id,
						"maple.gcp.scope": scope,
					})
					const idle: ConnectorOutcome = { rowsIngested: 0, failed: false, incompleteMetrics: 0 }
					const window = nextWindow(connector.metricsWatermarkAt, tick.now)
					const resourcesDue =
						connector.resourcesSyncedAt === null ||
						tick.now - dateToMs(connector.resourcesSyncedAt) >= RESOURCE_SYNC_INTERVAL_MS
					if (window === null && !resourcesDue) return idle
					const startedAt = yield* Clock.currentTimeMillis
					const outOfTime = Effect.map(
						Clock.currentTimeMillis,
						(time) => time - startedAt >= POLL_BUDGET_MS,
					)
					const reader = yield* impersonateReader(tick.httpClient, tick.mapleToken, connector)

					if (resourcesDue) {
						yield* updateConnector(
							connector.id,
							yield* resourceSyncOutcome(connector, tick, scope, reader),
						)
					}
					if (window === null) return idle
					const ingestKey = (yield* ingestKeys.getOrCreate(connector.orgId, SYSTEM_USER_ID))
						.publicKey

					let buffer: GcpMetricRows = { sumRows: [], gaugeRows: [] }
					let rowsIngested = 0
					let points = 0
					/** One metric, page by page; false when pages were left unread. */
					const readMetric = Effect.fnUntraced(function* (query: GcpTimeSeriesQuery) {
						let pageToken: string | undefined
						for (let page = 0; page < MAX_PAGES_PER_METRIC; page++) {
							if (page > 0 && (yield* outOfTime)) return false
							const body = yield* listTimeSeriesPage(
								tick.httpClient,
								reader,
								query,
								pageToken,
							).pipe(
								// One more try rides out a blip; a query that keeps failing is skipped.
								Effect.retry({ times: 1, while: (error) => error.kind === "upstream" }),
							)
							const series = body.timeSeries ?? []
							const read = series.reduce((sum, item) => sum + (item.points?.length ?? 0), 0)
							points += read
							tick.budget.points += read
							const rows = mapGcpTimeSeries(query, series)
							buffer.sumRows.push(...rows.sumRows)
							buffer.gaugeRows.push(...rows.gaugeRows)
							if (buffer.sumRows.length + buffer.gaugeRows.length >= FLUSH_ROWS) {
								rowsIngested += yield* emitMetrics(tick.httpClient, ingestKey, buffer)
								buffer = { sumRows: [], gaugeRows: [] }
							}
							pageToken = body.nextPageToken
							if (pageToken === undefined) return true
						}
						return false
					})

					/** Queries read to the end, cut short at a budget, and not started because of one. */
					let complete = 0
					let partial = 0
					let skipped = 0
					let firstFailure: { readonly type: string; readonly error: GcpApiError } | undefined
					for (const { group, metric } of METRICS) {
						if (points >= MAX_POINTS_PER_POLL || (yield* outOfTime)) {
							skipped += 1
							continue
						}
						const result = yield* readMetric({ scope, group, metric, ...window }).pipe(
							Effect.catchTag("@maple/api/integrations/GcpApiError", (error) =>
								Effect.succeed(error),
							),
						)
						if (result === true) {
							complete += 1
						} else if (result === false) {
							partial += 1
						} else {
							firstFailure ??= { type: metric.type, error: result }
							if (result.kind === "denied" || result.kind === "rate_limited") {
								// Every remaining query would fail the same way. With nothing
								// shipped yet, the next poll repeats the whole window instead.
								if (rowsIngested === 0) return yield* result
								break
							}
						}
					}
					// No query returned anything: the window is left for the next poll.
					if (complete + partial === 0) {
						return yield* (
							firstFailure?.error ??
								new GcpApiError({
									message: "Reading the metrics took too long",
									kind: "upstream",
								})
						)
					}
					rowsIngested += yield* emitMetrics(tick.httpClient, ingestKey, buffer)

					const incomplete = partial + skipped
					const failed = METRICS.length - complete - incomplete
					const notes = [
						...(firstFailure === undefined
							? []
							: [
									`${failed} of ${METRICS.length} metric queries failed. First: ${firstFailure.type}: ${firstFailure.error.message}.`,
								]),
						...(incomplete === 0
							? []
							: [
									`${incomplete} of ${METRICS.length} metric queries held more than one poll reads; connect folders or projects separately to collect all of it.`,
								]),
					]
					if (incomplete > 0) {
						yield* Effect.logWarning("gcp connector poll reached a read budget", {
							orgId: connector.orgId,
							connectorId: connector.id,
							incompleteMetrics: incomplete,
							points,
						})
					}
					yield* updateConnector(connector.id, {
						metricsWatermarkAt: msToDate(window.endMs),
						lastMetricsReceivedAt: msToDate(tick.now),
						lastMetricsError: notes.length === 0 ? null : notes.join(" "),
					})
					yield* Effect.annotateCurrentSpan({
						"maple.gcp.rows_ingested": rowsIngested,
						"maple.gcp.points_read": points,
						"maple.gcp.metric_queries_failed": failed,
						"maple.gcp.metric_queries_incomplete": incomplete,
					})
					return {
						rowsIngested,
						failed: false,
						incompleteMetrics: incomplete,
					} satisfies ConnectorOutcome
				},
				// Handled inside the span: a scope that is not set up, or an organization over its
				// plan limit, is a recorded state, not an exception on Maple's own traces.
				(effect, connector, tick) =>
					effect.pipe(
						Effect.timeoutOrElse({
							duration: CONNECTOR_TIMEOUT,
							orElse: () =>
								recordFailure(
									connector,
									tick.now,
									"Reading the metrics took too long. Maple retries on the next poll.",
								),
						}),
						Effect.catchTags({
							"@maple/api/integrations/GcpApiError": (error) =>
								recordFailure(connector, tick.now, describeApiError(error)),
							"@maple/api/integrations/GcpMetricsIngestError": (error) =>
								error.status === 402
									? recordFailure(
											connector,
											tick.now,
											"Metrics are paused: this organization is over its plan limit.",
											BILLING_HOLD_MS,
										)
									: recordFailure(connector, tick.now, error.message),
						}),
					),
			)

			const pollAll = Effect.fn("GcpMetricsService.pollAll")(function* () {
				const encodedKey = env.MAPLE_GCP_SERVICE_ACCOUNT_KEY
				if (Option.isNone(encodedKey)) return IDLE
				const now = yield* Clock.currentTimeMillis
				const isDue = and(
					eq(gcpConnectors.metricsEnabled, true),
					or(
						isNull(gcpConnectors.metricsLeaseUntil),
						lt(gcpConnectors.metricsLeaseUntil, msToDate(now)),
					),
				)
				// Two short columns per connector; the per-organization cap is applied below.
				const due = yield* dbExecute((db) =>
					db
						.select({ id: gcpConnectors.id, orgId: gcpConnectors.orgId })
						.from(gcpConnectors)
						.where(isDue)
						.orderBy(
							sql`${gcpConnectors.metricsLeaseUntil} asc nulls first`,
							asc(gcpConnectors.id),
						),
				)
				const takenPerOrg = new Map<OrgId, number>()
				const candidates = due.filter((row) => {
					const taken = takenPerOrg.get(row.orgId) ?? 0
					takenPerOrg.set(row.orgId, taken + 1)
					return taken < MAX_CONNECTORS_PER_ORG_TICK
				})
				if (candidates.length === 0) return IDLE

				const budget = { calls: 0, points: 0 }
				const httpClient = baseHttpClient.pipe(
					HttpClient.tapRequest(() =>
						Effect.sync(() => {
							budget.calls += 1
						}),
					),
				)
				const signer = yield* importServiceAccountKey(encodedKey.value)
				const tick: Tick = {
					now,
					httpClient,
					mapleToken: yield* fetchMapleAccessToken(httpClient, signer, now),
					budget,
				}

				const outcomes = yield* Effect.forEach(
					candidates,
					(candidate) =>
						Effect.gen(function* () {
							if (
								budget.calls >= MAX_CALLS_PER_TICK ||
								budget.points >= MAX_POINTS_PER_TICK ||
								(yield* Clock.currentTimeMillis) - now >= TICK_BUDGET_MS
							) {
								return null
							}
							const [connector] = yield* dbExecute((db) =>
								db
									.update(gcpConnectors)
									.set({ metricsLeaseUntil: msToDate(now + LEASE_MS) })
									.where(and(eq(gcpConnectors.id, candidate.id), isDue))
									.returning(),
							)
							return connector === undefined ? null : yield* pollConnector(connector, tick)
						}).pipe(
							// One connector's database or ingest-key failure must not fail the tick.
							Effect.catchCause((cause) =>
								Cause.hasInterruptsOnly(cause)
									? Effect.interrupt
									: Effect.logWarning("gcp connector poll failed", {
											orgId: candidate.orgId,
											connectorId: candidate.id,
											error: summarizeCause(cause),
										}).pipe(
											Effect.as<ConnectorOutcome>({
												rowsIngested: 0,
												failed: true,
												incompleteMetrics: 0,
											}),
										),
							),
						),
					{ concurrency: CONNECTOR_CONCURRENCY },
				)
				const polled = outcomes.filter((outcome) => outcome !== null)
				return {
					polled: polled.length,
					deferred: due.length - polled.length,
					rowsIngested: polled.reduce((sum, outcome) => sum + outcome.rowsIngested, 0),
					failures: polled.filter((outcome) => outcome.failed).length,
					incompleteMetrics: polled.reduce((sum, outcome) => sum + outcome.incompleteMetrics, 0),
					calls: budget.calls,
				} satisfies GcpMetricsPollSummary
			})

			return { pollAll } satisfies GcpMetricsServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(OrgIngestKeysService.layer),
	)
}
