import {
	CodeReviewTeam,
	CodeReviewTeamActivity,
	CodeReviewTeamMember,
	type CodeReviewTeamQuery,
	CodeReviewTeamTotals,
	PrReviewPersistenceError,
	type VcsRepositoryId,
	type WarehouseReadError,
} from "@maple/domain/http"
import type { OrgId } from "@maple/domain/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { PrReviewFindings, PrReviews, VcsRepositories } from "@maple/db/tables"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import { Context, Effect, Layer } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { ciWindow } from "./CiAnalyticsService"

type TeamError = PrReviewPersistenceError | WarehouseReadError

export interface CodeReviewTeamServiceApi {
	readonly team: (
		tenant: TenantContext,
		query: CodeReviewTeamQuery,
	) => Effect.Effect<CodeReviewTeam, TeamError>
}

/** Pull requests read per window: past this the oldest are left out, which a span annotation shows. */
const MAX_PULL_REQUESTS = 20_000
/** The activity calendar's reach, whatever the window: a year, as GitHub draws it. */
export const ACTIVITY_SPAN_MS = 365 * 86_400_000
/** How far back a pull request's earlier reviews are looked for, to tell a first review from a re-review. */
const FIRST_REVIEW_LOOKBACK_MS = 180 * 86_400_000

/** GitHub Apps act as `<name>[bot]`; a team page is about people. */
export const isBotLogin = (login: string) => login.endsWith("[bot]")

