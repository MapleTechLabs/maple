import { randomUUID } from "node:crypto"
/**
 * Branch metrics for PlanetScale connections without a service token. Each alerting tick reads
 * every branch's last minutes from PlanetScale's metrics API on the OAuth grant (`read_branches`)
 * and ships them to the ingest gateway as OTLP gauges shaped like Prometheus scraping
 * (`./planetscale/api-metrics.ts`), so the map, infra pages and alerts need no second path.
 *
 * A connection whose managed scrape target scrapes with a service token is left to Prometheus.
 * Each branch keeps its own watermark (a `planetscale_poll_state` row keyed by branch id): it reads
 * from there, capped at {@link MAX_BACKFILL_MS}, to {@link LAG_MS} before now, and moves only once
 * the window is ingested. The org row (`databaseId` "") is the tick lease and the failure summary.
 */
import { IntegrationsPersistenceError, UserId } from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	PlanetscaleConnections,
	PlanetscaleDatabases,
	PlanetscalePollState,
	ScrapeTargets,
	type PlanetScaleConnectionRow,
	type ScrapeTargetRow,
} from "@maple/db/tables"
import * as PlanetScale from "@distilled.cloud/planetscale"
import { Cause, Clock, Context, Duration, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { Env } from "@maple/backend/platform/Env"
import { PlanetScaleOAuthService } from "@maple/backend/services/auth/PlanetScaleOAuthService"
import { IngestRefused, keepRefusal, makeIngestSender } from "@maple/backend/services/ingest/ingest-sender"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { stampedSourceId } from "@maple/backend/services/org/integration-sources"
import { metricRowsToOtlp } from "./cloudflare-analytics/otlp"
import { branchPassesFilters, parseBranchFilters } from "./PlanetScaleDiscoveryService"
import { decodeConsumed, runPlanetScale, type SdkError } from "./planetscale/api"
import {
	ApiMetricSeries,
	apiMetricRows,
	apiMetricsFor,
	type ApiMetricBranch,
} from "./planetscale/api-metrics"
import { makePlanetScalePollState, PLANETSCALE_METRICS_DATASET } from "./planetscale/poll-state"

const MINUTE_MS = 60_000
/** Only an overlapping tick may skip an org; a later tick always claims it again. */
const ORG_LEASE_TTL_MS = Duration.toMillis(Duration.minutes(1))
/** Branches not started within this budget wait for the next tick (the lane allows 270s in all). */
const POLL_BUDGET_MS = Duration.toMillis(Duration.seconds(150))
/** PlanetScale's last minute is still filling. */
const LAG_MS = 2 * MINUTE_MS
/** How far back a first poll, or one after an outage, reaches. */
const MAX_BACKFILL_MS = 30 * MINUTE_MS
const FIRST_WINDOW_MS = 10 * MINUTE_MS
/** One request per branch per tick; a runaway org cannot spend the whole API allowance. */
const MAX_BRANCHES_PER_ORG = 150
const BRANCH_CONCURRENCY = 4
const ORG_CONCURRENCY = 3

const SYSTEM_USER_ID = Schema.decodeUnknownSync(UserId)("system-planetscale-metrics")

export interface PlanetScaleMetricsPollSummary {
	readonly orgs: number
	readonly polled: number
	readonly branches: number
	readonly rowsIngested: number
	readonly failures: number
}

export interface PlanetScaleMetricsServiceApi {
	readonly pollAll: () => Effect.Effect<PlanetScaleMetricsPollSummary, IntegrationsPersistenceError>
}

type OrgOutcome =
	| { readonly _tag: "Skipped" }
	| { readonly _tag: "Polled"; readonly branches: number; readonly rows: number; readonly failed: boolean }

const toPersistenceError = (error: unknown) =>
	new IntegrationsPersistenceError({
		message: error instanceof Error ? error.message : "PlanetScale metrics persistence failed",
	})

/** A managed target scraping with a stored service token: Prometheus already has the branch. */
export const scrapesWithToken = (target: ScrapeTargetRow | null) =>
	target !== null &&
	target.enabled &&
	target.authType === "token" &&
	target.authCredentialsCiphertext !== null

export class PlanetScaleMetricsService extends Context.Service<
	PlanetScaleMetricsService,
	PlanetScaleMetricsServiceApi
>()("@maple/backend/services/PlanetScaleMetricsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const dbExecute = makeDbExecute(database, "PlanetScaleMetricsService", toPersistenceError)
		const env = yield* Env
		const psOAuth = yield* PlanetScaleOAuthService
		const httpClient = yield* HttpClient.HttpClient
		const ingestKeys = yield* OrgIngestKeysService
		const ingest = yield* makeIngestSender
		const { claimPollWork, recordPollResult } = makePlanetScalePollState(
			database,
			"PlanetScaleMetricsService",
		)

		const callApi = <A, E extends SdkError>(
			connection: PlanetScaleConnectionRow,
			operation: string,
			effect: Effect.Effect<A, E, PlanetScale.PlanetScaleOpContext>,
		) =>
			psOAuth.withAccessToken(connection.orgId, (accessToken) =>
				runPlanetScale(
					httpClient,
					{ apiBaseUrl: env.MAPLE_PLANETSCALE_API_BASE_URL, accessToken },
					operation,
					effect,
				),
			)

		const managedTarget = (connection: PlanetScaleConnectionRow) => {
			const targetId = connection.scrapeTargetId
			if (targetId === null) return Effect.succeed(null)
			return dbExecute((db) =>
				db.run(
					PG.from(ScrapeTargets)
						.select()
						.where(($) => [$.orgId.eq(connection.orgId), $.id.eq(targetId)])
						.limit(1),
				),
			).pipe(Effect.map((rows) => rows[0] ?? null))
		}

		/** Every ready branch of every live database, through the connection's branch filters. */
		const branchesOf = Effect.fnUntraced(function* (
			connection: PlanetScaleConnectionRow,
			target: ScrapeTargetRow | null,
		) {
			const filters = parseBranchFilters(target?.discoveryConfigJson ?? null)
			const serviceName = target?.serviceName ?? `PlanetScale (${connection.psOrganization})`
			const databases = yield* dbExecute((db) =>
				db.run(
					PG.from(PlanetscaleDatabases)
						.select("name", "kind", "branchesJson")
						.where(($) => [$.orgId.eq(connection.orgId), $.deletedAt.isNull()]),
				),
			)
			return databases.flatMap((row) =>
				(row.branchesJson ?? [])
					.filter((branch) => branch.ready && branchPassesFilters(branch.name, filters))
					.map((branch): ApiMetricBranch => ({
						organization: connection.psOrganization,
						database: row.name,
						kind: row.kind,
						branch: branch.name,
						branchId: branch.id,
						serviceName,
					})),
			)
		})

		/** Each branch's watermark: the start of the first minute it has not ingested yet. */
		const branchWatermarks = Effect.fnUntraced(function* (connection: PlanetScaleConnectionRow) {
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(PlanetscalePollState)
						.select("databaseId", "watermarkAt")
						.where(($) => [
							$.orgId.eq(connection.orgId),
							$.dataset.eq(PLANETSCALE_METRICS_DATASET),
						]),
				),
			)
			return new Map(rows.map((row) => [row.databaseId, row.watermarkAt]))
		})

		const recordBranch = (
			connection: PlanetScaleConnectionRow,
			branch: ApiMetricBranch,
			outcome: { readonly nextStartMs: number } | { readonly error: string },
		) =>
			Effect.flatMap(Clock.currentTimeMillis, (now) => {
				const values =
					"nextStartMs" in outcome
						? {
								watermarkAt: outcome.nextStartMs,
								lastSuccessAt: now,
								lastError: null,
								lastErrorAt: null,
							}
						: { lastError: outcome.error.slice(0, 500), lastErrorAt: now }
				return dbExecute((db) =>
					db.run(
						PG.insertInto(PlanetscalePollState)
							.values({
								id: randomUUID(),
								orgId: connection.orgId,
								dataset: PLANETSCALE_METRICS_DATASET,
								databaseId: branch.branchId,
								createdAt: now,
								updatedAt: now,
								...values,
							})
							.onConflictDoUpdate({
								target: ["orgId", "dataset", "databaseId"],
								set: { ...values, updatedAt: now },
							}),
					),
				)
			})

		/**
		 * One branch: read the minutes after its watermark, ingest them in one request, then move
		 * the watermark. A failure leaves the watermark, so the next tick reads the window again.
		 */
		const pollBranch = Effect.fn("PlanetScaleMetricsService.pollBranch")(function* (
			connection: PlanetScaleConnectionRow,
			branch: ApiMetricBranch,
			watermarkAt: number | null,
			ingestKey: string,
		) {
			yield* Effect.annotateCurrentSpan({
				"maple.planetscale.database": branch.database,
				"maple.planetscale.branch": branch.branch,
			})
			const now = yield* Clock.currentTimeMillis
			// The last complete minute; `to` covers the whole of it.
			const endMs = now - LAG_MS - ((now - LAG_MS) % MINUTE_MS)
			const startMs = Math.max(watermarkAt ?? endMs - FIRST_WINDOW_MS, endMs - MAX_BACKFILL_MS)
			if (startMs > endMs) return 0
			const response = yield* callApi(
				connection,
				`reading metrics of ${branch.organization}/${branch.database}/${branch.branch}`,
				PlanetScale.getBranchMetrics({
					organization: branch.organization,
					database: branch.database,
					branch: branch.branch,
					// Repeated `metrics=` parameters keep only the last; one comma list keeps them all.
					metrics: [apiMetricsFor(branch.kind).join(",")],
					from: new Date(startMs).toISOString(),
					to: new Date(endMs).toISOString(),
				}),
			)
			const series = yield* decodeConsumed(
				ApiMetricSeries,
				`metrics of ${branch.database}/${branch.branch}`,
			)(response)
			const nextStartMs = endMs + MINUTE_MS
			const rows = apiMetricRows(branch, series, {
				fromSeconds: startMs / 1000,
				untilSeconds: nextStartMs / 1000,
			})
			if (rows.length > 0) {
				yield* ingest.send({
					signal: "metrics",
					ingestKey,
					payload: metricRowsToOtlp([], rows, { sourceId: stampedSourceId(connection.sourceId) }),
					label: "PlanetScale metrics",
				})
			}
			yield* recordBranch(connection, branch, { nextStartMs })
			yield* Effect.annotateCurrentSpan("maple.planetscale.metrics.rows", rows.length)
			return rows.length
		}, keepRefusal)

		const pollOrg = Effect.fn("PlanetScaleMetricsService.pollOrg")(function* (
			connection: PlanetScaleConnectionRow,
			deadlineMs: number,
		) {
			yield* Effect.annotateCurrentSpan({ orgId: connection.orgId })
			const skip = (reason: string) =>
				Effect.annotateCurrentSpan("maple.planetscale.skip_reason", reason).pipe(
					Effect.as<OrgOutcome>({ _tag: "Skipped" }),
				)
			const grant = yield* psOAuth.grantStatus(connection.orgId)
			if (grant.revokedAt !== null) return yield* skip("grant_revoked")
			const target = yield* managedTarget(connection)
			if (scrapesWithToken(target)) return yield* skip("prometheus")
			// Connections bound before the metrics API kept an enabled OAuth target that Prometheus
			// discovery rejects every minute; it only holds the branch filters now.
			if (target !== null && target.enabled && target.authType === "planetscale_oauth") {
				const pausedAt = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db.run(
						PG.update(ScrapeTargets)
							.set({ enabled: false, updatedAt: pausedAt })
							.where(($) => [$.orgId.eq(connection.orgId), $.id.eq(target.id)]),
					),
				)
			}
			// Guards against an overlapping tick only; each branch's watermark says what is due.
			const claim = yield* claimPollWork(
				connection.orgId,
				PLANETSCALE_METRICS_DATASET,
				"",
				ORG_LEASE_TTL_MS,
			)
			if (claim !== "claimed") return yield* skip(claim)

			const all = yield* branchesOf(connection, target)
			const branches = all.slice(0, MAX_BRANCHES_PER_ORG)
			if (all.length > branches.length) {
				yield* Effect.logWarning("PlanetScale metrics poll truncated the branch list").pipe(
					Effect.annotateLogs({
						orgId: connection.orgId,
						branches: all.length,
						polled: branches.length,
					}),
				)
			}
			const watermarks = yield* branchWatermarks(connection)
			const ingestKey = (yield* ingestKeys.getOrCreate(connection.orgId, SYSTEM_USER_ID)).publicKey

			const results = yield* Effect.forEach(
				branches,
				(branch) =>
					Effect.gen(function* () {
						// Out of lane time: the branch keeps its watermark and catches up next tick.
						if ((yield* Clock.currentTimeMillis) > deadlineMs)
							return { _tag: "Deferred" as const }
						const rows = yield* pollBranch(
							connection,
							branch,
							watermarks.get(branch.branchId) ?? null,
							ingestKey,
						)
						// Billing or a refused key: the org's state, recorded on the branch but not a fault.
						if (rows instanceof IngestRefused) {
							const error = rows.error.message
							yield* recordBranch(connection, branch, { error }).pipe(
								Effect.ignore({ log: "Warn" }),
							)
							return {
								_tag: "Failed" as const,
								error: `${branch.database}/${branch.branch}: ${error}`,
							}
						}
						return { _tag: "Ingested" as const, rows }
					}).pipe(
						// One branch's failure costs that branch a retry, not the org its poll.
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.interrupt
								: Effect.gen(function* () {
										const error = summarizeCause(cause)
										yield* Effect.logWarning(
											"PlanetScale branch metrics poll failed",
										).pipe(
											Effect.annotateLogs({
												orgId: connection.orgId,
												database: branch.database,
												branch: branch.branch,
												error,
											}),
										)
										yield* recordBranch(connection, branch, { error }).pipe(
											Effect.ignore({ log: "Warn" }),
										)
										return {
											_tag: "Failed" as const,
											error: `${branch.database}/${branch.branch}: ${error}`,
										}
									}),
						),
					),
				{ concurrency: BRANCH_CONCURRENCY },
			)
			const failures = results.flatMap((result) => (result._tag === "Failed" ? [result.error] : []))
			const deferred = results.filter((result) => result._tag === "Deferred").length
			const rows = results.reduce(
				(sum, result) => sum + (result._tag === "Ingested" ? result.rows : 0),
				0,
			)
			yield* recordPollResult(
				connection.orgId,
				PLANETSCALE_METRICS_DATASET,
				"",
				failures.length === 0
					? null
					: `${failures.length} of ${branches.length} branches failed. ${failures[0]}`.slice(
							0,
							500,
						),
				null,
			)
			yield* Effect.annotateCurrentSpan({
				"maple.planetscale.metrics.branches": branches.length,
				"maple.planetscale.metrics.failed_branches": failures.length,
				"maple.planetscale.metrics.deferred_branches": deferred,
				"maple.planetscale.metrics.rows": rows,
			})
			return {
				_tag: "Polled",
				branches: branches.length,
				rows,
				failed: failures.length > 0,
			} satisfies OrgOutcome
		})

		const pollAll = Effect.fn("PlanetScaleMetricsService.pollAll")(function* () {
			// The lane's inventory and webhook sync already ran; leave room before its deadline.
			const deadlineMs = (yield* Clock.currentTimeMillis) + POLL_BUDGET_MS
			const connections = yield* dbExecute((db) => db.run(PG.from(PlanetscaleConnections).select()))
			const outcomes = yield* Effect.forEach(
				connections,
				(connection) =>
					pollOrg(connection, deadlineMs).pipe(
						// A broken org must not stop the fleet.
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.interrupt
								: Effect.logWarning("PlanetScale metrics poll failed").pipe(
										Effect.annotateLogs({
											orgId: connection.orgId,
											error: summarizeCause(cause),
										}),
										Effect.as<OrgOutcome>({
											_tag: "Polled",
											branches: 0,
											rows: 0,
											failed: true,
										}),
									),
						),
					),
				{ concurrency: ORG_CONCURRENCY },
			)
			const polled = outcomes.flatMap((outcome) => (outcome._tag === "Polled" ? [outcome] : []))
			return {
				orgs: connections.length,
				polled: polled.length,
				branches: polled.reduce((sum, outcome) => sum + outcome.branches, 0),
				rowsIngested: polled.reduce((sum, outcome) => sum + outcome.rows, 0),
				failures: polled.filter((outcome) => outcome.failed).length,
			}
		})

		return { pollAll } satisfies PlanetScaleMetricsServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(PlanetScaleOAuthService.layer),
		Layer.provide(OrgIngestKeysService.layer),
	)
}
