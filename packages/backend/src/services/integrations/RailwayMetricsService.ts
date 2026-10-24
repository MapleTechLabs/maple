/**
 * Railway metrics integration: an org saves a Railway account or workspace token, and the
 * alerting cron polls Railway's GraphQL `metrics` query once per environment every 5 minutes,
 * shipping CPU / memory / network / disk samples to the ingest gateway as OTLP gauges.
 *
 * Railway has no metrics export, so polling is the only option. Its API is rate limited per token
 * (100/h on Free, 1000/h on Hobby), which is why each environment costs exactly one call per tick
 * and discovery runs hourly. Watermarks only advance after ingest accepts a batch.
 */
import { randomUUID } from "node:crypto"
import {
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	OrgId,
	RailwayEnvironmentStatus,
	RailwayIntegrationStatus,
	UserId,
} from "@maple/domain/http"
import { pollStatus } from "@maple/domain/integration-inventory"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	RailwayConnections,
	RailwayEnvironments,
	type RailwayConnectionRow,
	type RailwayEnvironmentRow,
} from "@maple/db/tables"
import { Cause, Clock, Context, Duration, Effect, Layer, Redacted, Ref, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey } from "@maple/backend/platform/Crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { Env } from "@maple/backend/platform/Env"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import {
	deleteSourcesOf,
	upsertWithSource,
	integrationSourceName,
	isSourcePaused,
	type PollOutcome,
	reportPoll,
	stampedSourceId,
} from "@maple/backend/services/org/integration-sources"
import { metricRowsToOtlp } from "./cloudflare-analytics/otlp"
import { discover, fetchEnvironmentMetrics, RailwayApiError, type RailwayDiscovery } from "./railway/api"
import { mapRailwayMetrics } from "./railway/mapping"
import { isRefusal, makeIngestSender } from "@maple/backend/services/ingest/ingest-sender"

const SAMPLE_RATE_SECONDS = 60
const SAMPLE_MS = SAMPLE_RATE_SECONDS * 1000
/** Railway's newest samples are still being averaged; stay this far behind now. */
const SAFETY_LAG_MS = 2 * 60_000
/** History pulled on a fresh environment. Railway keeps 30 days; an hour fills the charts. */
const INITIAL_BACKFILL_MS = 60 * 60_000
/** Cap per call, so a long outage catches up without one huge response. */
const MAX_WINDOW_MS = 6 * 60 * 60_000
const DISCOVERY_TTL_MS = 60 * 60_000
const LEASE_MS = 4 * 60_000
/**
 * A tick must finish inside its lease or the next one overlaps it. Discovery is capped at 60s,
 * each environment at 30s (Railway) + 30s (ingest), and no environment starts after this budget.
 */
const TICK_BUDGET_MS = 2.5 * 60_000
const DISCOVERY_TIMEOUT = Duration.seconds(60)
const MAX_ENVIRONMENT_CALLS_PER_TICK = 15
const RATE_LIMIT_HOLD_MS = 15 * 60_000
const BILLING_HOLD_MS = 60 * 60_000
const ORG_CONCURRENCY = 3
/**
 * Connect runs the first poll inline so the page has an hour of data when it loads, instead of
 * every environment sitting at "pending" until the next cron tick. What doesn't finish in time is
 * left to that tick; its watermarks are untouched.
 */
const POLL_NOW_TIMEOUT = Duration.seconds(20)

const decodeOrgId = Schema.decodeUnknownSync(OrgId)
const decodeUserId = Schema.decodeUnknownSync(UserId)
const decodeServices = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
)

const SYSTEM_USER_ID = decodeUserId("system-railway-metrics")

/** An environment with no good poll in this long reads stale, the same window as the inventory. */
const ENVIRONMENT_STALE_MS = 30 * 60_000

const TOKEN_REJECTED_REASON = "Railway rejected the token. Reconnect Railway with a new token."

const toPersistenceError = makePersistenceErrorMapper(IntegrationsPersistenceError, "Railway database error")

const floorToSample = (ms: number) => ms - (ms % SAMPLE_MS)

/** Binds each ciphertext to its org so a row copied across orgs fails to decrypt. */
const tokenAad = (orgId: OrgId) => Buffer.from(`railway-token:${orgId}`)

