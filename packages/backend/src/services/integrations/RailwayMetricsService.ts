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
import { pollStatus } from "./integration-inventory"
import * as PG from "@maple-dev/effect-orm/postgres"
import { leaseStillOurs } from "./lease"
import {
	type Lease,
	type LeaseSpec,
	leaseFree,
	makeSourceReporter,
	type PollFailure,
	pollFailureMessage,
	pollFailureOutcome,
	skipIfPaused,
	withLease,
} from "./poller"
import {
	RailwayConnections,
	RailwayEnvironments,
	type RailwayConnectionRow,
	type RailwayEnvironmentRow,
} from "@maple/db/tables"
import {
	DateTime,
	Clock,
	Context,
	Duration,
	Effect,
	Layer,
	Option,
	Schema,
	String as Str,
	Array as Arr,
	Record as Rec,
} from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { openSecret, sealSecret, secretKeyringFromEnv } from "@maple/backend/platform/SecretBox"
import { railwayTokenSlot } from "@maple/backend/platform/secret-slots"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { isolatePollFailure, pollFleet } from "./poll-fleet"
import { Env } from "@maple/backend/platform/Env"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import {
	deleteSourcesOf,
	upsertWithSource,
	integrationSourceName,
	stampedSourceId,
} from "@maple/backend/services/integrations/integration-sources"
import { metricRowsToOtlp } from "./cloudflare-analytics/otlp"
import { discover, fetchEnvironmentMetrics, RailwayApiError, type RailwayDiscovery } from "./railway/api"
import { mapRailwayMetrics } from "./railway/mapping"
import {
	IngestRefused,
	type IngestSendError,
	keepRefusal,
	makeIngestSender,
} from "@maple/backend/services/ingest/ingest-sender"

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
/**
 * Connect runs the first poll inline so the page has an hour of data when it loads, instead of
 * every environment sitting at "pending" until the next cron tick. What doesn't finish in time is
 * left to that tick; its watermarks are untouched.
 */
const POLL_NOW_TIMEOUT = Duration.seconds(20)

const decodeOrgId = Schema.decodeUnknownSync(OrgId)
const decodeUserId = Schema.decodeUnknownSync(UserId)
const ServicesJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))
const decodeServices = Schema.decodeUnknownOption(ServicesJson)
const encodeServices = Schema.encodeSync(ServicesJson)

const SYSTEM_USER_ID = decodeUserId("system-railway-metrics")

/** An environment with no good poll in this long reads stale, the same window as the inventory. */
const ENVIRONMENT_STALE_MS = 30 * 60_000

const TOKEN_REJECTED_REASON = "Railway rejected the token. Reconnect Railway with a new token."

const toPersistenceError = makePersistenceErrorMapper(IntegrationsPersistenceError, "Railway database error")

const floorToSample = (ms: number) => ms - (ms % SAMPLE_MS)

const parseServices = (json: string): Readonly<Record<string, string>> =>
	decodeServices(json).pipe((option) => (option._tag === "Some" ? option.value : {}))

/** What a Railway failure means for the tick, through the shared {@link PollFailure} table. */
const railwayFailure = (
	error: RailwayApiError | IntegrationsPersistenceError | IngestSendError,
): PollFailure => {
	if (error._tag !== "@maple/backend/integrations/RailwayApiError") {
		return { _tag: "Upstream", message: error.message }
	}
	switch (error.kind) {
		case "unauthorized":
			return { _tag: "Rejected", reason: error.message }
		case "rate_limited":
			return {
				_tag: "RateLimited",
				message: error.message,
				retryAfterMs:
					error.retryAfterSeconds === undefined ? undefined : error.retryAfterSeconds * 1000,
			}
		case "upstream":
			return { _tag: "Upstream", message: error.message }
	}
}

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
	/** The failure that ended the pass: the rest of the org's environments wait for the next tick. */
	readonly stopped: PollFailure | null
	/** The tick ran out of time; the rest catch up next tick. */
	readonly budgetSpent: boolean
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
	readonly pollAllOrgs: Effect.Effect<RailwayPollAllOrgsSummary, IntegrationsPersistenceError>
}

