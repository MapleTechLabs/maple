/**
 * Google Cloud metrics and resource poller. Each alerting tick reads the curated Cloud Monitoring
 * metrics (`@maple/domain/gcp-metrics`) of every connector with metrics enabled, at the
 * connector's scope (project, folder or organization), and ships them to the ingest gateway as
 * OTLP; of Query Insights' per-statement series it keeps each instance's top statements of the
 * window. Hourly it also syncs the scope's resource inventory into `gcp_resources`, with each
 * Cloud SQL instance's settings.
 *
 * Work per tick is bounded: connectors are taken least recently polled first, a few per
 * organization, until the tick's call or time budget runs out. A window is read again only when
 * nothing of it was ingested; the exceptions are an ingest failure and the hard timeout, which
 * repeat what a poll had already flushed.
 */
import { GCP_METRIC_GROUPS, type GcpMetric, type GcpMetricGroup } from "@maple/domain/gcp-metrics"
import { IntegrationsPersistenceError, UserId } from "@maple/domain/http"
import type { OrgId } from "@maple/domain/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { GcpConnectors, GcpResources, type GcpConnectorRow } from "@maple/db/tables"
import { Cause, Clock, Context, Duration, Effect, Layer, Option, Redacted, Ref, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { Env } from "@maple/backend/platform/Env"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { makeIngestSender } from "@maple/backend/services/ingest/ingest-sender"
import {
	isSourcePaused,
	type PollOutcome,
	reportPoll,
	stampedSourceId,
} from "@maple/backend/services/org/integration-sources"
import { metricRowsToOtlp } from "./cloudflare-analytics/otlp"
import {
	fetchMapleAccessToken,
	GcpApiError,
	importServiceAccountKey,
	impersonateReader,
	listSqlInstancesPage,
	listTimeSeriesPage,
	RESOURCE_PAGE_SIZE,
	searchResourcesPage,
	type GcpReader,
	type GcpTimeSeries,
	type GcpTimeSeriesQuery,
} from "./gcp/api"
import { gcpSqlSettings } from "./gcp/cloud-sql"
import {
	gcpTopKey,
	gcpTopSeries,
	mapGcpResource,
	mapGcpTimeSeries,
	type GcpMetricRows,
	type GcpTopGroup,
} from "./gcp/mapping"

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

const METRIC_COUNT = GCP_METRIC_GROUPS.reduce((sum, group) => sum + group.metrics.length, 0)

/**
 * What a poll reads in turn: a metric on its own, or a top group as one, its ranking metric
 * first: the rest are read for the series it keeps.
 */
type MetricRead =
	| { readonly group: GcpMetricGroup; readonly metric: GcpMetric }
	| { readonly group: GcpTopGroup; readonly ranking: GcpMetric; readonly rest: ReadonlyArray<GcpMetric> }
const READS = GCP_METRIC_GROUPS.flatMap((group): ReadonlyArray<MetricRead> => {
	const top = group.top
	return top === undefined
		? group.metrics.map((metric) => ({ group, metric }))
		: group.metrics
				.filter((metric) => metric.name === top.by)
				.map((ranking) => ({
					group: { ...group, top },
					ranking,
					rest: group.metrics.filter((metric) => metric !== ranking),
				}))
})

/** How one metric query went: answered in full or cut short, failed, or not run for a budget. */
type ReadOutcome = boolean | GcpApiError | "skipped"
type Read = readonly [GcpMetric, ReadOutcome]

/** Queries answered in full, cut short at a budget, not started because of one, and the first failure. */
const tallyReads = (reads: ReadonlyArray<Read>) =>
	reads.reduce(
		(tally, [metric, outcome]) =>
			outcome === "skipped"
				? { ...tally, skipped: tally.skipped + 1 }
				: outcome === false
					? { ...tally, partial: tally.partial + 1 }
					: // Cloud Monitoring answers 404 for a type that never had data in the scope.
						outcome === true || outcome.kind === "not_found"
						? { ...tally, complete: tally.complete + 1 }
						: {
								...tally,
								firstFailure: tally.firstFailure ?? { type: metric.type, error: outcome },
							},
		{
			complete: 0,
			partial: 0,
			skipped: 0,
			firstFailure: undefined as { readonly type: string; readonly error: GcpApiError } | undefined,
		},
	)

/** No access, or out of quota: every remaining query would fail the same way. */
const halts = (outcome: ReadOutcome) =>
	typeof outcome === "object" && (outcome.kind === "denied" || outcome.kind === "rate_limited")

/**
 * A paged listing's bodies in order, at most `maxPages`. Pages after the first are fetched only
 * while `proceed` holds. The listing was read in full when the last body has no `nextPageToken`.
 */
const pages = <B extends { readonly nextPageToken?: string | undefined }, E, R>(
	maxPages: number,
	fetchPage: (pageToken: string | undefined) => Effect.Effect<B, E, R>,
	proceed: Effect.Effect<boolean> = Effect.succeed(true),
): Stream.Stream<B, E, R> =>
	Stream.paginate({ page: 0, pageToken: Option.none<string>() }, ({ page, pageToken }) =>
		Effect.gen(function* () {
			if (page > 0 && !(yield* proceed)) return [[], Option.none()] as const
			const body = yield* fetchPage(Option.getOrUndefined(pageToken))
			const next = Option.fromUndefinedOr(body.nextPageToken)
			return [
				[body],
				page + 1 < maxPages && Option.isSome(next)
					? Option.some({ page: page + 1, pageToken: next })
					: Option.none(),
			] as const
		}),
	)

/** Whether a listing's last page was its end. */
const readToEnd = <B extends { readonly nextPageToken?: string | undefined }>(last: Option.Option<B>) =>
	Option.isSome(last) && last.value.nextPageToken === undefined

const SYSTEM_USER_ID = Schema.decodeUnknownSync(UserId)("system-gcp-metrics")

const RETRIES = "Maple retries in 5 minutes."
const NOT_STORED = `${RETRIES} Nothing to do.`

/** What helps a scope too large for one read. A project has no parts to connect instead. */
const whenTooLarge = (connector: GcpConnectorRow) =>
	connector.scopeType === "project"
		? "write to support@maple.dev"
		: "connect its folders or projects separately"

/** Why a failed call failed and what to do about it, in the customer's terms. */
const explainApiError = (
	error: GcpApiError,
	connector: GcpConnectorRow,
	reading: "metrics" | "resources",
) => {
	// The host project is the one Google checks for billing, enabled APIs and quota. A project
	// scope is its own host, and reads as "the project".
	const host = `${connector.scopeType === "project" ? "project" : "host project"} ${connector.projectId}`
	const scope = `${connector.scopeType} ${connector.scopeId}`
	if (error.reason === "BILLING_DISABLED") {
		return `The ${host} has no active billing account, and ${error.api} only answers for projects that have one. Link one: https://console.cloud.google.com/billing/linkedaccount?project=${connector.projectId} Maple retries every 5 minutes.`
	}
	if (error.reason === "SERVICE_DISABLED") {
		return `The ${error.api} API is switched off in the ${host}. Switch it on in the console, or run the setup script again.`
	}
	if (error.kind === "denied" || error.kind === "not_found") {
		if (error.api === "IAM Credentials") {
			// A connection that has been read before lost its account or its grant.
			if (connector.lastMetricsReceivedAt !== null) {
				return "Maple can no longer sign in as this connection's read-only service account. The account was deleted, or the grant to Maple was removed or is blocked by an organization policy. Run the setup script again or redo the read-only steps: either restores both."
			}
			// Shown both before any setup and for the minutes after one in which Google does not
			// accept the new grant yet, so it has to read right in both.
			return "Maple can't sign in as this connection's read-only service account yet. Google needs a few minutes to accept a new grant, and Maple retries every 5 minutes. If this stays, the account does not exist, or the grant to Maple is missing or blocked by an organization policy: finish the read-only account steps of a manual setup, or run the setup script again."
		}
		return reading === "metrics"
			? `Google denied Maple's read of ${scope}: the read-only roles are missing. Grant them with the setup script, the console steps or your Terraform. A new grant can take a few minutes.`
			: `Google denied the resource listing for ${scope}. Cloud Asset Viewer is missing. Grant it with the setup script, the console steps or your Terraform.`
	}
	// Signing in is counted against Maple's own project, not the host project.
	if (error.kind === "rate_limited" && error.api !== "IAM Credentials") {
		return `Google rate-limited the ${error.api} API for the ${host}. ${RETRIES} If this repeats, raise that API's quota on the project.`
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

/**
 * The connector's next window, on minute boundaries, or null when it is caught up. It never
 * starts more than an hour back: after a long pause the gap is skipped, not replayed.
 */
export const nextWindow = (watermarkAt: number | null, now: number) => {
	const endMs = now - INGESTION_LAG_MS - ((now - INGESTION_LAG_MS) % MINUTE_MS)
	const startMs = Math.max(watermarkAt ?? 0, endMs - MAX_WINDOW_MS)
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
	"@maple/backend/services/GcpMetricsService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const baseHttpClient = yield* HttpClient.HttpClient
			const ingestKeys = yield* OrgIngestKeysService
			const ingest = yield* makeIngestSender
			const dbExecute = makeDbExecute(database, "GcpMetricsService", toPersistenceError)

			const updateConnector = (id: GcpConnectorRow["id"], set: PG.UpdateSetOf<typeof GcpConnectors>) =>
				dbExecute((db) =>
					db.run(
						PG.update(GcpConnectors)
							.set(set)
							.where(($) => [$.id.eq(id)]),
					),
				)

			/** Records a tick on the connector's source; a failed report does not fail the poll. */
			const reportOutcome = (
				connector: Pick<GcpConnectorRow, "id" | "sourceId">,
				outcome: PollOutcome,
				now: number,
			) =>
				dbExecute((db) => reportPoll(db, connector.sourceId, outcome, now)).pipe(
					Effect.catchTag("@maple/http/errors/IntegrationsPersistenceError", (error) =>
						Effect.logWarning("gcp source poll report failed").pipe(
							Effect.annotateLogs({ connectorId: connector.id, error: error.message }),
						),
					),
				)

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
				yield* holdUntilMs === undefined
					? updateConnector(connector.id, { lastMetricsError: message })
					: dbExecute((db) =>
							db.run(
								PG.update(GcpConnectors)
									.set({ lastMetricsError: message, metricsLeaseUntil: holdUntilMs })
									.where(($) => [$.orgId.eq(connector.orgId), $.metricsEnabled.eq(true)]),
							),
						)
				const now = yield* Clock.currentTimeMillis
				const failed: PollOutcome = { _tag: "Failed", error: message }
				// A hold fails every connector it holds, so each of their sources says so.
				const held =
					holdUntilMs === undefined
						? [connector]
						: yield* dbExecute((db) =>
								db.run(
									PG.from(GcpConnectors)
										.select("id", "sourceId")
										.where(($) => [
											$.orgId.eq(connector.orgId),
											$.metricsEnabled.eq(true),
										]),
								),
							)
				yield* Effect.forEach(held, (row) => reportOutcome(row, failed, now), {
					discard: true,
				})
				return FAILED
			})

			const emitMetrics = Effect.fnUntraced(function* (
				httpClient: HttpClient.HttpClient,
				ingestKey: string,
				sourceId: string | undefined,
				rows: GcpMetricRows,
			) {
				const total = rows.sumRows.length + rows.gaugeRows.length
				if (total === 0) return 0
				const payload = metricRowsToOtlp(rows.sumRows, rows.gaugeRows, { sourceId })
				yield* ingest.send({
					signal: "metrics",
					ingestKey,
					payload,
					label: "Google Cloud metrics",
					client: httpClient,
				})
				return total
			})

			/**
			 * Each Cloud SQL instance's settings onto its inventory row, which the search does not
			 * answer. An instance the search did not return has no row to update.
			 */
			const syncSqlSettings = Effect.fnUntraced(function* (
				connector: GcpConnectorRow,
				tick: Tick,
				scope: string,
				reader: GcpReader,
			) {
				const bodies = yield* pages(MAX_RESOURCE_PAGES, (pageToken) =>
					listSqlInstancesPage(tick.httpClient, reader, scope, pageToken),
				).pipe(Stream.runCollect)
				const instances = bodies.flatMap((body) =>
					(body.assets ?? []).flatMap((asset) => {
						const data = asset.resource?.data
						return data === undefined ? [] : [{ name: asset.name, data }]
					}),
				)
				yield* Effect.forEach(
					gcpSqlSettings(instances),
					([name, details]) =>
						dbExecute((db) =>
							db.run(
								PG.update(GcpResources)
									.set({ details })
									.where(($) => [$.connectorId.eq(connector.id), $.name.eq(name)]),
							),
						),
					{ discard: true },
				)
			})

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
				const lastSeenAt = tick.now
				/** One page's resources onto the inventory. Keyed by name: one statement cannot upsert the same row twice. */
				const upsertPage = (body: Effect.Success<ReturnType<typeof searchResourcesPage>>) => {
					const rows = new Map(
						(body.results ?? []).flatMap((result) => {
							const resource = mapGcpResource(result)
							return resource === undefined ? [] : [[resource.name, resource] as const]
						}),
					)
					if (rows.size === 0) return Effect.void
					return dbExecute((db) =>
						db.run(
							PG.insertInto(GcpResources)
								.values(
									[...rows.values()].map((resource) => ({
										...resource,
										connectorId: connector.id,
										orgId: connector.orgId,
										lastSeenAt,
									})),
								)
								.onConflictDoUpdate({
									target: ["connectorId", "name"],
									set: (_, excluded) => ({
										assetType: excluded.assetType,
										projectId: excluded.projectId,
										location: excluded.location,
										displayName: excluded.displayName,
										state: excluded.state,
										labels: excluded.labels,
										resourceCreatedAt: excluded.resourceCreatedAt,
										resourceUpdatedAt: excluded.resourceUpdatedAt,
										lastSeenAt: excluded.lastSeenAt,
									}),
								}),
						),
					)
				}
				const complete = readToEnd(
					yield* pages(MAX_RESOURCE_PAGES, (pageToken) =>
						searchResourcesPage(tick.httpClient, reader, scope, pageToken),
					).pipe(Stream.tap(upsertPage), Stream.runLast),
				)
				if (complete) {
					yield* dbExecute((db) =>
						db.run(
							PG.deleteFrom(GcpResources).where(($) => [
								$.connectorId.eq(connector.id),
								$.lastSeenAt.lt(lastSeenAt),
							]),
						),
					)
				}
				yield* syncSqlSettings(connector, tick, scope, reader)
				if (complete) return null
				return `The ${connector.scopeType} holds more than ${(MAX_RESOURCE_PAGES * RESOURCE_PAGE_SIZE).toLocaleString("en-US")} resources, so the resource list is incomplete. Metrics are unaffected. For a full list, ${whenTooLarge(connector)}.`
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
						resourcesSyncedAt: tick.now,
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
					// A paused source reads nothing; its watermark follows the clock so a resume starts at now.
					if (yield* dbExecute((db) => isSourcePaused(db, connector.sourceId, tick.now))) {
						yield* Effect.annotateCurrentSpan("maple.gcp.skip_reason", "source paused")
						yield* updateConnector(connector.id, { metricsWatermarkAt: window.endMs })
						return NOTHING
					}
					const reader = yield* impersonateReader(tick.httpClient, tick.mapleToken, connector)
					if (
						connector.resourcesSyncedAt === null ||
						tick.now - connector.resourcesSyncedAt >= RESOURCE_SYNC_INTERVAL_MS
					) {
						yield* updateConnector(
							connector.id,
							yield* resourceSyncOutcome(connector, tick, scope, reader),
						)
					}
					const ingestKey = (yield* ingestKeys.getOrCreate(connector.orgId, SYSTEM_USER_ID))
						.publicKey
					const sourceId = stampedSourceId(connector.sourceId)

					// The metrics get a full budget, whatever sign-in and the inventory sync took.
					const startedAt = yield* Clock.currentTimeMillis
					const outOfBudget = Effect.map(
						Clock.currentTimeMillis,
						(time) =>
							time - startedAt >= POLL_BUDGET_MS || tick.budget.calls >= MAX_CALLS_PER_TICK,
					)

					const emptyRows: GcpMetricRows = { sumRows: [], gaugeRows: [] }
					const buffer = yield* Ref.make(emptyRows)
					const rowsIngested = yield* Ref.make(0)
					const ship = (rows: GcpMetricRows) =>
						emitMetrics(tick.httpClient, ingestKey, sourceId, rows).pipe(
							Effect.flatMap((shipped) => Ref.update(rowsIngested, (total) => total + shipped)),
						)
					/** A page's rows of one metric, `keep`'s series only; shipped once enough are buffered. */
					const store = Effect.fnUntraced(function* (
						query: GcpTimeSeriesQuery,
						series: ReadonlyArray<GcpTimeSeries>,
						keep?: (series: GcpTimeSeries) => boolean,
					) {
						const rows = mapGcpTimeSeries(
							query,
							keep === undefined ? series : series.filter(keep),
						)
						const full = yield* Ref.modify(buffer, (held) => {
							const next = {
								sumRows: [...held.sumRows, ...rows.sumRows],
								gaugeRows: [...held.gaugeRows, ...rows.gaugeRows],
							}
							return next.sumRows.length + next.gaugeRows.length >= FLUSH_ROWS
								? [Option.some(next), emptyRows]
								: [Option.none<GcpMetricRows>(), next]
						})
						if (Option.isSome(full)) yield* ship(full.value)
					})
					/**
					 * One metric, page by page, each page's series through `read`; false when pages were
					 * left unread. A Google failure is the outcome, not an error.
					 */
					const readMetric = <E>(
						query: GcpTimeSeriesQuery,
						read: (series: ReadonlyArray<GcpTimeSeries>) => Effect.Effect<void, E>,
					) =>
						pages(
							MAX_PAGES_PER_METRIC,
							(pageToken) =>
								listTimeSeriesPage(tick.httpClient, reader, query, pageToken).pipe(
									// One more try rides out a blip; a query that keeps failing is skipped.
									Effect.retry({ times: 1, while: (error) => error.kind === "upstream" }),
								),
							Effect.map(outOfBudget, (out) => !out),
						).pipe(
							Stream.tap((body) => read(body.timeSeries ?? [])),
							Stream.runLast,
							Effect.map(readToEnd),
							Effect.catchTag("@maple/api/integrations/GcpApiError", (error) =>
								Effect.succeed(error),
							),
						)

					/** One metric on its own. */
					const readOne = Effect.fnUntraced(function* (group: GcpMetricGroup, metric: GcpMetric) {
						if (yield* outOfBudget) return "skipped" as const
						const query = { scope, group, metric, ...window }
						return yield* readMetric(query, (series) => store(query, series))
					})

					/**
					 * A top group: its ranking metric in full, then the rest for the series the ranking
					 * kept. A ranking that failed leaves the rest unread; one that kept nothing leaves
					 * nothing to read.
					 */
					const readTop = Effect.fnUntraced(function* (
						group: GcpTopGroup,
						ranking: GcpMetric,
						rest: ReadonlyArray<GcpMetric>,
					) {
						if (yield* outOfBudget) {
							return [ranking, ...rest].map((metric): Read => [metric, "skipped"])
						}
						const query = { scope, group, metric: ranking, ...window }
						const rankingSeries = yield* Ref.make<ReadonlyArray<GcpTimeSeries>>([])
						const ranked = yield* readMetric(query, (page) =>
							Ref.update(rankingSeries, (series) => [...series, ...page]),
						)
						if (typeof ranked !== "boolean") {
							// A type that never had data in the scope has nothing to rank.
							const nothing =
								ranked.kind === "not_found" ? rest.map((metric): Read => [metric, true]) : []
							return [[ranking, ranked] satisfies Read, ...nothing]
						}
						const series = yield* Ref.get(rankingSeries)
						const kept = gcpTopSeries(group, series)
						const keep = (item: GcpTimeSeries) => kept.has(gcpTopKey(group, item))
						yield* store(query, series, keep)
						if (kept.size === 0) {
							return [
								[ranking, ranked] satisfies Read,
								...rest.map((metric): Read => [metric, true]),
							]
						}
						const others = yield* Stream.fromIterable(rest).pipe(
							Stream.mapEffect(
								Effect.fnUntraced(function* (metric) {
									if (yield* outOfBudget) return [metric, "skipped"] satisfies Read
									const next = { scope, group, metric, ...window }
									const outcome = yield* readMetric(next, (page) => store(next, page, keep))
									return [metric, outcome] satisfies Read
								}),
							),
							Stream.takeUntil(([, outcome]) => halts(outcome)),
							Stream.runCollect,
						)
						return [[ranking, ranked] satisfies Read, ...others]
					})

					// A different read goes first each tick, so a scope that always runs out of budget
					// does not lose the same ones every time.
					const first = Math.floor(window.endMs / TICK_MS) % READS.length
					const reads = yield* Stream.fromIterable([
						...READS.slice(first),
						...READS.slice(0, first),
					]).pipe(
						Stream.mapEffect(
							Effect.fnUntraced(function* (read) {
								if ("metric" in read) {
									return [
										[read.metric, yield* readOne(read.group, read.metric)] satisfies Read,
									]
								}
								return yield* readTop(read.group, read.ranking, read.rest)
							}),
						),
						Stream.takeUntil((reads) => reads.some(([, outcome]) => halts(outcome))),
						Stream.runCollect,
					)
					const { complete, partial, skipped, firstFailure } = tallyReads(reads.flat())
					// Nothing answered and nothing shipped: the window is left for the next poll.
					if ((yield* Ref.get(rowsIngested)) === 0 && complete + partial === 0) {
						return firstFailure === undefined ? NOTHING : yield* firstFailure.error
					}
					yield* ship(yield* Ref.getAndSet(buffer, emptyRows))
					const rowsIngestedTotal = yield* Ref.get(rowsIngested)

					const incomplete = partial + skipped
					const failed = METRIC_COUNT - complete - incomplete
					// The note that ends in Google's status goes last.
					const notes = [
						...(incomplete === 0
							? []
							: [
									`${incomplete} of ${METRIC_COUNT} metric queries were not read in full: the ${connector.scopeType} holds more series than one read takes. To collect all of it, ${whenTooLarge(connector)}.`,
								]),
						...(firstFailure === undefined
							? []
							: [
									firstFailure.error.kind === "rate_limited"
										? describeApiError(firstFailure.error, connector, "metrics")
										: `${failed} of ${METRIC_COUNT} metric queries failed, first ${firstFailure.type}. The rest were stored. ${RETRIES} (${firstFailure.error.message})`,
								]),
					]
					yield* updateConnector(connector.id, {
						metricsWatermarkAt: window.endMs,
						lastMetricsReceivedAt: tick.now,
						lastMetricsError: notes.length === 0 ? null : notes.join(" "),
					})
					// Incomplete or partly failed reads still count as a good read.
					yield* reportOutcome(connector, { _tag: "Ok" }, tick.now)
					// A read proves the read-only account is set up, however it was: a setup in the console
					// or as code sends no report. Not after a switch-off or a removal made during the read.
					yield* dbExecute((db) =>
						db.run(
							PG.update(GcpConnectors)
								.set({ appliedMetricsEnabled: true })
								.where(($) => [
									$.id.eq(connector.id),
									$.metricsEnabled.eq(true),
									$.appliedMetricsEnabled.isNull(),
								]),
						),
					)
					yield* Effect.annotateCurrentSpan({
						"maple.gcp.rows_ingested": rowsIngestedTotal,
						"maple.gcp.metric_queries_failed": failed,
						"maple.gcp.metric_queries_incomplete": incomplete,
					})
					return {
						rowsIngested: rowsIngestedTotal,
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
									`Reading the metrics took longer than two minutes. ${RETRIES} If this repeats, ${whenTooLarge(connector)}.`,
								),
						}),
						Effect.catchTags({
							"@maple/api/integrations/GcpApiError": (error) =>
								recordFailure(connector, describeApiError(error, connector, "metrics")),
							"@maple/backend/ingest/IngestSendError": (error) =>
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
				const isDue = ($: PG.ColumnAccessor<typeof GcpConnectors.columns>) => [
					$.metricsEnabled.eq(true),
					PG.or($.metricsLeaseUntil.isNull(), $.metricsLeaseUntil.lt(now)),
				]
				const due = yield* dbExecute((db) =>
					db.run(
						PG.from(GcpConnectors)
							.select("id", "orgId")
							.where(isDue)
							// Never polled first, then least recently polled.
							.orderBy(($) => [
								[PG.asBoolean($.metricsLeaseUntil.isNull()), "desc"],
								[$.metricsLeaseUntil, "asc"],
								[$.id, "asc"],
							]),
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
								db.run(
									PG.update(GcpConnectors)
										.set({ metricsLeaseUntil: now + LEASE_MS })
										.where(($) => [$.id.eq(candidate.id), ...isDue($)])
										.returning(),
								),
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
