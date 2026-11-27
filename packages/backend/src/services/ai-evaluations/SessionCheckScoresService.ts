import * as PG from "@maple-dev/effect-orm/postgres"
import {
	buildSessionChecks,
	buildSessionFindings,
	buildSessionSummary,
	buildSessionTurns,
} from "@maple/agent-sessions"
import { AiEvaluationRuns } from "@maple/db/tables"
import { ListAiSessionsRequest, type OrgId } from "@maple/domain/http"
import type { AiSessionListItem as AiSessionListItemSchema } from "@maple/domain/http"
import { UserId } from "@maple/primitives"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Order, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { systemTenant } from "@maple/backend/services/auth/system-tenant"
import { AiSessionReadService } from "@maple/backend/services/ai-sessions/AiSessionReadService"
import { loadAiSessionSpans } from "@maple/backend/services/ai-sessions/load-session-spans"
import { isRefusal, makeIngestSender } from "@maple/backend/services/ingest/ingest-sender"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { sessionCheckScoresToOtlp } from "./session-check-scores"

/** A session idle this long is finished; one that resumes later is scored again, replacing it. */
export const SESSION_IDLE_MS = 15 * 60_000
/** How far back a newly enrolled org's first tick scores. */
export const ENROLL_LOOKBACK_MS = 3_600_000
/** Sessions one org scores per tick; past it the rest of the window is skipped and counted. */
export const SESSIONS_PER_TICK = 300
/** The oldest session end a tick looks at: a cursor stuck further back (flag off, a long outage)
 *  resumes from here instead of listing everything since. */
export const MAX_CURSOR_LAG_MS = 6 * 3_600_000
/** How far before the cursor the list starts: it lists by span START, so a session whose last
 *  span started before the cursor but ended after it is still found. */
export const LIST_LOOKBACK_MS = 3_600_000
/** A tick starts no new org past this, well inside the lane's 10-minute deadline. */
export const TICK_BUDGET_MS = 8 * 60_000
const LIST_PAGE = 100
/** Sessions one tick lists, scored or not; past it the cursor stops where the list did. */
const LIST_MAX_ROWS = 1_000
const SESSION_CONCURRENCY = 4
const ORG_CONCURRENCY = 2

type AiSessionListItem = typeof AiSessionListItemSchema.Type

const SYSTEM_USER_ID = UserId.make("system-session-checks")
const SCORER = "session_checks"

export class SessionCheckScoringError extends Schema.TaggedError<SessionCheckScoringError>()(
	"@maple/backend/ai-evaluations/SessionCheckScoringError",
	{ message: Schema.String },
) {}

export interface SessionCheckOrgResult {
	readonly orgId: OrgId
	readonly outcome: "scored" | "flag_off" | "not_due" | "failed" | "deferred"
	readonly scored: number
	/** Sessions whose scores the gateway did not take; they keep the cursor. */
	readonly failed: number
	/** Sessions left unscored: their spans could not be read, or only part of them could. */
	readonly skipped: number
	/** Finished sessions left out by the per-tick cap. */
	readonly capped: number
}

/** The window's finished sessions: last span after the cursor and at least idle-long ago. */
export const finishedSessions = (
	rows: ReadonlyArray<AiSessionListItem>,
	cursorMs: number,
	upperMs: number,
): ReadonlyArray<AiSessionListItem> =>
	Arr.filter(rows, (row) => {
		const endMs = parseWarehouseDateTime(row.endTime)
		return endMs > cursorMs && endMs <= upperMs
	})

/**
 * Writes each finished Agent Session's checks as `maple_check` evaluation scores, for the orgs
 * enrolled in `ai_evaluation_runs` that have the `llmEvals` flag. Enrollment happens when the org
 * first reads its evaluators. The cursor only moves once the gateway took every session's scores,
 * so a failed send is retried next tick; re-scores replace the earlier ones on read. A session
 * whose spans cannot be read whole is skipped, not retried: its checks would be wrong.
 */
