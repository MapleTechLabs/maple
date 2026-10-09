/**
 * Google Cloud metrics and resource poller. Each alerting tick reads the curated Cloud Monitoring
 * metrics (`@maple/domain/gcp-metrics`) of every connector with metrics enabled, at the
 * connector's scope (project, folder or organization), and ships them to the ingest gateway as
 * OTLP. Hourly it also syncs the scope's resource inventory into `gcp_resources`.
 *
 * Work per tick is bounded: connectors are taken least recently polled first, a few per
 * organization, until the tick's call or time budget runs out. A window is read again only when
 * nothing of it was ingested; the exceptions are an ingest failure and the hard timeout, which
 * repeat what a poll had already flushed.
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
	RESOURCE_PAGE_SIZE,
	searchResourcesPage,
	type GcpReader,
	type GcpTimeSeriesQuery,
} from "./gcp/api"
import { mapGcpResource, mapGcpTimeSeries, type GcpMetricRows } from "./gcp/mapping"

const MINUTE_MS = 60_000
const TICK_MS = 5 * MINUTE_MS
/** The curated metrics document up to 240 s between a sample and its visibility. */
const INGESTION_LAG_MS = 5 * MINUTE_MS
/** The oldest data a poll reads: where the first one starts, and one after a long pause. */
const MAX_WINDOW_MS = 60 * MINUTE_MS
/**
 * A tick must finish inside its lease: no connector starts after the tick budget, a poll stops
 * reading at its own, and the timeout cuts off one that stalls 3.5 minutes in at the latest.
 */
const LEASE_MS = 4 * MINUTE_MS
const TICK_BUDGET_MS = 1.5 * MINUTE_MS
const POLL_BUDGET_MS = MINUTE_MS
const CONNECTOR_TIMEOUT = Duration.minutes(2)
const INGEST_TIMEOUT = Duration.seconds(30)
const RESOURCE_SYNC_TIMEOUT = Duration.seconds(30)
/**
 * Outbound requests per tick. A Workers Paid invocation gets 10,000 subrequests unless
 * `limits.subrequests` says otherwise, and the other five-minute ticks run in the same one.
 */
const MAX_CALLS_PER_TICK = 3_000
export const MAX_PAGES_PER_METRIC = 10
export const MAX_RESOURCE_PAGES = 20
const MAX_CONNECTORS_PER_ORG_TICK = 10
const CONNECTOR_CONCURRENCY = 3
/** Rows buffered per connector before they are shipped. */
const FLUSH_ROWS = 5_000
/** An organization over its plan limit is not read again for this long. */
const BILLING_HOLD_MS = 60 * MINUTE_MS
const RESOURCE_SYNC_INTERVAL_MS = 60 * MINUTE_MS

const METRICS = GCP_METRIC_GROUPS.flatMap((group) => group.metrics.map((metric) => ({ group, metric })))

const SYSTEM_USER_ID = Schema.decodeUnknownSync(UserId)("system-gcp-metrics")

const RETRIES = "Maple retries in 5 minutes."
const NOT_STORED = `${RETRIES} Nothing to do.`

/** Why a failed call failed and what to do about it, in the customer's terms. */
const explainApiError = (
	error: GcpApiError,
	connector: GcpConnectorRow,
	reading: "metrics" | "resources",
) => {
	// The host project is the one Google checks for billing, enabled APIs and quota.
	const host = connector.projectId
	const scope = `${connector.scopeType} ${connector.scopeId}`
	if (error.reason === "BILLING_DISABLED") {
		return `The host project ${host} has no active billing account, and ${error.api} only answers for projects that have one. Link one: https://console.cloud.google.com/billing/linkedaccount?project=${host} Maple retries every 5 minutes.`
	}
	if (error.reason === "SERVICE_DISABLED") {
		return `The ${error.api} API is switched off in the host project ${host}. Run the setup script again: it switches the API on.`
	}
	if (error.kind === "denied" || error.kind === "not_found") {
		// Shown both before the script ever ran and for the minute or two after a run in which
		// Google does not accept the new grant yet, so it has to read right in both.
		if (error.api === "IAM Credentials") {
			return "Maple can't sign in as this connection's read-only service account yet. After a setup run Google needs a few minutes to accept the new grant, and Maple retries every 5 minutes. If this stays, the account does not exist, or the grant to Maple is missing or blocked by an organization policy: run the setup script and read its last lines."
		}
		return reading === "metrics"
			? `Google denied Maple's read of ${scope}: the read-only roles are missing. Run the setup script again: it grants them. A new grant can take a few minutes.`
			: `Google denied the resource listing for ${scope}. Run the setup script again: it grants Cloud Asset Viewer.`
	}
	// Signing in is counted against Maple's own project, not the host project.
	if (error.kind === "rate_limited" && error.api !== "IAM Credentials") {
		return `Google rate-limited the ${error.api} API for the host project ${host}. ${RETRIES} If this repeats, raise that API's quota on the project.`
	}
	return `Maple's request to Google's ${error.api} API failed. ${RETRIES} If this repeats, write to support@maple.dev.`
}