export class RailwayMetricsService extends Context.Service<RailwayMetricsService, RailwayMetricsServiceApi>()(
	"@maple/backend/services/RailwayMetricsService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient
			const ingestKeys = yield* OrgIngestKeysService
			const keyring = yield* secretKeyringFromEnv(
				env,
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

			const reportTick = makeSourceReporter(dbExecute, "railway")

			/** Enabled environments, and how many failed or fell behind, as the inventory counts them. */
			const environmentHealth = (orgId: OrgId, now: number) =>
				loadEnvironments(orgId).pipe(
					Effect.map((rows) => {
						const enabled = Arr.filter(rows, (row) => row.enabled)
						const unhealthy = Arr.filter(enabled, (row) => {
							const status = pollStatus(row, now, ENVIRONMENT_STALE_MS)
							return status === "failing" || status === "stale"
						})
						return { total: enabled.length, unhealthy: unhealthy.length }
					}),
				)

			const decryptToken = (connection: RailwayConnectionRow) =>
				openSecret(
					keyring,
					railwayTokenSlot,
					{ orgId: connection.orgId },
					{
						ciphertext: connection.tokenCiphertext,
						iv: connection.tokenIv,
						tag: connection.tokenTag,
					},
					() =>
						new IntegrationsPersistenceError({ message: "Failed to decrypt the Railway token" }),
				)

			/** Upsert discovered environments; soft-disable the ones that disappeared. */
			const reconcileEnvironments = Effect.fn("RailwayMetricsService.reconcileEnvironments")(function* (
				connection: RailwayConnectionRow,
				discovery: RailwayDiscovery,
				now: number,
			) {
				const existing = yield* loadEnvironments(connection.orgId)
				const discoveredIds = new Set(
					Arr.map(discovery.environments, (environment) => environment.environmentId),
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
										servicesJson: encodeServices(environment.services),
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
											servicesJson: encodeServices(environment.services),
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
					Arr.filter(
						existing,
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
					workspaceNames: Arr.join(discovery.workspaceNames, ", ") || null,
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
					environments: Arr.map(
						Arr.filter(environments, (row) => row.enabled).sort((a, b) => {
							const byProject = Str.localeCompare(b.projectName)(a.projectName)
							return byProject !== 0
								? byProject
								: Str.localeCompare(b.environmentName)(a.environmentName)
						}),
						(row) =>
							new RailwayEnvironmentStatus({
								projectId: row.projectId,
								projectName: row.projectName,
								environmentId: row.environmentId,
								environmentName: row.environmentName,
								serviceCount: Rec.keys(parseServices(row.servicesJson)).length,
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
				const token = Str.trim(rawToken)
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
				const encrypted = yield* sealSecret(
					keyring,
					railwayTokenSlot,
					{ orgId },
					token,
					(message) => new IntegrationsPersistenceError({ message }),
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

			/** The connection row is the tick's lease; a failed tick's back-off is its hold. */
			const railwayLease = (
				connectionId: string,
			): LeaseSpec<
				RailwayConnectionRow,
				PG.UpdateSetOf<typeof RailwayConnections>,
				IntegrationsPersistenceError
			> => ({
				leaseMs: LEASE_MS,
				claim: (leaseUntil, now) =>
					dbExecute((db) =>
						db.run(
							PG.update(RailwayConnections)
								.set({ leaseUntil, updatedAt: now })
								.where(($) => [
									$.id.eq(connectionId),
									leaseFree($.leaseUntil, $.holdUntil, now, LEASE_MS),
								])
								.returning(),
						),
					).pipe(Effect.map((rows) => rows[0] ?? null)),
				// Only against the token this pass ran with: a token saved meanwhile keeps its own state.
				write: (claimed, set) =>
					dbExecute((db) =>
						db.run(
							PG.update(RailwayConnections)
								.set(set)
								.where(($) => [
									$.id.eq(claimed.id),
									leaseStillOurs($.leaseUntil, claimed.leaseUntil),
									$.tokenCiphertext.eq(claimed.tokenCiphertext),
								])
								.returning("id"),
						),
					).pipe(Effect.map((rows) => rows.length > 0)),
				release: (holdUntil, now) => ({ leaseUntil: null, holdUntil, updatedAt: now }),
				// A token saved mid-tick still gets the row back, and the hold with it.
				releaseWrite: (claimed, set) =>
					dbExecute((db) =>
						db.run(
							PG.update(RailwayConnections)
								.set(set)
								.where(($) => [
									$.id.eq(claimed.id),
									leaseStillOurs($.leaseUntil, claimed.leaseUntil),
								])
								.returning("id"),
						),
					).pipe(Effect.map((rows) => rows.length > 0)),
			})

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
					"maple.railway.window_start": DateTime.formatIso(DateTime.makeUnsafe(window.startMs)),
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
			}, keepRefusal)

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
				const followClock = Effect.gen(function* () {
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
				})
				const leased = withLease(railwayLease(connection.id), now, (lease) =>
					pollClaimed(orgId, lease, skip),
				).pipe(Effect.map(Option.getOrElse(() => skip("lease held"))))
				return yield* leased.pipe(skipIfPaused(dbExecute, connection.sourceId, now, followClock))
			})

			const pollClaimed = Effect.fnUntraced(function* (
				orgId: OrgId,
				lease: Lease<
					RailwayConnectionRow,
					PG.UpdateSetOf<typeof RailwayConnections>,
					IntegrationsPersistenceError
				>,
				skip: (reason: string) => RailwayPollOrgSummary,
			) {
				const { row: claimed, now } = lease
				const token = yield* decryptToken(claimed)

				/** Railway refused the token: the row stops polling and its source reads disconnected. */
				const markAuthFailed = (message: string) =>
					lease
						.write({ authFailedAt: now, lastError: message, lastErrorAt: now, updatedAt: now })
						.pipe(
							Effect.flatMap((paused) =>
								paused
									? reportTick(
											claimed.sourceId,
											pollFailureOutcome({
												_tag: "Rejected",
												reason: TOKEN_REJECTED_REASON,
											}),
											now,
										)
									: Effect.void,
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
					yield* lease.holdFor(railwayFailure(discovery.failure))
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

				const loaded = yield* loadEnvironments(orgId)
				const enabled = Arr.filter(loaded, (row) => row.enabled)
				const environments = Arr.filter(
					Arr.map(enabled, (row) => ({ row, window: nextWindow(row.watermarkAt, now) })),
					(item) => item.window !== null,
				)
					// Most-behind first, so a tight call budget still spreads across environments.
					.sort((a, b) => (a.window?.startMs ?? 0) - (b.window?.startMs ?? 0))
					.slice(0, MAX_ENVIRONMENT_CALLS_PER_TICK)

				// `stopped` ends the pass: later environments are not polled this tick.
				const initial: RailwayPollTally = {
					callsMade: discoveryCalls,
					failures: discoveryError === null ? 0 : 1,
					rowsIngested: 0,
					lastError: discoveryError,
					stopped: null,
					budgetSpent: false,
				}
				const { callsMade, failures, rowsIngested, lastError, stopped } = yield* Effect.reduce(
					environments,
					() => initial,
					(tally, { row, window }) =>
						tally.stopped !== null || tally.budgetSpent || window === null
							? Effect.succeed(tally)
							: Effect.gen(function* () {
									// The rest catch up next tick; their watermarks are untouched.
									if ((yield* Clock.currentTimeMillis) - now >= TICK_BUDGET_MS) {
										return { ...tally, budgetSpent: true }
									}
									const called = { ...tally, callsMade: tally.callsMade + 1 }
									const result = yield* Effect.result(
										pollEnvironment(row, token, ingestKey.value, window, sourceId),
									)
									// The rows ingested, or why the environment failed.
									const outcome: number | PollFailure =
										result._tag === "Failure"
											? railwayFailure(result.failure)
											: result.success instanceof IngestRefused
												? {
														_tag: "IngestRefused",
														message: result.success.error.message,
													}
												: result.success
									if (typeof outcome === "number") {
										yield* updateEnvironment(row.id, {
											watermarkAt: window.endMs,
											lastSuccessAt: now,
											lastError: null,
											lastErrorAt: null,
											updatedAt: now,
										})
										return { ...called, rowsIngested: called.rowsIngested + outcome }
									}
									const failure = outcome
									const message = pollFailureMessage(failure)
									const failed = {
										...called,
										failures: called.failures + 1,
										lastError: message,
									}
									yield* Effect.logWarning("railway environment poll failed", {
										orgId,
										environmentId: row.environmentId,
										error: message,
										failure: failure._tag,
									})
									switch (failure._tag) {
										case "Rejected":
											yield* markAuthFailed(message)
											return { ...failed, stopped: failure }
										// The org's state, not this environment's: hold the row and stop.
										case "RateLimited":
										case "IngestRefused":
											yield* lease.holdFor(failure)
											return { ...failed, stopped: failure }
										case "Upstream":
											yield* updateEnvironment(row.id, {
												lastError: Str.slice(0, 500)(message),
												lastErrorAt: now,
												updatedAt: now,
											})
											return failed
									}
								}),
				)

				const stillOurs = yield* lease.write(
					lastError === null
						? { lastSuccessAt: now, lastError: null, lastErrorAt: null, updatedAt: now }
						: { lastError: Str.slice(0, 500)(lastError), lastErrorAt: now, updatedAt: now },
				)
				const resources = enabled.length >= 2 ? yield* environmentHealth(orgId, now) : undefined
				// A rejected token already reported itself disconnected.
				if (stillOurs && stopped?._tag !== "Rejected") {
					yield* reportTick(
						claimed.sourceId,
						stopped !== null
							? pollFailureOutcome(stopped, resources)
							: lastError === null
								? { _tag: "Ok", resources }
								: { _tag: "Failed", error: Str.slice(0, 500)(lastError), resources },
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
			})

			const pollAllOrgs = Effect.gen(function* () {
				const connections = yield* dbExecute((db) =>
					db.run(
						PG.from(RailwayConnections)
							.select("orgId")
							.where(($) => [$.authFailedAt.isNull()]),
					),
				)
				const summaries = yield* pollFleet(connections, (row) => pollOrg(decodeOrgId(row.orgId)), {
					message: "railway org poll failed",
					annotations: (row) => ({ orgId: row.orgId }),
					fallback: (row): RailwayPollOrgSummary => ({
						orgId: decodeOrgId(row.orgId),
						skipped: "org poll failed",
						callsMade: 0,
						rowsIngested: 0,
						failures: 1,
					}),
				})
				return {
					orgs: connections.length,
					rowsIngested: Arr.reduce(summaries, 0, (sum, summary) => sum + summary.rowsIngested),
					failures: Arr.reduce(summaries, 0, (sum, summary) => sum + summary.failures),
					skipped: Arr.filter(summaries, (summary) => summary.skipped !== null).length,
				} satisfies RailwayPollAllOrgsSummary
			}).pipe(Effect.withSpan("RailwayMetricsService.pollAllOrgs"))

			/** Best effort: a failed or slow poll still leaves the connection for the cron to catch up. */
			const pollNow = (orgId: OrgId) =>
				pollOrg(orgId).pipe(
					Effect.timeoutOption(POLL_NOW_TIMEOUT),
					isolatePollFailure("railway on-demand poll failed", { orgId }, undefined),
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
