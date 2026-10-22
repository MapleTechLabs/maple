/**
 * Supabase insights: the alerting cron reads each running project's performance and security
 * advisors (hourly) and its slowest statements from `pg_stat_statements` (every 15 minutes) over
 * the Management API, and keeps the latest of each in `supabase_project_insights`.
 *
 * A project costs at most three Management API calls a tick, far under Supabase's per-project
 * limit. The lease is per project; a failed read records its error and keeps the previous result.
 */
import {
	IntegrationsNotFoundError,
	IntegrationsPersistenceError,
	OrgId,
	SupabaseAdvisorsByLevel,
	type SupabaseAdvisorLint,
	SupabaseProjectInsights,
} from "@maple/domain/http"
import type { SupabaseProjectRef } from "@maple/domain/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	SupabaseConnections,
	SupabaseProjectInsights as SupabaseProjectInsightsTable,
	SupabaseProjects,
	type SupabaseConnectionRow,
	type SupabaseProjectInsightsRow,
	type SupabaseProjectRow,
} from "@maple/db/tables"
import { Cause, Clock, Context, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { SupabaseOAuthService } from "@maple/backend/services/auth/SupabaseOAuthService"
import { isSourcePaused } from "@maple/backend/services/org/integration-sources"
import type { SupabaseApiError } from "./supabase/api"
import { getAdvisors, getTopQueries } from "./supabase/insights"
import { shouldScrape } from "./supabase/scrape-targets"

export const ADVISORS_INTERVAL_MS = 60 * 60_000
export const QUERIES_INTERVAL_MS = 15 * 60_000
/** Cron fires drift by seconds; a check this close to its interval is due. */
const DUE_SLACK_MS = 60_000
/** Outlives the lane's 10-minute deadline, so an interrupted tick frees its projects on its own. */
const LEASE_MS = 12 * 60_000
/** No project starts after this. */
const TICK_BUDGET_MS = 5 * 60_000
const RATE_LIMIT_HOLD_MS = 5 * 60_000
const ORG_CONCURRENCY = 3
const PROJECT_CONCURRENCY = 4
const ERROR_CHARS = 500

const decodeOrgId = Schema.decodeUnknownSync(OrgId)
const toPersistenceError = makePersistenceErrorMapper(IntegrationsPersistenceError, "Supabase database error")

const isRunning = (project: SupabaseProjectRow) =>
	shouldScrape({ metricsEnabled: true, status: project.status, removedAt: project.removedAt })

const isDue = (checkedAt: number | null, intervalMs: number, now: number) =>
	checkedAt === null || now - checkedAt >= intervalMs - DUE_SLACK_MS

const LEVEL_ORDER = { ERROR: 0, WARN: 1, INFO: 2 } as const

/** Advisors grouped by level, each group ordered by title then object. */
export const groupAdvisors = (lints: ReadonlyArray<SupabaseAdvisorLint>) => {
	const sorted = lints.toSorted(
		(a, b) =>
			LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
			a.title.localeCompare(b.title) ||
			(a.object ?? "").localeCompare(b.object ?? ""),
	)
	return new SupabaseAdvisorsByLevel({
		error: sorted.filter((lint) => lint.level === "ERROR"),
		warn: sorted.filter((lint) => lint.level === "WARN"),
		info: sorted.filter((lint) => lint.level === "INFO"),
	})
}

type ReadOutcome = "ok" | "failed" | "rate_limited" | "revoked" | "skipped"

interface ProjectPollResult {
	readonly advisors: ReadOutcome
	readonly queries: ReadOutcome
}

const SKIPPED: ProjectPollResult = { advisors: "skipped", queries: "skipped" }

export interface SupabaseInsightsPollOrgSummary {
	readonly orgId: OrgId
	readonly skipped: string | null
	readonly projects: number
	readonly advisorsRead: number
	readonly queriesRead: number
	readonly failures: number
}

export interface SupabaseInsightsPollAllSummary {
	readonly orgs: number
	readonly advisorsRead: number
	readonly queriesRead: number
	readonly failures: number
	readonly skipped: number
}

export interface SupabaseInsightsServiceApi {
	/** The project's last polled insights; empty until the first poll. */
	readonly getInsights: (
		orgId: OrgId,
		ref: SupabaseProjectRef,
	) => Effect.Effect<SupabaseProjectInsights, IntegrationsNotFoundError | IntegrationsPersistenceError>
	readonly pollOrg: (
		orgId: OrgId,
	) => Effect.Effect<SupabaseInsightsPollOrgSummary, IntegrationsPersistenceError>
	readonly pollAllOrgs: () => Effect.Effect<SupabaseInsightsPollAllSummary, IntegrationsPersistenceError>
}

export class SupabaseInsightsService extends Context.Service<
	SupabaseInsightsService,
	SupabaseInsightsServiceApi
>()("@maple/api/services/SupabaseInsightsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const oauth = yield* SupabaseOAuthService
		const httpClient = yield* HttpClient.HttpClient
		const dbExecute = makeDbExecute(database, "SupabaseInsightsService", toPersistenceError)

		const getInsights = Effect.fn("SupabaseInsightsService.getInsights")(function* (
			orgId: OrgId,
			ref: SupabaseProjectRef,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.supabase.project_ref": ref })
			const projects = yield* dbExecute((db) =>
				db.run(
					PG.from(SupabaseProjects)
						.select("id")
						.where(($) => [$.orgId.eq(orgId), $.projectRef.eq(ref), $.removedAt.isNull()])
						.limit(1),
				),
			)
			const project = projects[0]
			if (project === undefined) {
				return yield* new IntegrationsNotFoundError({
					message: `No Supabase project ${ref} is connected to this organization`,
				})
			}
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(SupabaseProjectInsightsTable)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.projectId.eq(project.id)])
						.limit(1),
				),
			)
			const row = rows[0]
			return new SupabaseProjectInsights({
				projectRef: ref,
				advisors: groupAdvisors(row?.advisorsJson ?? []),
				advisorsCheckedAt: row?.advisorsCheckedAt ?? null,
				advisorsError: row?.advisorsError ?? null,
				topQueries: row?.topQueriesJson ?? [],
				queriesCheckedAt: row?.queriesCheckedAt ?? null,
				queriesError: row?.queriesError ?? null,
			})
		})

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

		/** Rows for every running project, so a claim has something to lease. */
		const ensureRows = (projects: ReadonlyArray<SupabaseProjectRow>, now: number) =>
			dbExecute((db) =>
				db.run(
					PG.insertInto(SupabaseProjectInsightsTable)
						.values(
							projects.map((project) => ({
								projectId: project.id,
								orgId: project.orgId,
								createdAt: now,
								updatedAt: now,
							})),
						)
						.onConflictDoNothing(),
				),
			)

		const claimLease = (project: SupabaseProjectRow, now: number) =>
			dbExecute((db) =>
				db.run(
					PG.update(SupabaseProjectInsightsTable)
						.set({ leaseUntil: now + LEASE_MS })
						.where(($) => [
							$.projectId.eq(project.id),
							PG.or(
								$.leaseUntil.isNull(),
								$.leaseUntil.lt(now),
								// A bogus far-future lease (clock jump, crashed writer) must not wedge the project.
								$.leaseUntil.gt(now + 2 * LEASE_MS),
							),
						])
						.returning(),
				),
			).pipe(Effect.map((rows) => rows[0] ?? null))

		/** Writes only while this tick still holds the lease: a late tick never touches a successor. */
		const updateClaimed = (
			claimed: SupabaseProjectInsightsRow,
			set: PG.UpdateSetOf<typeof SupabaseProjectInsightsTable>,
		) =>
			dbExecute((db) =>
				db.run(
					PG.update(SupabaseProjectInsightsTable)
						.set(set)
						.where(($) => [
							$.projectId.eq(claimed.projectId),
							claimed.leaseUntil === null
								? $.leaseUntil.isNull()
								: $.leaseUntil.eq(claimed.leaseUntil),
						]),
				),
			)

		const releaseLease = (claimed: SupabaseProjectInsightsRow, holdUntil: number | null) =>
			updateClaimed(claimed, { leaseUntil: holdUntil })

		/** Runs one read with the org's token; classifies the failure instead of failing the poll. */
		const read = <A>(
			orgId: OrgId,
			project: SupabaseProjectRow,
			label: string,
			run: (accessToken: string) => Effect.Effect<A, SupabaseApiError>,
			onSuccess: (value: A) => PG.UpdateSetOf<typeof SupabaseProjectInsightsTable>,
			onError: (message: string) => PG.UpdateSetOf<typeof SupabaseProjectInsightsTable>,
			claimed: SupabaseProjectInsightsRow,
		) =>
			Effect.gen(function* () {
				const result = yield* Effect.result(oauth.withAccessToken(orgId, run))
				if (result._tag === "Success") {
					yield* updateClaimed(claimed, onSuccess(result.success))
					return "ok" as const
				}
				const failure = result.failure
				if (failure._tag === "@maple/supabase/SupabaseApiError" && failure.kind === "rate_limited") {
					return "rate_limited" as const
				}
				if (failure._tag === "@maple/http/errors/IntegrationsRevokedError") return "revoked" as const
				yield* Effect.logWarning(`supabase ${label} read failed`, {
					orgId,
					projectRef: project.projectRef,
					tag: failure._tag,
					error: failure.message,
				})
				yield* updateClaimed(claimed, onError(failure.message.slice(0, ERROR_CHARS)))
				return "failed" as const
			})

		const pollProject = Effect.fn("SupabaseInsightsService.pollProject")(function* (
			project: SupabaseProjectRow,
			tickStartedAt: number,
		) {
			const orgId = project.orgId
			yield* Effect.annotateCurrentSpan({ orgId, "maple.supabase.project_ref": project.projectRef })
			const now = yield* Clock.currentTimeMillis
			if (now - tickStartedAt >= TICK_BUDGET_MS) return SKIPPED
			const claimed = yield* claimLease(project, now)
			if (claimed === null) return SKIPPED
			const advisorsDue = isDue(claimed.advisorsCheckedAt, ADVISORS_INTERVAL_MS, now)
			const queriesDue = isDue(claimed.queriesCheckedAt, QUERIES_INTERVAL_MS, now)

			const run = Effect.gen(function* () {
				const advisors: ReadOutcome = advisorsDue
					? yield* read(
							orgId,
							project,
							"advisors",
							(token) =>
								Effect.all([
									getAdvisors(
										httpClient,
										oauth.apiBaseUrl,
										token,
										project.projectRef,
										"performance",
									),
									getAdvisors(
										httpClient,
										oauth.apiBaseUrl,
										token,
										project.projectRef,
										"security",
									),
								]).pipe(
									Effect.map(([performance, security]) => [...performance, ...security]),
								),
							(lints) => ({
								advisorsJson: lints,
								advisorsCheckedAt: now,
								advisorsError: null,
								updatedAt: now,
							}),
							(message) => ({ advisorsError: message, updatedAt: now }),
							claimed,
						)
					: "skipped"
				if (advisors === "revoked" || advisors === "rate_limited") {
					return { advisors, queries: "skipped" } satisfies ProjectPollResult
				}
				const queries: ReadOutcome = queriesDue
					? yield* read(
							orgId,
							project,
							"top queries",
							(token) => getTopQueries(httpClient, oauth.apiBaseUrl, token, project.projectRef),
							(statements) => ({
								topQueriesJson: statements,
								queriesCheckedAt: now,
								queriesError: null,
								updatedAt: now,
							}),
							(message) => ({ queriesError: message, updatedAt: now }),
							claimed,
						)
					: "skipped"
				return { advisors, queries } satisfies ProjectPollResult
			})

			return yield* run.pipe(
				Effect.tap((result) =>
					Effect.annotateCurrentSpan({
						"maple.supabase.insights.advisors": result.advisors,
						"maple.supabase.insights.queries": result.queries,
					}),
				),
				Effect.onExit((exit) =>
					releaseLease(
						claimed,
						exit._tag === "Success" &&
							(exit.value.advisors === "rate_limited" || exit.value.queries === "rate_limited")
							? now + RATE_LIMIT_HOLD_MS
							: null,
					).pipe(Effect.ignore),
				),
			)
		})

		const pollOrgAt = Effect.fn("SupabaseInsightsService.pollOrg")(function* (
			orgId: OrgId,
			tickStartedAt: number,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const skip = (reason: string): SupabaseInsightsPollOrgSummary => ({
				orgId,
				skipped: reason,
				projects: 0,
				advisorsRead: 0,
				queriesRead: 0,
				failures: 0,
			})
			const connection = yield* loadConnection(orgId)
			if (connection === null) return skip("not connected")
			if (!(yield* oauth.isGrantUsable(orgId))) return skip("grant revoked")
			const now = yield* Clock.currentTimeMillis
			// A paused source makes no upstream calls.
			if (yield* dbExecute((db) => isSourcePaused(db, connection.sourceId, now))) {
				return skip("source paused")
			}
			const running = (yield* loadProjects(connection)).filter(isRunning)
			if (running.length === 0) return skip("no projects")
			yield* ensureRows(running, now)

			const results = yield* Effect.forEach(running, (project) => pollProject(project, tickStartedAt), {
				concurrency: PROJECT_CONCURRENCY,
			})
			const count = (pick: (result: ProjectPollResult) => boolean) => results.filter(pick).length
			const summary = {
				orgId,
				skipped: null,
				projects: running.length,
				advisorsRead: count((result) => result.advisors === "ok"),
				queriesRead: count((result) => result.queries === "ok"),
				failures: count((result) => result.advisors === "failed" || result.queries === "failed"),
			} satisfies SupabaseInsightsPollOrgSummary
			yield* Effect.annotateCurrentSpan({
				"maple.supabase.insights.advisors_read": summary.advisorsRead,
				"maple.supabase.insights.queries_read": summary.queriesRead,
				"maple.supabase.insights.failures": summary.failures,
			})
			return summary
		})

		const pollOrg = (orgId: OrgId) =>
			Clock.currentTimeMillis.pipe(Effect.flatMap((started) => pollOrgAt(orgId, started)))

		const pollAllOrgs = Effect.fn("SupabaseInsightsService.pollAllOrgs")(function* () {
			const started = yield* Clock.currentTimeMillis
			const orgs = yield* dbExecute((db) => db.run(PG.from(SupabaseConnections).select("orgId")))
			const summaries = yield* Effect.forEach(
				orgs,
				(row) =>
					pollOrgAt(decodeOrgId(row.orgId), started).pipe(
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.interrupt
								: Effect.logWarning("supabase insights org poll failed", {
										orgId: row.orgId,
										error: summarizeCause(cause),
									}).pipe(
										Effect.as<SupabaseInsightsPollOrgSummary>({
											orgId: decodeOrgId(row.orgId),
											skipped: "org poll failed",
											projects: 0,
											advisorsRead: 0,
											queriesRead: 0,
											failures: 1,
										}),
									),
						),
					),
				{ concurrency: ORG_CONCURRENCY },
			)
			const summary = {
				orgs: orgs.length,
				advisorsRead: summaries.reduce((sum, item) => sum + item.advisorsRead, 0),
				queriesRead: summaries.reduce((sum, item) => sum + item.queriesRead, 0),
				failures: summaries.reduce((sum, item) => sum + item.failures, 0),
				skipped: summaries.filter((item) => item.skipped !== null).length,
			} satisfies SupabaseInsightsPollAllSummary
			yield* Effect.annotateCurrentSpan({
				"maple.supabase.orgs": summary.orgs,
				"maple.supabase.insights.advisors_read": summary.advisorsRead,
				"maple.supabase.insights.queries_read": summary.queriesRead,
				"maple.supabase.insights.failures": summary.failures,
			})
			return summary
		})

		return { getInsights, pollOrg, pollAllOrgs } satisfies SupabaseInsightsServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(SupabaseOAuthService.layer),
	)
}