/**
 * What the connection shows for a failed call: one sentence of cause, one of what to do, and
 * Google's status at the end.
 */
const describeApiError = (error: GcpApiError, connector: GcpConnectorRow, reading: "metrics" | "resources") =>
	`${explainApiError(error, connector, reading)} (${error.message})`

const toPersistenceError = makePersistenceErrorMapper(
	IntegrationsPersistenceError,
	"Google Cloud metrics database error",
)

class GcpMetricsIngestError extends Schema.TaggedError<GcpMetricsIngestError>()(
	"@maple/api/integrations/GcpMetricsIngestError",
	{ message: Schema.String, status: Schema.optionalKey(Schema.Number) },
) {}

/**
 * The connector's next window, on minute boundaries, or null when it is caught up. It never
 * starts more than an hour back: after a long pause the gap is skipped, not replayed.
 */
export const nextWindow = (watermarkAt: Date | null, now: number) => {
	const endMs = now - INGESTION_LAG_MS - ((now - INGESTION_LAG_MS) % MINUTE_MS)
	const startMs = Math.max(dateToMs(watermarkAt) ?? 0, endMs - MAX_WINDOW_MS)
	return startMs < endMs ? { startMs, endMs } : null
}

export interface GcpMetricsPollSummary {
	readonly polled: number
	/** Due connectors left for a later tick: over a cap or budget, or claimed by an overlapping tick. */
	readonly deferred: number
	readonly rowsIngested: number
	readonly failures: number
	/** Metric queries cut short or left unread at a budget. */
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
	readonly httpClient: HttpClient.HttpClient
	readonly mapleToken: Redacted.Redacted<string>
	/** Every outbound request of the tick, counted by `httpClient`. */
	readonly budget: { calls: number }
}

interface ConnectorOutcome {
	readonly rowsIngested: number
	readonly failed: boolean
	readonly incompleteMetrics: number
}

