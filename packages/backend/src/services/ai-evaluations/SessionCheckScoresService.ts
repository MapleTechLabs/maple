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
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { systemTenant } from "@maple/backend/services/auth/system-tenant"
import { AiSessionReadService } from "@maple/backend/services/ai-sessions/AiSessionReadService"
import { loadAiSessionSpans } from "@maple/backend/services/ai-sessions/load-session-spans"
import { makeIngestSender } from "@maple/backend/services/ingest/ingest-sender"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { sessionCheckScoresToOtlp } from "./session-check-scores"

/** A session idle this long is finished; one that resumes later is scored again, replacing it. */
export const SESSION_IDLE_MS = 15 * 60_000
/** How far back a newly enrolled org's first tick scores. */
export const ENROLL_LOOKBACK_MS = 3_600_000
/** Sessions one org scores per tick; past it the rest of the window is skipped and counted. */
export const SESSIONS_PER_TICK = 300
const LIST_PAGE = 100
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
	readonly outcome: "scored" | "flag_off" | "not_due" | "failed"
	readonly scored: number
	readonly failed: number
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
 * first reads its evaluators. The cursor only moves once every session of the window was scored,
 * so a failed session is retried next tick; re-scores replace the earlier ones on read.
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

			const enroll = Effect.fn("SessionCheckScores.enroll")(function* (orgId: OrgId) {
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
							startTime: formatWarehouseDateTime(cursorMs),
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
				): Effect.Effect<ReadonlyArray<AiSessionListItem>, Effect.Error<ReturnType<typeof page>>> =>
					page(offset).pipe(
						Effect.flatMap((response) => {
							const rows = [...acc, ...response.data]
							return response.data.length < LIST_PAGE || rows.length >= SESSIONS_PER_TICK * 2
								? Effect.succeed(rows)
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
				}).pipe(Effect.provideService(AiSessionReadService, reads))
				if (loaded.spans.length === 0) return false
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
				cursorMs: number,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const empty = { orgId, scored: 0, failed: 0, capped: 0 }
				const flags = yield* featureFlags.flags(orgId)
				if (!flags.llmEvals) return { ...empty, outcome: "flag_off" } satisfies SessionCheckOrgResult
				const nowMs = yield* Clock.currentTimeMillis
				const upperMs = nowMs - SESSION_IDLE_MS
				if (upperMs <= cursorMs)
					return { ...empty, outcome: "not_due" } satisfies SessionCheckOrgResult

				const listed = yield* listWindow(orgId, cursorMs, nowMs)
				const finished = finishedSessions(listed, cursorMs, upperMs)
				const batch = Arr.take(finished, SESSIONS_PER_TICK)
				const ingestKey = (yield* ingestKeys.getOrCreate(orgId, SYSTEM_USER_ID)).publicKey
				const outcomes = yield* Effect.forEach(
					batch,
					(session) => Effect.result(scoreSession(orgId, ingestKey, session)),
					{ concurrency: SESSION_CONCURRENCY },
				)
				const failed = Arr.filter(outcomes, (outcome) => outcome._tag === "Failure")
				const scored = Arr.filter(
					outcomes,
					(outcome) => outcome._tag === "Success" && outcome.success,
				)
				const capped = finished.length - batch.length
				yield* Effect.annotateCurrentSpan({
					"maple.evals.sessions_finished": finished.length,
					"maple.evals.sessions_scored": scored.length,
					"maple.evals.sessions_failed": failed.length,
					"maple.evals.sessions_capped": capped,
				})
				const firstFailure = Option.flatMap(Arr.head(failed), (outcome) =>
					outcome._tag === "Failure" ? Option.some(outcome.failure) : Option.none(),
				)
				// A failed session keeps the cursor, so the next tick tries the window again.
				yield* dbExecute((db) =>
					db.run(
						PG.update(AiEvaluationRuns)
							.set({
								...(failed.length === 0 ? { cursorAt: upperMs } : undefined),
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
					capped,
				} satisfies SessionCheckOrgResult
			})

			const runTick = Effect.fn("SessionCheckScores.runTick")(function* () {
				const enrolled = yield* dbExecute((db) =>
					db.run(
						PG.from(AiEvaluationRuns)
							.select(($) => ({ orgId: $.orgId, cursorAt: $.cursorAt }))
							.where(($) => [$.scorer.eq(SCORER)]),
					),
				)
				// One org's failure must not stop the rest; its cursor stays and the next tick retries.
				const results = yield* Effect.forEach(
					enrolled,
					(row) =>
						scoreOrg(row.orgId, row.cursorAt).pipe(
							Effect.catch((error) =>
								Effect.logWarning("Session check scoring failed for an org").pipe(
									Effect.annotateLogs({ orgId: row.orgId, error: error.message }),
									Effect.as<SessionCheckOrgResult>({
										orgId: row.orgId,
										outcome: "failed",
										scored: 0,
										failed: 0,
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
