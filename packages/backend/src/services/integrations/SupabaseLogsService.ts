/**
 * Supabase logs: every minute the alerting cron reads each opted-in project's new logs from the
 * Management API logs endpoint and ships them to the ingest gateway as OTLP logs.
 *
 * Supabase allows 10 logs queries a minute per project, so a caught-up project costs one query a
 * tick and a lagging one at most {@link MAX_QUERIES_PER_PROJECT}. The lease is per project (the
 * rate limit is per project, and one slow project must not hold its siblings back). Watermarks
 * only advance past rows ingest accepted.
 */
import {
	IntegrationsNotFoundError,
	IntegrationsPersistenceError,
	IntegrationsValidationError,
	OrgId,
	UserId,
} from "@maple/domain/http"
import type { SupabaseProjectRef } from "@maple/domain/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	SupabaseConnections,
	SupabaseProjects,
	type SupabaseConnectionRow,
	type SupabaseProjectRow,
} from "@maple/db/tables"
import { Array as Arr, Cause, Clock, Context, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { SupabaseOAuthService } from "@maple/backend/services/auth/SupabaseOAuthService"
import {
	type IngestSendError,
	isRefusal,
	makeIngestSender,
} from "@maple/backend/services/ingest/ingest-sender"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import {
	isSourcePaused,
	type PollOutcome,
	reportPoll,
	stampedSourceId,
} from "@maple/backend/services/org/integration-sources"
import {
	acceptedWatermark,
	advanceWatermark,
	decodeLogRows,
	LOGS_INITIAL_LOOKBACK_MS,
	logsToOtlp,
	nextLogsWindow,
	queryLogs,
} from "./supabase/logs"
import { shouldScrape } from "./supabase/scrape-targets"
import { UNHEALTHY_STATUSES } from "./SupabaseConnectionService"

/** Catch-up queries per project per tick; with the per-minute cron this stays well under 10/min. */
const MAX_QUERIES_PER_PROJECT = 3
/** Outlives the lane's 110s deadline, so an interrupted tick frees its projects on its own. */
const LEASE_MS = 3 * 60_000
/** No query starts after this, so a tick finishes inside its minute. */
const TICK_BUDGET_MS = 40_000
const RATE_LIMIT_HOLD_MS = 60_000
/** Ingest refused the org's key: retrying every minute cannot succeed. */
const REFUSED_HOLD_MS = 60 * 60_000
/** Records per ingest request; a full page is split so no body gets too large. */
const INGEST_CHUNK = 250
const ORG_CONCURRENCY = 3
const PROJECT_CONCURRENCY = 4

const REVOKED_REASON = "Supabase no longer accepts this authorization. Reconnect Supabase."
const SYSTEM_USER_ID = Schema.decodeSync(UserId)("system-supabase-logs")
const decodeOrgId = Schema.decodeUnknownSync(OrgId)

const toPersistenceError = makePersistenceErrorMapper(IntegrationsPersistenceError, "Supabase database error")

/** Whether a project is running, by the same statuses the metrics scrape uses. */
const isRunning = (project: SupabaseProjectRow) =>
	shouldScrape({ metricsEnabled: true, status: project.status, removedAt: project.removedAt })

interface ProjectPollResult {
	readonly calls: number
	readonly rows: number
	readonly error: string | null
	readonly rateLimited: boolean
	readonly revoked: boolean
	/** Ingest refused the org's key (billing, revoked key): the project backs off for an hour. */
	readonly refused: boolean
}

const EMPTY_RESULT: ProjectPollResult = {
	calls: 0,
	rows: 0,
	error: null,
	rateLimited: false,
	revoked: false,
	refused: false,
}

export interface SupabaseLogsPollOrgSummary {
	readonly orgId: OrgId
	readonly skipped: string | null
	readonly projects: number
	readonly calls: number
	readonly rows: number
	readonly failures: number
}

export interface SupabaseLogsPollAllSummary {
	readonly orgs: number
	readonly rows: number
	readonly failures: number
	readonly skipped: number
}

export interface SupabaseLogsServiceApi {
	/** Turning logs on starts reading five minutes back; off clears the error state. */
	readonly setLogsEnabled: (
		orgId: OrgId,
		ref: SupabaseProjectRef,
		enabled: boolean,
	) => Effect.Effect<
		void,
		IntegrationsNotFoundError | IntegrationsValidationError | IntegrationsPersistenceError
	>
	readonly pollOrg: (
		orgId: OrgId,
	) => Effect.Effect<SupabaseLogsPollOrgSummary, IntegrationsPersistenceError>
	readonly pollAllOrgs: () => Effect.Effect<SupabaseLogsPollAllSummary, IntegrationsPersistenceError>
}

export class SupabaseLogsService extends Context.Service<SupabaseLogsService, SupabaseLogsServiceApi>()(
	"@maple/api/services/SupabaseLogsService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const oauth = yield* SupabaseOAuthService
			const httpClient = yield* HttpClient.HttpClient
			const ingestKeys = yield* OrgIngestKeysService
			const ingest = yield* makeIngestSender
			const dbExecute = makeDbExecute(database, "SupabaseLogsService", toPersistenceError)

			const loadConnection = (orgId: OrgId) =>
				dbExecute((db) =>
					db.run(
						PG.from(SupabaseConnections)
							.select()
							.where(($) => [$.orgId.eq(orgId)])
							.limit(1),
					),
				).pipe(Effect.map((rows) => rows[0] ?? null))

			const loadProjects = (connection: SupabaseConnectionRow) =>
				dbExecute((db) =>
					db.run(
						PG.from(SupabaseProjects)
							.select()
							.where(($) => [$.connectionId.eq(connection.id), $.removedAt.isNull()]),
					),
				)

			/** Best effort: a failed health report must not fail the tick it describes. */
			const reportTick = (connection: SupabaseConnectionRow, outcome: PollOutcome, now: number) =>
				dbExecute((db) => reportPoll(db, connection.sourceId, outcome, now)).pipe(
					Effect.catchTag("@maple/http/errors/IntegrationsPersistenceError", (error) =>
						Effect.logWarning("supabase logs source health report failed").pipe(
							Effect.annotateLogs({ sourceId: connection.sourceId, error: error.message }),
						),
					),
				)

			const setLogsEnabled = Effect.fn("SupabaseLogsService.setLogsEnabled")(function* (
				orgId: OrgId,
				ref: SupabaseProjectRef,
				enabled: boolean,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.supabase.project_ref": ref, enabled })
				const now = yield* Clock.currentTimeMillis
				const changed = yield* dbExecute((db) =>
					db.run(
						PG.update(SupabaseProjects)
							.set(
								enabled
									? {
											logsEnabled: true,
											logsWatermarkAt: now - LOGS_INITIAL_LOOKBACK_MS,
											logsBoundaryIds: [],
											logsError: null,
											// Drops a refusal hold, so turning logs back on polls on the next tick.
											logsLeaseUntil: null,
											updatedAt: now,
										}
									: { logsEnabled: false, logsError: null, updatedAt: now },
							)
							// Re-enabling an enabled project keeps its watermark, so a repeated PATCH loses nothing.
							.where(($) => [
								$.orgId.eq(orgId),
								$.projectRef.eq(ref),
								$.removedAt.isNull(),
								// A log drain already delivers this project's logs; polling too would store them twice.
								...(enabled ? [$.logsEnabled.eq(false), $.logDrainEnabled.eq(false)] : []),
							])
							.returning("id"),
					),
				)
				if (changed.length > 0) return
				const existing = yield* dbExecute((db) =>
					db.run(
						PG.from(SupabaseProjects)
							.select("id", "logDrainEnabled")
							.where(($) => [$.orgId.eq(orgId), $.projectRef.eq(ref), $.removedAt.isNull()])
							.limit(1),
					),
				)
				const [project] = existing
				if (project === undefined) {
					return yield* new IntegrationsNotFoundError({
						message: `No Supabase project ${ref} is connected to this organization`,
					})
				}
				if (enabled && project.logDrainEnabled) {
					return yield* new IntegrationsValidationError({
						message: `Supabase project ${ref} delivers its logs through a log drain. Turn the drain off to poll instead.`,
					})
				}
			})

			const claimLease = (project: SupabaseProjectRow, now: number) =>
				dbExecute((db) =>
					db.run(
						PG.update(SupabaseProjects)
							.set({ logsLeaseUntil: now + LEASE_MS })
							.where(($) => [
								$.id.eq(project.id),
								$.logsEnabled.eq(true),
								PG.or(
									$.logsLeaseUntil.isNull(),
									$.logsLeaseUntil.lt(now),
									// A bogus far-future lease (clock jump, crashed writer) must not wedge the project;
									// the bound sits above the longest intentional hold so refusal holds survive.
									$.logsLeaseUntil.gt(now + REFUSED_HOLD_MS + LEASE_MS),
								),
							])
							.returning(),
					),
				).pipe(Effect.map((rows) => rows[0] ?? null))

			/** Compare-and-set on our own claim so a late tick never clears a successor's lease. */
			const releaseLease = (claimed: SupabaseProjectRow, holdUntil: number | null) =>
				dbExecute((db) =>
					db.run(
						PG.update(SupabaseProjects)
							.set({ logsLeaseUntil: holdUntil })
							.where(($) => [
								$.id.eq(claimed.id),
								claimed.logsLeaseUntil === null
									? $.logsLeaseUntil.isNull()
									: $.logsLeaseUntil.eq(claimed.logsLeaseUntil),
							]),
					),
				)

			/** Writes only while this tick still holds the project's lease and logs are still on. */
			const updateClaimed = (
				claimed: SupabaseProjectRow,
				set: PG.UpdateSetOf<typeof SupabaseProjects>,
			) =>
				dbExecute((db) =>
					db.run(
						PG.update(SupabaseProjects)
							.set(set)
							.where(($) => [
								$.id.eq(claimed.id),
								$.logsEnabled.eq(true),
								claimed.logsLeaseUntil === null
									? $.logsLeaseUntil.isNull()
									: $.logsLeaseUntil.eq(claimed.logsLeaseUntil),
							]),
					),
				)

			const pollProject = Effect.fn("SupabaseLogsService.pollProject")(function* (
				connection: SupabaseConnectionRow,
				project: SupabaseProjectRow,
				ingestKey: string,
				tickStartedAt: number,
			) {
				const orgId = connection.orgId
				yield* Effect.annotateCurrentSpan({ orgId, "maple.supabase.project_ref": project.projectRef })
				const now = yield* Clock.currentTimeMillis
				const claimed = yield* claimLease(project, now)
				if (claimed === null) return EMPTY_RESULT
				const resource = {
					projectRef: claimed.projectRef,
					projectName: claimed.name,
					region: claimed.region,
					organizationSlug: connection.supabaseOrganizationSlug,
					sourceId: stampedSourceId(connection.sourceId),
				}

				const recordError = (message: string) =>
					updateClaimed(claimed, { logsError: message.slice(0, 500) }).pipe(Effect.as(message))

				/** One query and its batch; recurses while the project is behind and the tick has budget. */
				const step = (
					watermarkAt: number | null,
					boundaryIds: ReadonlyArray<string>,
					tally: ProjectPollResult,
				): Effect.Effect<ProjectPollResult, IntegrationsPersistenceError> =>
					Effect.gen(function* () {
						const window = nextLogsWindow(watermarkAt, now)
						const elapsed = (yield* Clock.currentTimeMillis) - tickStartedAt
						if (
							window === null ||
							tally.calls >= MAX_QUERIES_PER_PROJECT ||
							elapsed >= TICK_BUDGET_MS
						) {
							return tally
						}
						const called = { ...tally, calls: tally.calls + 1 }
						const page = yield* Effect.result(
							oauth.withAccessToken(orgId, (accessToken) =>
								queryLogs(
									httpClient,
									oauth.apiBaseUrl,
									accessToken,
									claimed.projectRef,
									window,
								),
							),
						)
						if (page._tag === "Failure") {
							const failure = page.failure
							// A 429 waits for the next tick with the watermark kept; it is not an error.
							if (
								failure._tag === "@maple/supabase/SupabaseApiError" &&
								failure.kind === "rate_limited"
							) {
								return { ...called, rateLimited: true }
							}
							if (failure._tag === "@maple/http/errors/IntegrationsRevokedError") {
								return { ...called, revoked: true }
							}
							yield* Effect.logWarning("supabase logs query failed", {
								orgId,
								projectRef: claimed.projectRef,
								tag: failure._tag,
								error: failure.message,
							})
							return { ...called, error: yield* recordError(failure.message) }
						}
						const rows = decodeLogRows(page.success)
						const sent = new Set(boundaryIds)
						const fresh = rows.filter((row) => !sent.has(row.id))
						const chunks = Arr.chunksOf(fresh, INGEST_CHUNK)
						// Ingest has no dedup: each accepted chunk moves the watermark past it, so a later
						// failure resumes after the last accepted row instead of resending it.
						const sendFrom = (
							index: number,
							delivered: number,
						): Effect.Effect<
							{ readonly delivered: number; readonly failure: IngestSendError | null },
							IntegrationsPersistenceError
						> =>
							Effect.gen(function* () {
								const chunk = chunks[index]
								if (chunk === undefined) return { delivered, failure: null }
								const accepted = yield* Effect.result(
									ingest.send({
										signal: "logs",
										ingestKey,
										payload: logsToOtlp(resource, chunk),
										label: "Supabase logs",
									}),
								)
								if (accepted._tag === "Failure")
									return { delivered, failure: accepted.failure }
								if (index < chunks.length - 1) {
									const mark = acceptedWatermark(rows, Arr.lastNonEmpty(chunk))
									yield* updateClaimed(claimed, {
										logsWatermarkAt: mark.watermarkAt,
										logsBoundaryIds: mark.boundaryIds,
										logsLastPolledAt: now,
									})
								}
								return yield* sendFrom(index + 1, delivered + chunk.length)
							})
						const delivery = yield* sendFrom(0, 0)
						if (delivery.failure !== null) {
							yield* Effect.logWarning("supabase logs ingest failed", {
								orgId,
								projectRef: claimed.projectRef,
								error: delivery.failure.message,
							})
							return {
								...called,
								rows: called.rows + delivery.delivered,
								refused: isRefusal(delivery.failure),
								error: yield* recordError(delivery.failure.message),
							}
						}
						const next = advanceWatermark(window, page.success.length, rows, fresh.length)
						yield* updateClaimed(claimed, {
							logsWatermarkAt: next.watermarkAt,
							logsBoundaryIds: next.boundaryIds,
							logsLastPolledAt: now,
							logsError: null,
						})
						return yield* step(next.watermarkAt, next.boundaryIds, {
							...called,
							rows: called.rows + fresh.length,
						})
					})

				const result = yield* step(
					claimed.logsWatermarkAt,
					claimed.logsBoundaryIds,
					EMPTY_RESULT,
				).pipe(
					Effect.tap((result) =>
						Effect.annotateCurrentSpan({
							"maple.supabase.logs.rows": result.rows,
							"maple.supabase.logs.calls": result.calls,
						}),
					),
					Effect.onExit((exit) =>
						releaseLease(
							claimed,
							exit._tag !== "Success"
								? null
								: exit.value.refused
									? now + REFUSED_HOLD_MS
									: exit.value.rateLimited
										? now + RATE_LIMIT_HOLD_MS
										: null,
						).pipe(Effect.ignore),
					),
				)
				return result
			})

			const pollOrgAt = Effect.fn("SupabaseLogsService.pollOrg")(function* (
				orgId: OrgId,
				tickStartedAt: number,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const skip = (reason: string): SupabaseLogsPollOrgSummary => ({
					orgId,
					skipped: reason,
					projects: 0,
					calls: 0,
					rows: 0,
					failures: 0,
				})
				const connection = yield* loadConnection(orgId)
				if (connection === null) return skip("not connected")
				const now = yield* Clock.currentTimeMillis
				if (!(yield* oauth.isGrantUsable(orgId))) {
					yield* reportTick(connection, { _tag: "Disconnected", reason: REVOKED_REASON }, now)
					return skip("grant revoked")
				}
				const projects = yield* loadProjects(connection)
				const due = projects.filter((project) => project.logsEnabled && isRunning(project))
				if (due.length === 0) return skip("no projects")

				// A paused source reads nothing; its watermarks follow the clock so a resume starts at now.
				if (yield* dbExecute((db) => isSourcePaused(db, connection.sourceId, now))) {
					const horizon = nextLogsWindow(null, now)?.endMs ?? now
					yield* dbExecute((db) =>
						db.run(
							PG.update(SupabaseProjects)
								.set({ logsWatermarkAt: horizon, logsBoundaryIds: [] })
								.where(($) => [
									$.connectionId.eq(connection.id),
									$.logsEnabled.eq(true),
									PG.or($.logsWatermarkAt.isNull(), $.logsWatermarkAt.lt(horizon)),
								]),
						),
					)
					return skip("source paused")
				}

				const ingestKey = yield* ingestKeys.getOrCreate(orgId, SYSTEM_USER_ID).pipe(
					Effect.map((keys) => keys.publicKey),
					Effect.option,
				)
				if (ingestKey._tag === "None") return skip("ingest key unavailable")

				const results = yield* Effect.forEach(
					due,
					(project) => pollProject(connection, project, ingestKey.value, tickStartedAt),
					{ concurrency: PROJECT_CONCURRENCY },
				)
				const errors = results.flatMap((result) => (result.error === null ? [] : [result.error]))
				const resources = {
					total: projects.length,
					unhealthy: projects.filter((project) => UNHEALTHY_STATUSES.has(project.status)).length,
				}
				const revoked = results.some((result) => result.revoked)
				yield* reportTick(
					connection,
					revoked
						? { _tag: "Disconnected", reason: REVOKED_REASON }
						: errors[0] === undefined
							? { _tag: "Ok", resources }
							: { _tag: "Failed", error: errors[0].slice(0, 500), resources },
					now,
				)
				const summary = {
					orgId,
					skipped: null,
					projects: due.length,
					calls: results.reduce((sum, result) => sum + result.calls, 0),
					rows: results.reduce((sum, result) => sum + result.rows, 0),
					failures: errors.length,
				} satisfies SupabaseLogsPollOrgSummary
				yield* Effect.annotateCurrentSpan({
					"maple.supabase.logs.rows": summary.rows,
					"maple.supabase.logs.calls": summary.calls,
					"maple.supabase.logs.failures": summary.failures,
				})
				return summary
			})

			const pollOrg = (orgId: OrgId) =>
				Clock.currentTimeMillis.pipe(Effect.flatMap((started) => pollOrgAt(orgId, started)))

			const pollAllOrgs = Effect.fn("SupabaseLogsService.pollAllOrgs")(function* () {
				const started = yield* Clock.currentTimeMillis
				const orgs = yield* dbExecute((db) =>
					db.run(
						PG.from(SupabaseProjects)
							.select("orgId")
							.distinct()
							.where(($) => [$.logsEnabled.eq(true), $.removedAt.isNull()]),
					),
				)
				const summaries = yield* Effect.forEach(
					orgs,
					(row) =>
						pollOrgAt(decodeOrgId(row.orgId), started).pipe(
							Effect.catchCause((cause) =>
								Cause.hasInterruptsOnly(cause)
									? Effect.interrupt
									: Effect.logWarning("supabase logs org poll failed", {
											orgId: row.orgId,
											error: summarizeCause(cause),
										}).pipe(
											Effect.as<SupabaseLogsPollOrgSummary>({
												orgId: decodeOrgId(row.orgId),
												skipped: "org poll failed",
												projects: 0,
												calls: 0,
												rows: 0,
												failures: 1,
											}),
										),
							),
						),
					{ concurrency: ORG_CONCURRENCY },
				)
				const summary = {
					orgs: orgs.length,
					rows: summaries.reduce((sum, item) => sum + item.rows, 0),
					failures: summaries.reduce((sum, item) => sum + item.failures, 0),
					skipped: summaries.filter((item) => item.skipped !== null).length,
				} satisfies SupabaseLogsPollAllSummary
				yield* Effect.annotateCurrentSpan({
					"maple.supabase.orgs": summary.orgs,
					"maple.supabase.logs.rows": summary.rows,
					"maple.supabase.logs.failures": summary.failures,
				})
				return summary
			})

			return { setLogsEnabled, pollOrg, pollAllOrgs } satisfies SupabaseLogsServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(SupabaseOAuthService.layer),
		Layer.provide(OrgIngestKeysService.layer),
	)
}