const NOTHING: ConnectorOutcome = { rowsIngested: 0, failed: false, incompleteMetrics: 0 }
const FAILED: ConnectorOutcome = { ...NOTHING, failed: true }

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

			/**
			 * A failed poll leaves the watermark alone and says why. With `holdUntilMs` the whole
			 * organization is held, so its other connectors are not read for nothing.
			 */
			const recordFailure = Effect.fnUntraced(function* (
				connector: GcpConnectorRow,
				message: string,
				holdUntilMs?: number,
			) {
				yield* Effect.annotateCurrentSpan({ "maple.gcp.poll_failed": true })
				yield* Effect.logWarning("gcp connector poll failed", {
					orgId: connector.orgId,
					connectorId: connector.id,
					error: message,
				})
				yield* dbExecute((db) =>
					holdUntilMs === undefined
						? db
								.update(gcpConnectors)
								.set({ lastMetricsError: message })
								.where(eq(gcpConnectors.id, connector.id))
						: db
								.update(gcpConnectors)
								.set({ lastMetricsError: message, metricsLeaseUntil: msToDate(holdUntilMs) })
								.where(
									and(
										eq(gcpConnectors.orgId, connector.orgId),
										eq(gcpConnectors.metricsEnabled, true),
									),
								),
				)
				return FAILED
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
				return `The scope holds more than ${(MAX_RESOURCE_PAGES * RESOURCE_PAGE_SIZE).toLocaleString("en-US")} resources, so the resource list is incomplete. Metrics are unaffected. Connect folders or projects separately for a full list.`
			})

			/**
			 * The inventory sync as the columns to write. A sync that is denied or cannot be stored
			 * is retried next tick, one that runs out of pages or time waits for the next hour, and
			 * none of them holds the metrics back.
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
						orElse: () =>
							Effect.succeed(
								"The resource listing ran out of time and is incomplete. Maple retries within the hour.",
							),
					}),
					Effect.map((note) => ({
						lastResourcesError: note,
						resourcesSyncedAt: msToDate(tick.now),
					})),
					Effect.catchTags({
						"@maple/api/integrations/GcpApiError": (error) =>
							Effect.succeed({
								lastResourcesError: describeApiError(error, connector, "resources"),
							}),
						"@maple/http/errors/IntegrationsPersistenceError": () =>
							Effect.succeed({
								lastResourcesError: `Maple could not store the resource list just now. ${NOT_STORED}`,
							}),
					}),
				)

			/** One connector: its inventory sync when due, then its metrics window. */
			const pollConnector = Effect.fn("GcpMetricsService.pollConnector")(
				function* (connector: GcpConnectorRow, tick: Tick) {
					// The id is validated when the connector is created; encoding keeps it inside the path.
					const scope = `${connector.scopeType}s/${encodeURIComponent(connector.scopeId)}`
					yield* Effect.annotateCurrentSpan({
						orgId: connector.orgId,
						"maple.gcp.connector_id": connector.id,
						"maple.gcp.scope": scope,
					})
					const window = nextWindow(connector.metricsWatermarkAt, tick.now)
					if (window === null) return NOTHING
					const reader = yield* impersonateReader(tick.httpClient, tick.mapleToken, connector)
					if (
						connector.resourcesSyncedAt === null ||
						tick.now - dateToMs(connector.resourcesSyncedAt) >= RESOURCE_SYNC_INTERVAL_MS
					) {
						yield* updateConnector(
							connector.id,
							yield* resourceSyncOutcome(connector, tick, scope, reader),
						)
					}
					const ingestKey = (yield* ingestKeys.getOrCreate(connector.orgId, SYSTEM_USER_ID))
						.publicKey

					// The metrics get a full budget, whatever sign-in and the inventory sync took.
					const startedAt = yield* Clock.currentTimeMillis
					const outOfBudget = Effect.map(
						Clock.currentTimeMillis,
						(time) =>
							time - startedAt >= POLL_BUDGET_MS || tick.budget.calls >= MAX_CALLS_PER_TICK,
					)

					let buffer: GcpMetricRows = { sumRows: [], gaugeRows: [] }
					let rowsIngested = 0
					/** One metric, page by page; false when pages were left unread. */
					const readMetric = Effect.fnUntraced(function* (query: GcpTimeSeriesQuery) {
						let pageToken: string | undefined
						for (let page = 0; page < MAX_PAGES_PER_METRIC; page++) {
							if (page > 0 && (yield* outOfBudget)) return false
							const body = yield* listTimeSeriesPage(
								tick.httpClient,
								reader,
								query,
								pageToken,
							).pipe(
								// One more try rides out a blip; a query that keeps failing is skipped.
								Effect.retry({ times: 1, while: (error) => error.kind === "upstream" }),
							)
							const rows = mapGcpTimeSeries(query, body.timeSeries ?? [])
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

					/** Queries answered in full, cut short at a budget, and not started because of one. */
					let complete = 0
					let partial = 0
					let skipped = 0
					let firstFailure: { readonly type: string; readonly error: GcpApiError } | undefined
					// A different metric goes first each tick, so a scope that always runs out of
					// budget does not lose the same ones every time.
					const first = Math.floor(window.endMs / TICK_MS) % METRICS.length
					for (const { group, metric } of [...METRICS.slice(first), ...METRICS.slice(0, first)]) {
						if (yield* outOfBudget) {
							skipped += 1
							continue
						}
						const result = yield* readMetric({ scope, group, metric, ...window }).pipe(
							Effect.catchTag("@maple/api/integrations/GcpApiError", (error) =>
								Effect.succeed(error),
							),
						)
						if (result === false) {
							partial += 1
						} else if (result === true || result.kind === "not_found") {
							// Cloud Monitoring answers 404 for a type that never had data in the scope.
							complete += 1
						} else {
							firstFailure ??= { type: metric.type, error: result }
							// No access, or out of quota: every remaining query would fail the same way.
							if (result.kind === "denied" || result.kind === "rate_limited") break
						}
					}
					// Nothing answered and nothing shipped: the window is left for the next poll.
					if (rowsIngested === 0 && complete + partial === 0) {
						return firstFailure === undefined ? NOTHING : yield* firstFailure.error
					}
					rowsIngested += yield* emitMetrics(tick.httpClient, ingestKey, buffer)

					const incomplete = partial + skipped
					const failed = METRICS.length - complete - incomplete
					// The note that ends in Google's status goes last.
					const notes = [
						...(incomplete === 0
							? []
							: [
									`${incomplete} of ${METRICS.length} metric queries were not read in full: the scope holds more series than one read takes. Connect the folders or projects separately to collect all of it.`,
								]),
						...(firstFailure === undefined
							? []
							: [
									firstFailure.error.kind === "rate_limited"
										? describeApiError(firstFailure.error, connector, "metrics")
										: `${failed} of ${METRICS.length} metric queries failed, first ${firstFailure.type}. The rest were stored. ${RETRIES} (${firstFailure.error.message})`,
								]),
					]
					yield* updateConnector(connector.id, {
						metricsWatermarkAt: msToDate(window.endMs),
						lastMetricsReceivedAt: msToDate(tick.now),
						lastMetricsError: notes.length === 0 ? null : notes.join(" "),
					})
					yield* Effect.annotateCurrentSpan({
						"maple.gcp.rows_ingested": rowsIngested,
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
									`Reading the metrics took longer than two minutes. ${RETRIES} If this repeats, connect folders or projects separately.`,
								),
						}),
						Effect.catchTags({
							"@maple/api/integrations/GcpApiError": (error) =>
								recordFailure(connector, describeApiError(error, connector, "metrics")),
							"@maple/api/integrations/GcpMetricsIngestError": (error) =>
								error.status === 402
									? recordFailure(
											connector,
											"Metrics are paused: this Maple organization is over its plan limit. Maple tries again in an hour. See Settings, Billing.",
											tick.now + BILLING_HOLD_MS,
										)
									: recordFailure(
											connector,
											`Maple could not store the metrics it read just now. ${NOT_STORED} (${error.message})`,
										),
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

				const budget = { calls: 0 }
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
										}).pipe(Effect.as(FAILED)),
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