export const median = (values: ReadonlyArray<number>): number | null => {
	if (values.length === 0) return null
	const sorted = values.toSorted((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** One pull request's reviews, folded. */
export interface TeamPullRequest {
	readonly repositoryId: string
	readonly number: number
	readonly author: string | null
	readonly mergeSeconds: number | null
	readonly firstReviewSeconds: number | null
	readonly shippedClean: boolean
	readonly shippedRegressed: boolean
}

/** One pull request's tracked findings, by status. */
export interface TeamFindingCounts {
	readonly repositoryId: string
	readonly number: number
	readonly findings: number
	readonly critical: number
	readonly resolved: number
	readonly open: number
}

export interface TeamCiActor {
	readonly actor: string
	readonly runs: number
	readonly firstTryRuns: number
	readonly firstTryGreen: number
	readonly reruns: number
	readonly cancelledRuns: number
	readonly runnerMs: number
	readonly defaultBranchRuns: number
	readonly defaultBranchFailed: number
}

type MemberCounts = {
	-readonly [K in keyof CodeReviewTeamMember]: CodeReviewTeamMember[K]
}

const emptyMember = (login: string): MemberCounts => ({
	login,
	pullRequests: 0,
	mergedPullRequests: 0,
	medianMergeSeconds: null,
	findings: 0,
	criticalFindings: 0,
	resolvedFindings: 0,
	openAtMergeFindings: 0,
	shippedClean: 0,
	shippedRegressed: 0,
	ciRuns: 0,
	firstTryRuns: 0,
	firstTryGreen: 0,
	reruns: 0,
	cancelledRuns: 0,
	runnerMs: 0,
})

/** One pull request's first review and merge, for the activity calendar. */
export interface ActivityPullRequest {
	readonly repositoryId: string
	readonly author: string | null
	/** Epoch ms. */
	readonly firstCreatedAt: number | null
	readonly mergedAt: number | null
}

/** `YYYY-MM-DD` of an epoch ms in a zone. */
const dayFormatter = (timeZone: string) => {
	const format = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	})
	return (ms: number) => format.format(ms)
}

/** Each pull request's first review and merge in the window, folded by day, person and repository. */
export const buildActivity = (input: {
	readonly startTime: number
	readonly endTime: number
	readonly timeZone: string
	readonly pullRequests: ReadonlyArray<ActivityPullRequest>
	/** `owner/name` by repository id. */
	readonly repositories: ReadonlyMap<string, string>
}): ReadonlyArray<CodeReviewTeamActivity> => {
	const dayOf = dayFormatter(input.timeZone)
	const cells = new Map<
		string,
		{ day: string; login: string; repository: string; opened: number; merged: number }
	>()
	const cellOf = (at: number, login: string, repository: string) => {
		const day = dayOf(at)
		const key = `${day}\u0000${login}\u0000${repository}`
		const found = cells.get(key)
		if (found !== undefined) return found
		const created = { day, login, repository, opened: 0, merged: 0 }
		cells.set(key, created)
		return created
	}
	const inWindow = (at: number) => at >= input.startTime && at < input.endTime
	for (const pr of input.pullRequests) {
		if (pr.author === null || isBotLogin(pr.author)) continue
		const repository = input.repositories.get(pr.repositoryId) ?? pr.repositoryId
		if (pr.firstCreatedAt !== null && inWindow(pr.firstCreatedAt))
			cellOf(pr.firstCreatedAt, pr.author, repository).opened += 1
		if (pr.mergedAt !== null && inWindow(pr.mergedAt))
			cellOf(pr.mergedAt, pr.author, repository).merged += 1
	}
	return [...cells.values()]
		.toSorted((a, b) =>
			a.day === b.day
				? a.login === b.login
					? a.repository.localeCompare(b.repository)
					: a.login.localeCompare(b.login)
				: a.day.localeCompare(b.day),
		)
		.map((cell) => new CodeReviewTeamActivity(cell))
}

/** The pull request authors and CI actors as one row per login, bots left out. */
export const buildTeam = (input: {
	readonly startTime: number
	readonly endTime: number
	readonly activityStartTime: number
	readonly activity: ReadonlyArray<CodeReviewTeamActivity>
	readonly pullRequests: ReadonlyArray<TeamPullRequest>
	readonly findings: ReadonlyArray<TeamFindingCounts>
	readonly ci: ReadonlyArray<TeamCiActor>
	readonly p95QueueMs: number | null
}): CodeReviewTeam => {
	const members = new Map<string, MemberCounts>()
	const mergeSeconds = new Map<string, Array<number>>()
	const memberOf = (login: string) => {
		const found = members.get(login)
		if (found !== undefined) return found
		const created = emptyMember(login)
		members.set(login, created)
		return created
	}
	const findingsOf = new Map(input.findings.map((row) => [`${row.repositoryId}:${row.number}`, row]))
	const people = input.pullRequests.filter((pr) => pr.author !== null && !isBotLogin(pr.author))

	for (const pr of people) {
		if (pr.author === null) continue
		const member = memberOf(pr.author)
		const merged = pr.mergeSeconds !== null
		member.pullRequests += 1
		if (merged) {
			member.mergedPullRequests += 1
			mergeSeconds.set(pr.author, [...(mergeSeconds.get(pr.author) ?? []), pr.mergeSeconds])
		}
		if (pr.shippedRegressed) member.shippedRegressed += 1
		else if (pr.shippedClean) member.shippedClean += 1
		const found = findingsOf.get(`${pr.repositoryId}:${pr.number}`)
		if (found === undefined) continue
		member.findings += found.findings
		member.criticalFindings += found.critical
		// Fix rate is judged at the merge: an open pull request has not shipped its findings yet.
		if (!merged) continue
		member.resolvedFindings += found.resolved
		member.openAtMergeFindings += found.open
	}
	for (const row of input.ci) {
		if (row.actor === "" || isBotLogin(row.actor)) continue
		const member = memberOf(row.actor)
		member.ciRuns += row.runs
		member.firstTryRuns += row.firstTryRuns
		member.firstTryGreen += row.firstTryGreen
		member.reruns += row.reruns
		member.cancelledRuns += row.cancelledRuns
		member.runnerMs += row.runnerMs
	}

	const merged = people.flatMap((pr) => (pr.mergeSeconds === null ? [] : [pr.mergeSeconds]))
	return new CodeReviewTeam({
		startTime: input.startTime,
		endTime: input.endTime,
		totals: new CodeReviewTeamTotals({
			pullRequests: people.length,
			mergedPullRequests: merged.length,
			medianMergeSeconds: median(merged),
			medianFirstReviewSeconds: median(
				people.flatMap((pr) => (pr.firstReviewSeconds === null ? [] : [pr.firstReviewSeconds])),
			),
			defaultBranchRuns: input.ci.reduce((sum, row) => sum + row.defaultBranchRuns, 0),
			defaultBranchFailed: input.ci.reduce((sum, row) => sum + row.defaultBranchFailed, 0),
			runnerMs: input.ci.reduce((sum, row) => sum + row.runnerMs, 0),
			p95QueueMs: input.p95QueueMs,
		}),
		members: [...members.values()]
			.map(
				(member) =>
					new CodeReviewTeamMember({
						...member,
						medianMergeSeconds: median(mergeSeconds.get(member.login) ?? []),
					}),
			)
			.toSorted((a, b) => a.login.localeCompare(b.login, "en", { sensitivity: "base" })),
		activityStartTime: input.activityStartTime,
		activity: input.activity,
	})
}

/** A quantile over no rows is NaN or null. */
const finiteOrNull = (value: number | null | undefined) =>
	value !== null && value !== undefined && Number.isFinite(value) ? value : null

export class CodeReviewTeamService extends Context.Service<CodeReviewTeamService, CodeReviewTeamServiceApi>()(
	"@maple/backend/services/pr-review/CodeReviewTeamService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const warehouse = yield* WarehouseQueryService
			const dbExecute = makeDbExecute(
				database,
				"CodeReviewTeamService",
				(error) => new PrReviewPersistenceError({ message: error.message }),
			)

			const readPullRequests = (
				orgId: OrgId,
				window: { readonly start: number; readonly end: number },
				repositoryId: VcsRepositoryId | undefined,
			) =>
				dbExecute((db) =>
					db.run(
						PG.from(PrReviews)
							.select(($) => {
								const completed = $.status.eq("completed")
								const reported = (verdict: string) =>
									PG.sql(
										PG.bool,
									)`coalesce(bool_or(${$.postMergeStatus} = 'reported' and ${$.postMergeJson}->>'verdict' = ${verdict}), false)`
								return {
									repositoryId: $.repositoryId,
									number: $.number,
									author: PG.sql(PG.nullable(PG.text))`max(${$.authorLogin})`,
									lastCreatedAt: PG.max($.createdAt),
									// First review to the merge.
									mergeSeconds: PG.sql(
										PG.nullable(PG.float8),
									)`extract(epoch from (max(${$.mergedAt}) - min(${$.createdAt})))::float8`,
									firstReviewSeconds: PG.sql(
										PG.nullable(PG.float8),
									)`extract(epoch from (min(${$.finishedAt}) filter (where ${completed}) - min(${$.createdAt})))::float8`,
									shippedClean: reported("clean"),
									shippedRegressed: reported("regressed"),
								}
							})
							.where(($) => [
								$.orgId.eq(orgId),
								$.createdAt.gte(window.start - FIRST_REVIEW_LOOKBACK_MS),
								$.createdAt.lt(window.end),
								repositoryId === undefined ? undefined : $.repositoryId.eq(repositoryId),
							])
							.groupBy("repositoryId", "number")
							// First reviewed in the window: a re-review of an older pull request is not one.
							// In epoch ms: an aggregate loses the column's timestamp codec.
							.having(($) => [
								PG.sql(PG.float8)`extract(epoch from min(${$.createdAt})) * 1000`.gte(
									window.start,
								),
							])
							.orderBy(["lastCreatedAt", "desc"])
							.limit(MAX_PULL_REQUESTS),
					),
				)

			/** A year of pull requests, first review and merge alone: the calendar's reach, not the window's. */
			const readActivity = (
				orgId: OrgId,
				window: { readonly start: number; readonly end: number },
				repositoryId: VcsRepositoryId | undefined,
			) =>
				dbExecute((db) =>
					db.run(
						PG.from(PrReviews)
							.select(($) => ({
								repositoryId: $.repositoryId,
								number: $.number,
								author: PG.sql(PG.nullable(PG.text))`max(${$.authorLogin})`,
								lastCreatedAt: PG.max($.createdAt),
								firstCreatedAt: PG.min($.createdAt),
								mergedAt: PG.max($.mergedAt),
							}))
							.where(($) => [
								$.orgId.eq(orgId),
								// Earlier reviews too, so a re-review is not read as the pull request opening.
								$.createdAt.gte(window.start - FIRST_REVIEW_LOOKBACK_MS),
								$.createdAt.lt(window.end),
								repositoryId === undefined ? undefined : $.repositoryId.eq(repositoryId),
							])
							.groupBy("repositoryId", "number")
							.orderBy(["lastCreatedAt", "desc"])
							.limit(MAX_PULL_REQUESTS),
					),
				)

			const readFindings = (
				orgId: OrgId,
				window: { readonly start: number; readonly end: number },
				repositoryId: VcsRepositoryId | undefined,
			) =>
				dbExecute((db) =>
					db.run(
						PG.from(PrReviewFindings)
							.select(($) => ({
								repositoryId: $.repositoryId,
								number: $.number,
								findings: PG.count(),
								critical: PG.countIf($.severity.eq("critical")),
								resolved: PG.countIf($.status.eq("resolved")),
								open: PG.countIf($.status.eq("open")),
							}))
							.where(($) => [
								$.orgId.eq(orgId),
								// The same reach as the pull requests; findings of ones not read are dropped.
								$.createdAt.gte(window.start - FIRST_REVIEW_LOOKBACK_MS),
								$.createdAt.lt(window.end),
								repositoryId === undefined ? undefined : $.repositoryId.eq(repositoryId),
							])
							.groupBy("repositoryId", "number"),
					),
				)

			const team = Effect.fn("CodeReviewTeamService.team")(function* (
				tenant: TenantContext,
				query: CodeReviewTeamQuery,
			) {
				const orgId = tenant.orgId
				const { startTime, endTime } = ciWindow(query)
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.code_review.span_ms": endTime - startTime,
					"maple.code_review.filtered": query.repositoryId !== undefined,
				})
				const repositories = yield* dbExecute((db) =>
					db.run(
						PG.from(VcsRepositories)
							.select(($) => ({
								id: $.id,
								owner: $.owner,
								name: $.name,
								defaultBranch: $.defaultBranch,
							}))
							.where(($) => [$.orgId.eq(orgId)]),
					),
				)
				const scoped =
					query.repositoryId === undefined
						? repositories
						: repositories.filter((repo) => repo.id === query.repositoryId)
				const repository = query.repositoryId === undefined ? undefined : scoped[0]
				const timeZone = query.timeZone ?? "UTC"
				const repositoryNames = new Map(scoped.map((repo) => [repo.id, `${repo.owner}/${repo.name}`]))
				const activityStartTime = endTime - ACTIVITY_SPAN_MS
				// An id that is not the org's reads as an empty team, never another org's runs.
				if (query.repositoryId !== undefined && repository === undefined)
					return buildTeam({
						startTime,
						endTime,
						activityStartTime,
						activity: [],
						pullRequests: [],
						findings: [],
						ci: [],
						p95QueueMs: null,
					})

				const scope: CH.CiScopeOpts =
					repository === undefined ? {} : { owner: repository.owner, repository: repository.name }
				const defaultBranches = scoped.map((repo) => ({
					owner: repo.owner,
					repository: repo.name,
					branch: repo.defaultBranch,
				}))
				const chWindow = {
					orgId,
					startTime: formatWarehouseDateTime(startTime),
					endTime: formatWarehouseDateTime(endTime),
				}
				const window = { start: startTime, end: endTime }
				const [pullRequests, activityPullRequests, findings, ci, queue] = yield* Effect.all(
					[
						readPullRequests(orgId, window, query.repositoryId),
						readActivity(orgId, { start: activityStartTime, end: endTime }, query.repositoryId),
						readFindings(orgId, window, query.repositoryId),
						warehouse.compiledQuery(
							tenant,
							CH.compile(CH.ciActorStatsQuery({ ...scope, defaultBranches }), chWindow),
							{ profile: "aggregation", context: "ciActorStats" },
						),
						warehouse.compiledQuery(tenant, CH.compile(CH.ciQueueTotalsQuery(scope), chWindow), {
							profile: "aggregation",
							context: "ciQueueTotals",
						}),
					],
					{ concurrency: "unbounded" },
				)
				yield* Effect.annotateCurrentSpan({
					"maple.code_review.pull_requests": pullRequests.length,
					"maple.code_review.activity_pull_requests": activityPullRequests.length,
					"maple.code_review.pull_requests_capped": pullRequests.length >= MAX_PULL_REQUESTS,
					"maple.code_review.ci_actors": ci.length,
				})
				const jobs = queue[0]
				return buildTeam({
					startTime,
					endTime,
					activityStartTime,
					activity: buildActivity({
						startTime: activityStartTime,
						endTime,
						timeZone,
						pullRequests: activityPullRequests,
						repositories: repositoryNames,
					}),
					pullRequests,
					findings,
					ci,
					p95QueueMs: jobs === undefined || jobs.jobs === 0 ? null : finiteOrNull(jobs.p95QueueMs),
				})
			})

			return { team } satisfies CodeReviewTeamServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