const parseServices = (json: string): Readonly<Record<string, string>> =>
	decodeServices(json).pipe((option) => (option._tag === "Some" ? option.value : {}))

/** Next window for an environment, or null when it is caught up. */
export const nextWindow = (watermarkAt: number | null, now: number) => {
	const horizonMs = floorToSample(now - SAFETY_LAG_MS)
	const startMs = watermarkAt === null ? horizonMs - INITIAL_BACKFILL_MS : watermarkAt
	// Cap the end, not the start: a long gap catches up one window per tick instead of being skipped.
	const endMs = Math.min(horizonMs, startMs + MAX_WINDOW_MS)
	return startMs < endMs ? { startMs, endMs } : null
}

/** Running counts of one org's poll; `stopped` ends the pass early. */
interface RailwayPollTally {
	readonly callsMade: number
	readonly failures: number
	readonly rowsIngested: number
	readonly lastError: string | null
	readonly stopped: boolean
	/** Railway rejected the token mid-pass; the source already reads disconnected. */
	readonly rejected: boolean
}

export interface RailwayPollOrgSummary {
	readonly orgId: OrgId
	readonly skipped: string | null
	readonly callsMade: number
	readonly rowsIngested: number
	readonly failures: number
}

export interface RailwayPollAllOrgsSummary {
	readonly orgs: number
	readonly rowsIngested: number
	readonly failures: number
	readonly skipped: number
}

export interface RailwayMetricsServiceApi {
	readonly getStatus: (
		orgId: OrgId,
	) => Effect.Effect<RailwayIntegrationStatus, IntegrationsPersistenceError>
	readonly connect: (
		orgId: OrgId,
		userId: UserId,
		token: string,
	) => Effect.Effect<
		RailwayIntegrationStatus,
		IntegrationsValidationError | IntegrationsUpstreamError | IntegrationsPersistenceError
	>
	readonly disconnect: (
		orgId: OrgId,
	) => Effect.Effect<{ readonly disconnected: boolean }, IntegrationsPersistenceError>
	/** Polls now instead of waiting for the cron. Caught-up environments cost no Railway call. */
	readonly sync: (orgId: OrgId) => Effect.Effect<RailwayIntegrationStatus, IntegrationsPersistenceError>
	readonly pollOrg: (orgId: OrgId) => Effect.Effect<RailwayPollOrgSummary, IntegrationsPersistenceError>
	readonly pollAllOrgs: () => Effect.Effect<RailwayPollAllOrgsSummary, IntegrationsPersistenceError>
}