export class SessionCheckScoresService extends Context.Service<SessionCheckScoresService>()(
	"@maple/backend/services/ai-evaluations/SessionCheckScoresService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const reads = yield* AiSessionReadService
			const featureFlags = yield* OrganizationFeatureFlagsService
			const ingestKeys = yield* OrgIngestKeysService
			const ingest = yield* makeIngestSender
			const dbExecute = makeDbExecute(
				database,
				"SessionCheckScoresService",
				(error) => new SessionCheckScoringError({ message: error.message }),
			)

			// Orgs this isolate already enrolled: the evaluators read calls `enroll` on every load.
			const enrolled = new Set<OrgId>()

			const enroll = Effect.fn("SessionCheckScores.enroll")(function* (orgId: OrgId) {
				if (enrolled.has(orgId)) return
				const now = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db.run(
						PG.insertInto(AiEvaluationRuns)
							.values({
								orgId,
								scorer: SCORER,
								cursorAt: now - ENROLL_LOOKBACK_MS,
								createdAt: now,
							})
							.onConflictDoNothing(),
					),
				)
				enrolled.add(orgId)
			})

			const listWindow = Effect.fn("SessionCheckScores.listWindow")(function* (
				orgId: OrgId,
				cursorMs: number,
				nowMs: number,
			) {
				const tenant = systemTenant(orgId, SYSTEM_USER_ID)
				const page = (offset: number) =>
					reads.list(
						tenant,
						new ListAiSessionsRequest({
							startTime: formatWarehouseDateTime(cursorMs - LIST_LOOKBACK_MS),
							endTime: formatWarehouseDateTime(nowMs),
							limit: LIST_PAGE,
							offset,
							sortBy: "startTime",
							sortDir: "asc",
						}),
					)
				const pages = (
					offset: number,
					acc: ReadonlyArray<AiSessionListItem>,
				): Effect.Effect<
					{ readonly rows: ReadonlyArray<AiSessionListItem>; readonly complete: boolean },
					Effect.Error<ReturnType<typeof page>>
				> =>
					page(offset).pipe(
						Effect.flatMap((response) => {
							const rows = [...acc, ...response.data]
							if (response.data.length < LIST_PAGE)
								return Effect.succeed({ rows, complete: true })
							return rows.length >= LIST_MAX_ROWS
								? Effect.succeed({ rows, complete: false })
								: pages(offset + LIST_PAGE, rows)
						}),
					)
				return yield* pages(0, [])
			})

			const scoreSession = Effect.fn("SessionCheckScores.scoreSession")(function* (
				orgId: OrgId,
				ingestKey: string,
				session: AiSessionListItem,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.ai.session.id": session.sessionId })
				const tenant = systemTenant(orgId, SYSTEM_USER_ID)
				const loaded = yield* loadAiSessionSpans(tenant, {
					sessionId: session.sessionId,
					window: undefined,
				}).pipe(
					Effect.provideService(AiSessionReadService, reads),
					Effect.catch((error) =>
						Effect.annotateCurrentSpan("maple.evals.load_error", error.message).pipe(
							Effect.as(undefined),
						),
					),
				)
				// Checks over part of a session would report a cut-off turn as a failure.
				if (loaded === undefined || loaded.spans.length === 0 || loaded.truncated !== false) {
					yield* Effect.annotateCurrentSpan("maple.evals.skipped", true)
					return false
				}
				const turns = buildSessionTurns(loaded.spans)
				const summary = buildSessionSummary({ spans: loaded.spans, turns })
				const report = buildSessionChecks(turns, summary, buildSessionFindings(turns, summary))
				yield* Effect.annotateCurrentSpan({
					"maple.ai.checks.failed": report.counts.failed,
					"maple.ai.checks.warning": report.counts.warning,
				})
				const scoredAtMs = yield* Clock.currentTimeMillis
				yield* ingest.send({
					signal: "logs",
					ingestKey,
					label: "Session check scores",
					payload: sessionCheckScoresToOtlp({
						sessionId: session.sessionId,
						report,
						serviceName: Option.getOrElse(Arr.head(session.serviceNames), () => "maple"),
						scoredAtMs,
					}),
				})
				return true
			})

			const scoreOrg = Effect.fn("SessionCheckScores.scoreOrg")(function* (
				orgId: OrgId,
				storedCursorMs: number,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const empty = { orgId, scored: 0, failed: 0, skipped: 0, capped: 0 }
				const flags = yield* featureFlags.flags(orgId)
				if (!flags.llmEvals) return { ...empty, outcome: "flag_off" } satisfies SessionCheckOrgResult
				const nowMs = yield* Clock.currentTimeMillis
				const upperMs = nowMs - SESSION_IDLE_MS
				const cursorMs = Math.max(storedCursorMs, nowMs - MAX_CURSOR_LAG_MS)
				if (upperMs <= cursorMs)
					return { ...empty, outcome: "not_due" } satisfies SessionCheckOrgResult

				const listed = yield* listWindow(orgId, cursorMs, nowMs)
				const finished = Arr.sort(
					finishedSessions(listed.rows, cursorMs, upperMs),
					Order.mapInput(Order.Number, (row: AiSessionListItem) =>
						parseWarehouseDateTime(row.endTime),
					),
				)
				const batch = Arr.take(finished, SESSIONS_PER_TICK)
				// The next cursor leaves every session this tick did not get to eligible: those past the
				// batch end after its last one, and those past a cut list started (so ended) after its last row.
				const nextCursorMs = Math.max(
					cursorMs,
					Math.min(
						upperMs,
						Option.match(Arr.get(finished, SESSIONS_PER_TICK), {
							onNone: () => upperMs,
							onSome: (row) => parseWarehouseDateTime(row.endTime) - 1,
						}),
						listed.complete
							? upperMs
							: Option.match(Arr.last(listed.rows), {
									onNone: () => upperMs,
									onSome: (row) => parseWarehouseDateTime(row.startTime) - 1,
								}),
					),
				)
				const ingestKey = (yield* ingestKeys.getOrCreate(orgId, SYSTEM_USER_ID)).publicKey
				const outcomes = yield* Effect.forEach(
					batch,
					(session) => Effect.result(scoreSession(orgId, ingestKey, session)),
					{ concurrency: SESSION_CONCURRENCY },
				)
				const failed = Arr.filter(outcomes, (outcome) => outcome._tag === "Failure")
				// A refusal (billing, a revoked key) is the org's state: resending next tick cannot help.
				const retryable = Arr.filter(
					failed,
					(outcome) => !(outcome._tag === "Failure" && isRefusal(outcome.failure)),
				)
				const scored = Arr.filter(
					outcomes,
					(outcome) => outcome._tag === "Success" && outcome.success,
				)
				const skipped = outcomes.length - failed.length - scored.length
				const capped = finished.length - batch.length
				yield* Effect.annotateCurrentSpan({
					"maple.evals.sessions_finished": finished.length,
					"maple.evals.sessions_scored": scored.length,
					"maple.evals.sessions_failed": failed.length,
					"maple.evals.sessions_skipped": skipped,
					"maple.evals.sessions_capped": capped,
					"maple.evals.list_complete": listed.complete,
				})
				const firstFailure = Option.flatMap(Arr.head(failed), (outcome) =>
					outcome._tag === "Failure" ? Option.some(outcome.failure) : Option.none(),
				)
				// A failed send keeps the cursor, so the next tick tries the window again.
				yield* dbExecute((db) =>
					db.run(
						PG.update(AiEvaluationRuns)
							.set({
								...(retryable.length === 0 ? { cursorAt: nextCursorMs } : undefined),
								lastRunAt: nowMs,
								lastError: Option.match(firstFailure, {
									onNone: () => null,
									onSome: (error) => error.message,
								}),
							})
							.where(($) => [$.orgId.eq(orgId), $.scorer.eq(SCORER)]),
					),
				)
				return {
					orgId,
					outcome: failed.length === 0 ? "scored" : "failed",
					scored: scored.length,
					failed: failed.length,
					skipped,
					capped,
				} satisfies SessionCheckOrgResult
			})

			const runTick = Effect.fn("SessionCheckScores.runTick")(function* () {
				const startedMs = yield* Clock.currentTimeMillis
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(AiEvaluationRuns)
							.select(($) => ({
								orgId: $.orgId,
								cursorAt: $.cursorAt,
								lastRunAt: $.lastRunAt,
							}))
							.where(($) => [$.scorer.eq(SCORER)]),
					),
				)
				// Least recently run first, so a tick cut short by its budget starts with the orgs it left.
				const due = Arr.sort(
					rows,
					Order.mapInput(Order.Number, (row: (typeof rows)[number]) =>
						row.lastRunAt === null ? -1 : row.lastRunAt,
					),
				)
				const deferred = (orgId: OrgId): SessionCheckOrgResult => ({
					orgId,
					outcome: "deferred",
					scored: 0,
					failed: 0,
					skipped: 0,
					capped: 0,
				})
				// One org's failure must not stop the rest; its cursor stays and the next tick retries.
				const results = yield* Effect.forEach(
					due,
					(row) =>
						Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
							nowMs - startedMs > TICK_BUDGET_MS
								? Effect.succeed(deferred(row.orgId))
								: scoreOrg(row.orgId, row.cursorAt),
						).pipe(
							Effect.catch((error) =>
								Effect.logWarning("Session check scoring failed for an org").pipe(
									Effect.annotateLogs({ orgId: row.orgId, error: error.message }),
									Effect.as<SessionCheckOrgResult>({
										orgId: row.orgId,
										outcome: "failed",
										scored: 0,
										failed: 0,
										skipped: 0,
										capped: 0,
									}),
								),
							),
						),
					{ concurrency: ORG_CONCURRENCY },
				)
				return {
					orgs: results.length,
					sessionsScored: Arr.reduce(results, 0, (sum, result) => sum + result.scored),
					orgsFailed: Arr.filter(results, (result) => result.outcome === "failed").length,
					orgsDeferred: Arr.filter(results, (result) => result.outcome === "deferred").length,
				}
			})

			return { enroll, runTick, scoreOrg }
		}),
	},
) {
	/** Needs `Database`, `Env` and `OrganizationFeatureFlagsService` from the app root. */
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(AiSessionReadService.layer),
		Layer.provide(OrgIngestKeysService.layer),
		Layer.provide(FetchHttpClient.layer),
	)
}