export class RailwayMetricsService extends Context.Service<RailwayMetricsService, RailwayMetricsServiceApi>()(
	"@maple/backend/services/RailwayMetricsService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient
			const ingestKeys = yield* OrgIngestKeysService
			const encryptionKey = yield* parseBase64Aes256GcmKey(
				Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
				(message) => new IntegrationsPersistenceError({ message }),
			)
			const ingest = yield* makeIngestSender
			const dbExecute = makeDbExecute(database, "RailwayMetricsService", toPersistenceError)

			const loadConnection = (orgId: OrgId) =>
				dbExecute((db) =>
					db.run(
						PG.from(RailwayConnections)
							.select()
							.where(($) => [$.orgId.eq(orgId)])
							.limit(1),
					),
				).pipe(Effect.map((rows) => rows[0] ?? null))

			const loadEnvironments = (orgId: OrgId) =>
				dbExecute((db) =>
					db.run(
						PG.from(RailwayEnvironments)
							.select()
							.where(($) => [$.orgId.eq(orgId)]),
					),
				)

			const updateConnection = (connectionId: string, set: PG.UpdateSetOf<typeof RailwayConnections>) =>
				dbExecute((db) =>
					db.run(
						PG.update(RailwayConnections)
							.set(set)
							.where(($) => [$.id.eq(connectionId)]),
					),
				)

			const updateEnvironment = (rowId: string, set: PG.UpdateSetOf<typeof RailwayEnvironments>) =>
				dbExecute((db) =>
					db.run(
						PG.update(RailwayEnvironments)
							.set(set)
							.where(($) => [$.id.eq(rowId)]),
					),
				)

			/** Best effort: a failed health report must not fail the tick it describes. */
			const reportTick = (
				sourceId: RailwayConnectionRow["sourceId"],
				outcome: PollOutcome,
				now: number,
			) =>
				dbExecute((db) => reportPoll(db, sourceId, outcome, now)).pipe(
					Effect.catchTag("@maple/http/errors/IntegrationsPersistenceError", (error) =>
						Effect.logWarning("railway source health report failed").pipe(
							Effect.annotateLogs({ sourceId, error: error.message }),
						),
					),
				)

			/** Enabled environments, and how many failed or fell behind, as the inventory counts them. */
			const environmentHealth = (orgId: OrgId, now: number) =>
				loadEnvironments(orgId).pipe(
					Effect.map((rows) => {
						const enabled = rows.filter((row) => row.enabled)
						const unhealthy = enabled.filter((row) => {
							const status = pollStatus(row, now, ENVIRONMENT_STALE_MS)
							return status === "failing" || status === "stale"
						})
						return { total: enabled.length, unhealthy: unhealthy.length }
					}),
				)

			const decryptToken = (connection: RailwayConnectionRow) =>
				decryptAes256Gcm(
					{
						ciphertext: connection.tokenCiphertext,
						iv: connection.tokenIv,
						tag: connection.tokenTag,
					},
					encryptionKey,
					() =>
						new IntegrationsPersistenceError({ message: "Failed to decrypt the Railway token" }),
					tokenAad(connection.orgId),
				)

			/** Upsert discovered environments; soft-disable the ones that disappeared. */
			const reconcileEnvironments = Effect.fn("RailwayMetricsService.reconcileEnvironments")(function* (
				connection: RailwayConnectionRow,
				discovery: RailwayDiscovery,
				now: number,
			) {
				const existing = yield* loadEnvironments(connection.orgId)
				const discoveredIds = new Set(
					discovery.environments.map((environment) => environment.environmentId),
				)
				yield* Effect.forEach(
					discovery.environments,
					(environment) =>
						dbExecute((db) =>
							db.run(
								PG.insertInto(RailwayEnvironments)
									.values({
										id: randomUUID(),
										orgId: connection.orgId,
										connectionId: connection.id,
										projectId: environment.projectId,
										projectName: environment.projectName,
										environmentId: environment.environmentId,
										environmentName: environment.environmentName,
										servicesJson: JSON.stringify(environment.services),
										enabled: true,
										createdAt: now,
										updatedAt: now,
									})
									.onConflictDoUpdate({
										target: ["orgId", "environmentId"],
										set: () => ({
											connectionId: connection.id,
											projectId: environment.projectId,
											projectName: environment.projectName,
											environmentName: environment.environmentName,
											servicesJson: JSON.stringify(environment.services),
											enabled: true,
											updatedAt: now,
										}),
									}),
							),
						),
					{ discard: true },
				)
				// A project whose environment page came back full may have more; leave its unseen rows on.
				const truncated = new Set(discovery.truncatedProjectIds)
				yield* Effect.forEach(
					existing.filter(
						(row) =>
							row.enabled &&
							!discoveredIds.has(row.environmentId) &&
							!truncated.has(row.projectId),
					),
					(row) => updateEnvironment(row.id, { enabled: false, updatedAt: now }),
					{ discard: true },
				)
				yield* updateConnection(connection.id, {
					discoveredAt: now,
					workspaceNames: discovery.workspaceNames.join(", ") || null,
					updatedAt: now,
				})
			})

			const getStatus = Effect.fn("RailwayMetricsService.getStatus")(function* (orgId: OrgId) {
				const connection = yield* loadConnection(orgId)
				if (connection === null) {
					return new RailwayIntegrationStatus({
						connected: false,
						workspaceNames: null,
						connectedByUserId: null,
						connectedAt: null,
						authFailed: false,
						lastSyncedAt: null,
						lastError: null,
						environments: [],
					})
				}
				const environments = yield* loadEnvironments(orgId)
				return new RailwayIntegrationStatus({
					connected: true,
					workspaceNames: connection.workspaceNames,
					connectedByUserId: decodeUserId(connection.connectedByUserId),
					connectedAt: connection.createdAt,
					authFailed: connection.authFailedAt !== null,
					lastSyncedAt: connection.lastSuccessAt,
					lastError: connection.lastError,
					environments: environments
						.filter((row) => row.enabled)
						.sort(
							(a, b) =>
								a.projectName.localeCompare(b.projectName) ||
								a.environmentName.localeCompare(b.environmentName),
						)
						.map(
							(row) =>
								new RailwayEnvironmentStatus({
									projectId: row.projectId,
									projectName: row.projectName,
									environmentId: row.environmentId,
									environmentName: row.environmentName,
									serviceCount: Object.keys(parseServices(row.servicesJson)).length,
									enabled: row.enabled,
									lastSyncedAt: row.lastSuccessAt,
									lastError: row.lastError,
								}),
						),
				})
			})

			const connect = Effect.fn("RailwayMetricsService.connect")(function* (
				orgId: OrgId,
				userId: UserId,
				rawToken: string,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const token = rawToken.trim()
				const toConnectError = (error: RailwayApiError) =>
					error.kind === "unauthorized"
						? new IntegrationsValidationError({
								message:
									"Railway rejected this token. Create an account or workspace token at railway.com/account/tokens.",
							})
						: new IntegrationsUpstreamError({ message: error.message })
				const discovery = yield* discover(httpClient, token).pipe(Effect.mapError(toConnectError))
				// Prove the token can read metrics, not just list projects, before storing it.
				const probe = discovery.environments[0]
				if (probe !== undefined) {
					const now = yield* Clock.currentTimeMillis
					yield* fetchEnvironmentMetrics(httpClient, token, {
						environmentId: probe.environmentId,
						startMs: floorToSample(now) - 5 * 60_000,
						endMs: floorToSample(now),
						sampleRateSeconds: SAMPLE_RATE_SECONDS,
					}).pipe(Effect.mapError(toConnectError))
				}
				const encrypted = yield* encryptAes256Gcm(
					token,
					encryptionKey,
					(message) => new IntegrationsPersistenceError({ message }),
					tokenAad(orgId),
				)
				const now = yield* Clock.currentTimeMillis
				// A reconnect keeps the connection id and so its source.
				const connection = yield* dbExecute((db) =>
					db.transaction(
						upsertWithSource(
							db,
							orgId,
							{
								platform: "railway",
								name: integrationSourceName.railway({ workspaceNames: null }),
							},
							now,
							db
								.run(
									PG.from(RailwayConnections)
										.select("sourceId")
										.where(($) => [$.orgId.eq(orgId)])
										.limit(1)
										// Held until the upsert, so a concurrent disconnect cannot delete the reused source.
										.forUpdate(),
								)
								.pipe(Effect.map(([row]) => row?.sourceId ?? null)),
							(sourceId) =>
								db
									.run(
										PG.insertInto(RailwayConnections)
											.values({
												id: randomUUID(),
												orgId,
												sourceId,
												tokenCiphertext: encrypted.ciphertext,
												tokenIv: encrypted.iv,
												tokenTag: encrypted.tag,
												connectedByUserId: userId,
												createdAt: now,
												updatedAt: now,
											})
											.onConflictDoUpdate({
												target: ["orgId"],
												set: () => ({
													tokenCiphertext: encrypted.ciphertext,
													tokenIv: encrypted.iv,
													tokenTag: encrypted.tag,
													connectedByUserId: userId,
													authFailedAt: null,
													lastError: null,
													lastErrorAt: null,
													updatedAt: now,
												}),
											})
											.returning(),
									)
									.pipe(Effect.map(([row]) => row)),
						),
					),
				)
				if (connection === undefined) {
					return yield* new IntegrationsPersistenceError({
						message: "Failed to save the Railway connection",
					})
				}
				yield* reconcileEnvironments(connection, discovery, now)
				yield* pollNow(orgId)
				return yield* getStatus(orgId)
			})

			const disconnect = Effect.fn("RailwayMetricsService.disconnect")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				// The connection's source goes with it.
				const deleted = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* db.run(
								PG.deleteFrom(RailwayEnvironments).where(($) => [$.orgId.eq(orgId)]),
							)
							const rows = yield* db.run(
								PG.deleteFrom(RailwayConnections)
									.where(($) => [$.orgId.eq(orgId)])
									.returning("id", "sourceId"),
							)
							yield* deleteSourcesOf(db, orgId, rows)
							return rows
						}),
					),
				)
				return { disconnected: deleted.length > 0 }
			})

			const claimLease = (connectionId: string, now: number) =>
				dbExecute((db) =>
					db.run(
						PG.update(RailwayConnections)
							.set({ leaseUntil: now + LEASE_MS, updatedAt: now })
							.where(($) => [
								$.id.eq(connectionId),
								PG.or(
									$.leaseUntil.isNull(),
									$.leaseUntil.lt(now),
									// A bogus far-future lease (clock jump, crashed writer) must not wedge the org.
									$.leaseUntil.gt(now + 2 * BILLING_HOLD_MS),
								),
							])
							.returning(),
					),
				).pipe(Effect.map((rows) => rows[0] ?? null))

			/** Compare-and-set on our own claim so a late tick never clears a successor's lease. */
			const releaseLease = (
				connectionId: string,
				claimedUntil: number | null,
				holdUntilMs: number | null,
				now: number,
			) =>
				dbExecute((db) =>
					db.run(
						PG.update(RailwayConnections)
							.set({ leaseUntil: holdUntilMs, updatedAt: now })
							.where(($) => [
								$.id.eq(connectionId),
								claimedUntil === null ? $.leaseUntil.isNull() : $.leaseUntil.eq(claimedUntil),
							]),
					),
				)

			const emitMetrics = Effect.fnUntraced(function* (
				ingestKey: string,
				rows: ReturnType<typeof mapRailwayMetrics>,
				sourceId: string | undefined,
			) {
				if (rows.length === 0) return 0
				yield* ingest.send({
					signal: "metrics",
					ingestKey,
					payload: metricRowsToOtlp([], rows, { sourceId }),
					label: "Railway metrics",
				})
				return rows.length
			})

			const pollEnvironment = Effect.fn("RailwayMetricsService.pollEnvironment")(function* (
				row: RailwayEnvironmentRow,
				token: string,
				ingestKey: string,
				window: { readonly startMs: number; readonly endMs: number },
				sourceId: string | undefined,
			) {
				yield* Effect.annotateCurrentSpan({
					"maple.railway.environment_id": row.environmentId,
					"maple.railway.window_start": new Date(window.startMs).toISOString(),
				})
				const results = yield* fetchEnvironmentMetrics(httpClient, token, {
					environmentId: row.environmentId,
					startMs: window.startMs,
					endMs: window.endMs,
					sampleRateSeconds: SAMPLE_RATE_SECONDS,
				})
				const rows = mapRailwayMetrics(
					{
						projectId: row.projectId,
						projectName: row.projectName,
						environmentId: row.environmentId,
						environmentName: row.environmentName,
						services: parseServices(row.servicesJson),
					},
					results,
					window,
				)
				const ingested = yield* emitMetrics(ingestKey, rows, sourceId)
				yield* Effect.annotateCurrentSpan("maple.railway.rows_ingested", ingested)
				return ingested
			})

			const pollOrg = Effect.fn("RailwayMetricsService.pollOrg")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const skip = (reason: string): RailwayPollOrgSummary => ({
					orgId,
					skipped: reason,
					callsMade: 0,
					rowsIngested: 0,
					failures: 0,
				})
				const connection = yield* loadConnection(orgId)
				if (connection === null) return skip("not connected")
				if (connection.authFailedAt !== null) return skip("token rejected")

				const now = yield* Clock.currentTimeMillis
				// A paused source reads nothing; its watermarks follow the clock so a resume starts at now.
				if (yield* dbExecute((db) => isSourcePaused(db, connection.sourceId, now))) {
					const horizonMs = floorToSample(now - SAFETY_LAG_MS)
					yield* dbExecute((db) =>
						db.run(
							PG.update(RailwayEnvironments)
								.set({ watermarkAt: horizonMs, updatedAt: now })
								.where(($) => [
									$.connectionId.eq(connection.id),
									PG.or($.watermarkAt.isNull(), $.watermarkAt.lt(horizonMs)),
								]),
						),
					)
					return skip("source paused")
				}
				const claimed = yield* claimLease(connection.id, now)
				if (claimed === null) return skip("lease held")

				const holdUntilRef = yield* Ref.make<number | null>(null)
				const summary = yield* Effect.gen(function* () {
					const token = yield* decryptToken(claimed)

					const markAuthFailed = (message: string) =>
						updateConnection(claimed.id, {
							authFailedAt: now,
							lastError: message,
							lastErrorAt: now,
							updatedAt: now,
						}).pipe(
							Effect.andThen(
								reportTick(
									claimed.sourceId,
									{ _tag: "Disconnected", reason: TOKEN_REJECTED_REASON },
									now,
								),
							),
						)

					const needsDiscovery =
						claimed.discoveredAt === null || now - claimed.discoveredAt >= DISCOVERY_TTL_MS
					const discoveryCalls = needsDiscovery ? 2 : 0
					const discovery = needsDiscovery
						? yield* Effect.result(
								discover(httpClient, token).pipe(
									Effect.timeoutOrElse({
										duration: DISCOVERY_TIMEOUT,
										orElse: () =>
											Effect.fail(
												new RailwayApiError({
													message: "Railway discovery timed out",
													kind: "upstream",
												}),
											),
									}),
								),
							)
						: undefined
					if (discovery?._tag === "Success") {
						yield* reconcileEnvironments(claimed, discovery.success, now)
					} else if (discovery?.failure.kind === "unauthorized") {
						yield* markAuthFailed(discovery.failure.message)
						return { ...skip("token rejected"), callsMade: discoveryCalls }
					} else if (discovery?.failure.kind === "rate_limited") {
						yield* Ref.set(holdUntilRef, now + RATE_LIMIT_HOLD_MS)
						return { ...skip("rate limited"), callsMade: discoveryCalls }
					}
					const discoveryError = discovery?._tag === "Failure" ? discovery.failure.message : null

					const ingestKey = yield* ingestKeys.getOrCreate(orgId, SYSTEM_USER_ID).pipe(
						Effect.map((keys) => keys.publicKey),
						Effect.option,
					)
					if (ingestKey._tag === "None")
						return { ...skip("ingest key unavailable"), callsMade: discoveryCalls }
					const sourceId = stampedSourceId(claimed.sourceId)

					const enabled = (yield* loadEnvironments(orgId)).filter((row) => row.enabled)
					const environments = enabled
						.map((row) => ({ row, window: nextWindow(row.watermarkAt, now) }))
						.filter((item) => item.window !== null)
						// Most-behind first, so a tight call budget still spreads across environments.
						.sort((a, b) => (a.window?.startMs ?? 0) - (b.window?.startMs ?? 0))
						.slice(0, MAX_ENVIRONMENT_CALLS_PER_TICK)

					// `stopped` ends the pass: later environments are not polled this tick.
					const initial: RailwayPollTally = {
						callsMade: discoveryCalls,
						failures: discoveryError === null ? 0 : 1,
						rowsIngested: 0,
						lastError: discoveryError,
						stopped: false,
						rejected: false,
					}
					const { callsMade, failures, rowsIngested, lastError, rejected } = yield* Effect.reduce(
						environments,
						() => initial,
						(tally, { row, window }) =>
							tally.stopped || window === null
								? Effect.succeed(tally)
								: Effect.gen(function* () {
										// The rest catch up next tick; their watermarks are untouched.
										if ((yield* Clock.currentTimeMillis) - now >= TICK_BUDGET_MS) {
											return { ...tally, stopped: true }
										}
										const called = { ...tally, callsMade: tally.callsMade + 1 }
										const result = yield* Effect.result(
											pollEnvironment(row, token, ingestKey.value, window, sourceId),
										)
										if (result._tag === "Success") {
											yield* updateEnvironment(row.id, {
												watermarkAt: window.endMs,
												lastSuccessAt: now,
												lastError: null,
												lastErrorAt: null,
												updatedAt: now,
											})
											return {
												...called,
												rowsIngested: called.rowsIngested + result.success,
											}
										}
										const error = result.failure
										const failed = {
											...called,
											failures: called.failures + 1,
											lastError: error.message,
										}
										yield* Effect.logWarning("railway environment poll failed", {
											orgId,
											environmentId: row.environmentId,
											error: error.message,
										})
										if (error._tag === "@maple/backend/integrations/RailwayApiError") {
											if (error.kind === "unauthorized") {
												yield* markAuthFailed(error.message)
												return { ...failed, stopped: true, rejected: true }
											}
											if (error.kind === "rate_limited") {
												const retryMs = (error.retryAfterSeconds ?? 0) * 1000
												yield* Ref.set(
													holdUntilRef,
													now + Math.max(retryMs, RATE_LIMIT_HOLD_MS),
												)
												return { ...failed, stopped: true }
											}
										} else if (isRefusal(error)) {
											// Billing limit or a refused key: back off instead of retrying every tick.
											yield* Ref.set(holdUntilRef, now + BILLING_HOLD_MS)
											return { ...failed, stopped: true }
										}
										yield* updateEnvironment(row.id, {
											lastError: error.message.slice(0, 500),
											lastErrorAt: now,
											updatedAt: now,
										})
										return failed
									}),
					)

					yield* updateConnection(
						claimed.id,
						lastError === null
							? {
									lastSuccessAt: now,
									lastError: null,
									lastErrorAt: null,
									updatedAt: now,
								}
							: {
									lastError: lastError.slice(0, 500),
									lastErrorAt: now,
									updatedAt: now,
								},
					)
					const resources = enabled.length >= 2 ? yield* environmentHealth(orgId, now) : undefined
					if (!rejected) {
						yield* reportTick(
							claimed.sourceId,
							lastError === null
								? { _tag: "Ok", resources }
								: { _tag: "Failed", error: lastError.slice(0, 500), resources },
							now,
						)
					}
					yield* Effect.annotateCurrentSpan({
						"maple.railway.calls_made": callsMade,
						"maple.railway.rows_ingested": rowsIngested,
						"maple.railway.failures": failures,
					})
					return {
						orgId,
						skipped: null,
						callsMade,
						rowsIngested,
						failures,
					} satisfies RailwayPollOrgSummary
				}).pipe(
					Effect.ensuring(
						Ref.get(holdUntilRef).pipe(
							Effect.flatMap((holdUntil) =>
								releaseLease(claimed.id, claimed.leaseUntil, holdUntil, now),
							),
							Effect.ignore,
						),
					),
				)
				return summary
			})

			const pollAllOrgs = Effect.fn("RailwayMetricsService.pollAllOrgs")(function* () {
				const connections = yield* dbExecute((db) =>
					db.run(
						PG.from(RailwayConnections)
							.select("orgId")
							.where(($) => [$.authFailedAt.isNull()]),
					),
				)
				const summaries = yield* Effect.forEach(
					connections,
					(row) =>
						pollOrg(decodeOrgId(row.orgId)).pipe(
							Effect.catchCause((cause) =>
								Cause.hasInterruptsOnly(cause)
									? Effect.interrupt
									: Effect.logWarning("railway org poll failed", {
											orgId: row.orgId,
											error: summarizeCause(cause),
										}).pipe(
											Effect.as<RailwayPollOrgSummary>({
												orgId: decodeOrgId(row.orgId),
												skipped: "org poll failed",
												callsMade: 0,
												rowsIngested: 0,
												failures: 1,
											}),
										),
							),
						),
					{ concurrency: ORG_CONCURRENCY },
				)
				return {
					orgs: connections.length,
					rowsIngested: summaries.reduce((sum, summary) => sum + summary.rowsIngested, 0),
					failures: summaries.reduce((sum, summary) => sum + summary.failures, 0),
					skipped: summaries.filter((summary) => summary.skipped !== null).length,
				} satisfies RailwayPollAllOrgsSummary
			})

			/** Best effort: a failed or slow poll still leaves the connection for the cron to catch up. */
			const pollNow = (orgId: OrgId) =>
				pollOrg(orgId).pipe(
					Effect.timeoutOption(POLL_NOW_TIMEOUT),
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.interrupt
							: Effect.logWarning("railway on-demand poll failed", {
									orgId,
									error: summarizeCause(cause),
								}),
					),
					Effect.asVoid,
				)

			const sync = Effect.fn("RailwayMetricsService.sync")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				yield* pollNow(orgId)
				return yield* getStatus(orgId)
			})

			return {
				getStatus,
				connect,
				disconnect,
				sync,
				pollOrg,
				pollAllOrgs,
			} satisfies RailwayMetricsServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(OrgIngestKeysService.layer),
	)
}
