import {
	CodeReviewAnalytics,
	type CodeReviewAnalyticsQuery,
	CodeReviewAuthorCount,
	CodeReviewBucket,
	CodeReviewCategoryCount,
	CodeReviewDetail,
	CodeReviewFinding,
	type CodeReviewFindingsQuery,
	CodeReviewFindingsResponse,
	CodeReviewListItem,
	type CodeReviewListQuery,
	CodeReviewListResponse,
	CodeReviewRepositoryCount,
	CodeReviewTotals,
	CodeReviewVerdicts,
	PrReviewNotFoundError,
	PrReviewPersistenceError,
	PrReviewReport,
	type PrReviewId,
	type VcsRepositoryId,
} from "@maple/domain/http"
import type { OrgId } from "@maple/domain/primitives"
import { prReviewFindings, prReviews, vcsRepositories } from "@maple/db"
import { and, type Column, desc, eq, gte, lt, or, sql } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { dateToMs, msToDate } from "@maple/backend/platform/time"

export interface PrReviewAnalyticsServiceApi {
	readonly analytics: (
		orgId: OrgId,
		query: CodeReviewAnalyticsQuery,
	) => Effect.Effect<CodeReviewAnalytics, PrReviewPersistenceError>
	readonly listReviews: (
		orgId: OrgId,
		query: CodeReviewListQuery,
	) => Effect.Effect<CodeReviewListResponse, PrReviewPersistenceError>
	readonly getReview: (
		orgId: OrgId,
		reviewId: PrReviewId,
	) => Effect.Effect<CodeReviewDetail, PrReviewPersistenceError | PrReviewNotFoundError>
	readonly listFindings: (
		orgId: OrgId,
		query: CodeReviewFindingsQuery,
	) => Effect.Effect<CodeReviewFindingsResponse, PrReviewPersistenceError>
}

const HOUR = 3_600
const DAY = 86_400
const DEFAULT_PAGE = 50
/** The repository and author lists are a leaderboard, not an index. */
const TOP = 8
/** The longest window analytics reads; an older start is moved up, which caps the bucket series. */
const MAX_SPAN_MS = 366 * DAY * 1000

/** Hourly up to two days, daily up to four months, weekly beyond. */
export const codeReviewBucketSeconds = (spanMs: number) =>
	spanMs <= 2 * DAY * 1000 ? HOUR : spanMs <= 120 * DAY * 1000 ? DAY : 7 * DAY

const toPersistence = (error: { readonly message: string }) =>
	new PrReviewPersistenceError({ message: error.message })

const decodeListItem = Schema.decodeUnknownEffect(CodeReviewListItem)
const decodeFinding = Schema.decodeUnknownEffect(CodeReviewFinding)
const decodeReport = Schema.decodeUnknownOption(PrReviewReport)
const decodeTotals = Schema.decodeUnknownEffect(CodeReviewTotals)

const MergeRow = Schema.Struct({ merged: Schema.Number, avg_seconds: Schema.NullOr(Schema.Number) })
const MergeResult = Schema.Union([Schema.Array(MergeRow), Schema.Struct({ rows: Schema.Array(MergeRow) })])
const decodeMergeResult = Schema.decodeUnknownOption(MergeResult)
/** `db.execute` returns the driver's `{ rows }` under the Effect drivers, whatever drizzle declares. */
const decodeMergeRows = (result: unknown) =>
	Option.match(decodeMergeResult(result), {
		onNone: () => [],
		onSome: (decoded) => ("rows" in decoded ? decoded.rows : decoded),
	})

const decodeRows = <I, A>(rows: ReadonlyArray<I>, decode: (row: I) => Effect.Effect<A, Schema.SchemaError>) =>
	Effect.forEach(rows, decode).pipe(
		Effect.mapError((error) => new PrReviewPersistenceError({ message: error.message })),
	)

const encodeCursor = (createdAtMs: number, id: string) => `${createdAtMs}_${id}`
const decodeCursor = (cursor: string) => {
	const at = cursor.indexOf("_")
	return { createdAt: msToDate(Number(cursor.slice(0, at))), id: cursor.slice(at + 1) }
}

const num = (value: unknown) => (typeof value === "number" ? value : Number(value ?? 0))
const numOrNull = (value: unknown) => (value === null || value === undefined ? null : Number(value))

// Read from the stored report in SQL so a list never loads the reports themselves.
const verdictSql = sql<string | null>`${prReviews.reportJson}->>'verdict'`
const confidenceSql = sql<number | null>`(${prReviews.reportJson}->>'confidence')::float8`
const findingsCountSql = sql<number>`coalesce(jsonb_array_length(${prReviews.reportJson}->'findings'), 0)::int`
const pullRequestCount = sql<number>`count(distinct ${prReviews.repositoryId} || ':' || ${prReviews.number})::int`
const criticalCountSql = sql<number>`coalesce((select count(*) from jsonb_array_elements(${prReviews.reportJson}->'findings') as f where f->>'severity' = 'critical'), 0)::int`

const listColumns = {
	id: prReviews.id,
	repositoryId: prReviews.repositoryId,
	repositoryFullName: vcsRepositories.fullName,
	number: prReviews.number,
	title: prReviews.title,
	url: prReviews.url,
	authorLogin: prReviews.authorLogin,
	headSha: prReviews.headSha,
	status: prReviews.status,
	skipReason: prReviews.skipReason,
	verdict: verdictSql,
	score: prReviews.score,
	confidence: confidenceSql,
	findings: findingsCountSql,
	criticalFindings: criticalCountSql,
	commentUrl: prReviews.commentUrl,
	publishError: prReviews.publishError,
	error: prReviews.error,
	model: prReviews.model,
	createdAt: prReviews.createdAt,
	finishedAt: prReviews.finishedAt,
	mergedAt: prReviews.mergedAt,
}

type ListRow = {
	readonly createdAt: Date
	readonly finishedAt: Date | null
	readonly mergedAt: Date | null
	readonly confidence: unknown
	readonly [key: string]: unknown
}

const listItemInput = (row: ListRow) => ({
	...row,
	confidence: numOrNull(row.confidence),
	createdAt: dateToMs(row.createdAt),
	finishedAt: row.finishedAt === null ? null : dateToMs(row.finishedAt),
	mergedAt: row.mergedAt === null ? null : dateToMs(row.mergedAt),
})

const findingColumns = {
	id: prReviewFindings.id,
	reviewId: prReviewFindings.reviewId,
	repositoryId: prReviewFindings.repositoryId,
	repositoryFullName: vcsRepositories.fullName,
	number: prReviewFindings.number,
	pullRequestTitle: prReviews.title,
	pullRequestUrl: prReviews.url,
	handle: prReviewFindings.handle,
	path: prReviewFindings.path,
	line: prReviewFindings.line,
	category: prReviewFindings.category,
	severity: prReviewFindings.severity,
	title: prReviewFindings.title,
	status: prReviewFindings.status,
	reactionsUp: prReviewFindings.reactionsUp,
	reactionsDown: prReviewFindings.reactionsDown,
	createdAt: prReviewFindings.createdAt,
}

const findingInput = (row: { readonly createdAt: Date; readonly [key: string]: unknown }) => ({
	...row,
	pullRequestTitle: row.pullRequestTitle ?? null,
	pullRequestUrl: row.pullRequestUrl ?? null,
	createdAt: dateToMs(row.createdAt),
})

interface Window {
	readonly start: Date
	readonly end: Date
}

export class PrReviewAnalyticsService extends Context.Service<
	PrReviewAnalyticsService,
	PrReviewAnalyticsServiceApi
>()("@maple/api/services/pr-review/PrReviewAnalyticsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const dbExecute = makeDbExecute(database, "PrReviewAnalyticsService", toPersistence)

		// The filters shared by every read; the author lives on the review, so findings join it.
		const reviewFilter = (
			orgId: OrgId,
			window: Window,
			query: {
				readonly repositoryId?: VcsRepositoryId | undefined
				readonly author?: string | undefined
			},
		) =>
			and(
				eq(prReviews.orgId, orgId),
				gte(prReviews.createdAt, window.start),
				lt(prReviews.createdAt, window.end),
				query.repositoryId === undefined ? undefined : eq(prReviews.repositoryId, query.repositoryId),
				query.author === undefined ? undefined : eq(prReviews.authorLogin, query.author),
			)
		const findingFilter = (
			orgId: OrgId,
			window: Window,
			query: {
				readonly repositoryId?: VcsRepositoryId | undefined
				readonly author?: string | undefined
			},
		) =>
			and(
				eq(prReviewFindings.orgId, orgId),
				gte(prReviewFindings.createdAt, window.start),
				lt(prReviewFindings.createdAt, window.end),
				query.repositoryId === undefined
					? undefined
					: eq(prReviewFindings.repositoryId, query.repositoryId),
				query.author === undefined ? undefined : eq(prReviews.authorLogin, query.author),
			)

		const totals = Effect.fn("PrReviewAnalyticsService.totals")(function* (
			orgId: OrgId,
			window: Window,
			query: CodeReviewAnalyticsQuery,
		) {
			const where = reviewFilter(orgId, window, query)
			const completed = sql`${prReviews.status} = 'completed'`
			const [reviewRows, findingRows, mergeRows] = yield* Effect.all(
				[
					dbExecute((db) =>
						db
							.select({
								reviews: sql<number>`count(*)::int`,
								pullRequests: pullRequestCount,
								completedReviews: sql<number>`(count(*) filter (where ${completed}))::int`,
								failedReviews: sql<number>`(count(*) filter (where ${prReviews.status} = 'failed'))::int`,
								skippedReviews: sql<number>`(count(*) filter (where ${prReviews.status} = 'skipped'))::int`,
								avgReviewSeconds: sql<
									number | null
								>`(avg(extract(epoch from (${prReviews.finishedAt} - ${prReviews.createdAt}))) filter (where ${completed} and ${prReviews.finishedAt} is not null))::float8`,
								avgConfidence: sql<
									number | null
								>`(avg(${confidenceSql}) filter (where ${completed}))::float8`,
								avgScore: sql<
									number | null
								>`(avg(${prReviews.score}) filter (where ${completed}))::float8`,
								inputTokens: sql<number>`coalesce(sum(${prReviews.inputTokens}), 0)::float8`,
								outputTokens: sql<number>`coalesce(sum(${prReviews.outputTokens}), 0)::float8`,
							})
							.from(prReviews)
							.where(where),
					),
					dbExecute((db) =>
						db
							.select({
								findings: sql<number>`count(*)::int`,
								criticalFindings: sql<number>`(count(*) filter (where ${prReviewFindings.severity} = 'critical'))::int`,
								resolvedFindings: sql<number>`(count(*) filter (where ${prReviewFindings.status} = 'resolved'))::int`,
								dismissedFindings: sql<number>`(count(*) filter (where ${prReviewFindings.status} = 'dismissed'))::int`,
								repositoriesWithFindings: sql<number>`count(distinct ${prReviewFindings.repositoryId})::int`,
							})
							.from(prReviewFindings)
							.leftJoin(prReviews, eq(prReviews.id, prReviewFindings.reviewId))
							.where(findingFilter(orgId, window, query)),
					),
					// Per pull request: its first review in the window to its merge.
					dbExecute((db) =>
						db
							.execute(
								sql`select count(*)::int as merged, avg(extract(epoch from (merged_at - first_at)))::float8 as avg_seconds
								from (
									select min(${prReviews.createdAt}) as first_at, max(${prReviews.mergedAt}) as merged_at
									from ${prReviews}
									where ${where ?? sql`true`}
									group by ${prReviews.repositoryId}, ${prReviews.number}
								) as pr
								where merged_at is not null`,
							)
							.pipe(Effect.map(decodeMergeRows)),
					),
				],
				{ concurrency: 3 },
			)
			const reviews = reviewRows[0]
			const findings = findingRows[0]
			const merge = mergeRows[0]
			return yield* decodeTotals({
				pullRequests: num(reviews?.pullRequests),
				reviews: num(reviews?.reviews),
				completedReviews: num(reviews?.completedReviews),
				failedReviews: num(reviews?.failedReviews),
				skippedReviews: num(reviews?.skippedReviews),
				findings: num(findings?.findings),
				criticalFindings: num(findings?.criticalFindings),
				resolvedFindings: num(findings?.resolvedFindings),
				dismissedFindings: num(findings?.dismissedFindings),
				repositoriesWithFindings: num(findings?.repositoriesWithFindings),
				mergedPullRequests: num(merge?.merged),
				avgReviewSeconds: numOrNull(reviews?.avgReviewSeconds),
				avgMergeSeconds: numOrNull(merge?.avg_seconds),
				avgConfidence: numOrNull(reviews?.avgConfidence),
				avgScore: numOrNull(reviews?.avgScore),
				inputTokens: num(reviews?.inputTokens),
				outputTokens: num(reviews?.outputTokens),
			}).pipe(Effect.mapError(toPersistence))
		})

		const analytics = Effect.fn("PrReviewAnalyticsService.analytics")(function* (
			orgId: OrgId,
			query: CodeReviewAnalyticsQuery,
		) {
			const startTime = Math.max(query.startTime, query.endTime - MAX_SPAN_MS)
			const spanMs = Math.max(query.endTime - startTime, 60_000)
			const bucketSeconds = codeReviewBucketSeconds(spanMs)
			const window: Window = { start: msToDate(startTime), end: msToDate(query.endTime) }
			const previous: Window = { start: msToDate(startTime - spanMs), end: window.start }
			yield* Effect.annotateCurrentSpan({
				orgId,
				"maple.code_review.span_ms": spanMs,
				"maple.code_review.bucket_seconds": bucketSeconds,
				"maple.code_review.filtered": query.repositoryId !== undefined || query.author !== undefined,
			})

			// Inlined, not bound: a GROUP BY over an expression with placeholders never matches the
			// SELECT's own placeholders. The value is computed here, never taken from the request.
			const width = sql.raw(String(bucketSeconds))
			const bucketOf = (column: Column) =>
				sql<number>`(floor(extract(epoch from ${column}) / ${width}) * ${width} * 1000)::float8`
			const reviewBucket = bucketOf(prReviews.createdAt)
			const findingBucket = bucketOf(prReviewFindings.createdAt)
			const reviewWhere = reviewFilter(orgId, window, query)
			const findingWhere = findingFilter(orgId, window, query)

			const [
				current,
				before,
				reviewSeries,
				findingSeries,
				categories,
				verdicts,
				repoReviews,
				repoFindings,
				authorReviews,
				authorFindings,
			] = yield* Effect.all(
				[
					totals(orgId, window, query),
					totals(orgId, previous, query),
					dbExecute((db) =>
						db
							.select({
								bucket: reviewBucket,
								reviews: sql<number>`count(*)::int`,
								pullRequests: pullRequestCount,
							})
							.from(prReviews)
							.where(reviewWhere)
							.groupBy(reviewBucket),
					),
					dbExecute((db) =>
						db
							.select({
								bucket: findingBucket,
								severity: prReviewFindings.severity,
								findings: sql<number>`count(*)::int`,
							})
							.from(prReviewFindings)
							.leftJoin(prReviews, eq(prReviews.id, prReviewFindings.reviewId))
							.where(findingWhere)
							.groupBy(findingBucket, prReviewFindings.severity),
					),
					dbExecute((db) =>
						db
							.select({
								category: prReviewFindings.category,
								findings: sql<number>`count(*)::int`,
							})
							.from(prReviewFindings)
							.leftJoin(prReviews, eq(prReviews.id, prReviewFindings.reviewId))
							.where(findingWhere)
							.groupBy(prReviewFindings.category)
							.orderBy(desc(sql`count(*)`)),
					),
					dbExecute((db) =>
						db
							.select({ verdict: verdictSql, reviews: sql<number>`count(*)::int` })
							.from(prReviews)
							.where(and(reviewWhere, eq(prReviews.status, "completed")))
							.groupBy(verdictSql),
					),
					dbExecute((db) =>
						db
							.select({
								repositoryId: prReviews.repositoryId,
								fullName: vcsRepositories.fullName,
								reviews: sql<number>`count(*)::int`,
							})
							.from(prReviews)
							.innerJoin(vcsRepositories, eq(vcsRepositories.id, prReviews.repositoryId))
							.where(reviewWhere)
							.groupBy(prReviews.repositoryId, vcsRepositories.fullName)
							.orderBy(desc(sql`count(*)`))
							.limit(TOP),
					),
					dbExecute((db) =>
						db
							.select({
								repositoryId: prReviewFindings.repositoryId,
								fullName: vcsRepositories.fullName,
								findings: sql<number>`count(*)::int`,
							})
							.from(prReviewFindings)
							.leftJoin(prReviews, eq(prReviews.id, prReviewFindings.reviewId))
							.innerJoin(vcsRepositories, eq(vcsRepositories.id, prReviewFindings.repositoryId))
							.where(findingWhere)
							.groupBy(prReviewFindings.repositoryId, vcsRepositories.fullName)
							.orderBy(desc(sql`count(*)`))
							.limit(TOP),
					),
					dbExecute((db) =>
						db
							.select({ author: prReviews.authorLogin, pullRequests: pullRequestCount })
							.from(prReviews)
							.where(and(reviewWhere, sql`${prReviews.authorLogin} is not null`))
							.groupBy(prReviews.authorLogin)
							.orderBy(desc(pullRequestCount), prReviews.authorLogin)
							.limit(TOP),
					),
					dbExecute((db) =>
						db
							.select({ author: prReviews.authorLogin, findings: sql<number>`count(*)::int` })
							.from(prReviewFindings)
							.innerJoin(prReviews, eq(prReviews.id, prReviewFindings.reviewId))
							.where(and(findingWhere, sql`${prReviews.authorLogin} is not null`))
							.groupBy(prReviews.authorLogin),
					),
				],
				{ concurrency: 4 },
			)

			// Every bucket of the window, so the chart's x axis is the window and not the data.
			const bucketMs = bucketSeconds * 1000
			const first = Math.floor(startTime / bucketMs) * bucketMs
			const series = new Map<
				number,
				{ reviews: number; pullRequests: number; critical: number; warn: number; info: number }
			>()
			for (let at = first; at < query.endTime; at += bucketMs)
				series.set(at, { reviews: 0, pullRequests: 0, critical: 0, warn: 0, info: 0 })
			for (const row of reviewSeries) {
				const slot = series.get(num(row.bucket))
				if (slot === undefined) continue
				slot.reviews = num(row.reviews)
				slot.pullRequests = num(row.pullRequests)
			}
			for (const row of findingSeries) {
				const slot = series.get(num(row.bucket))
				if (slot === undefined) continue
				slot[row.severity] += num(row.findings)
			}

			const verdictCount = (verdict: string) =>
				num(verdicts.find((row) => row.verdict === verdict)?.reviews)
			const findingsByRepo = new Map(repoFindings.map((row) => [row.repositoryId, row]))
			const reviewsByRepo = new Map(repoReviews.map((row) => [row.repositoryId, row]))
			const repositoryIds = [...new Set([...reviewsByRepo.keys(), ...findingsByRepo.keys()])]
			const findingsByAuthor = new Map(authorFindings.map((row) => [row.author, num(row.findings)]))

			return new CodeReviewAnalytics({
				bucketSeconds,
				current,
				previous: before,
				series: [...series].map(([bucket, slot]) => new CodeReviewBucket({ bucket, ...slot })),
				categories: categories.map(
					(row) =>
						new CodeReviewCategoryCount({ category: row.category, findings: num(row.findings) }),
				),
				verdicts: new CodeReviewVerdicts({
					clean: verdictCount("clean"),
					issues: verdictCount("issues"),
					notApplicable: verdictCount("not_applicable"),
				}),
				repositories: repositoryIds.map((repositoryId) => {
					const reviewed = reviewsByRepo.get(repositoryId)
					const found = findingsByRepo.get(repositoryId)
					return new CodeReviewRepositoryCount({
						repositoryId,
						fullName: reviewed?.fullName ?? found?.fullName ?? "",
						reviews: num(reviewed?.reviews),
						findings: num(found?.findings),
					})
				}),
				authors: authorReviews.flatMap((row) =>
					row.author === null
						? []
						: [
								new CodeReviewAuthorCount({
									author: row.author,
									pullRequests: num(row.pullRequests),
									findings: findingsByAuthor.get(row.author) ?? 0,
								}),
							],
				),
			})
		})

		const listReviews = Effect.fn("PrReviewAnalyticsService.listReviews")(function* (
			orgId: OrgId,
			query: CodeReviewListQuery,
		) {
			const limit = query.limit ?? DEFAULT_PAGE
			const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor)
			const window: Window = { start: msToDate(query.startTime), end: msToDate(query.endTime) }
			yield* Effect.annotateCurrentSpan({ orgId, "maple.code_review.limit": limit })
			const rows = yield* dbExecute((db) =>
				db
					.select(listColumns)
					.from(prReviews)
					.innerJoin(vcsRepositories, eq(vcsRepositories.id, prReviews.repositoryId))
					.where(
						and(
							reviewFilter(orgId, window, query),
							query.status === undefined ? undefined : eq(prReviews.status, query.status),
							query.verdict === undefined ? undefined : sql`${verdictSql} = ${query.verdict}`,
							cursor === undefined
								? undefined
								: or(
										lt(prReviews.createdAt, cursor.createdAt),
										and(
											eq(prReviews.createdAt, cursor.createdAt),
											sql`${prReviews.id} < ${cursor.id}`,
										),
									),
						),
					)
					.orderBy(desc(prReviews.createdAt), desc(prReviews.id))
					.limit(limit + 1),
			)
			const page = rows.slice(0, limit)
			const reviews = yield* decodeRows(page.map(listItemInput), decodeListItem)
			const last = page.at(-1)
			return new CodeReviewListResponse({
				reviews,
				nextCursor:
					rows.length > limit && last !== undefined
						? encodeCursor(dateToMs(last.createdAt), last.id)
						: null,
			})
		})

		const getReview = Effect.fn("PrReviewAnalyticsService.getReview")(function* (
			orgId: OrgId,
			reviewId: PrReviewId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.pr_review.id": reviewId })
			const rows = yield* dbExecute((db) =>
				db
					.select({
						...listColumns,
						report: prReviews.reportJson,
						checkRunUrl: prReviews.checkRunUrl,
						reviewUrl: prReviews.reviewUrl,
						inputTokens: prReviews.inputTokens,
						outputTokens: prReviews.outputTokens,
						startedAt: prReviews.startedAt,
					})
					.from(prReviews)
					.innerJoin(vcsRepositories, eq(vcsRepositories.id, prReviews.repositoryId))
					.where(and(eq(prReviews.orgId, orgId), eq(prReviews.id, reviewId)))
					.limit(1),
			)
			const row = rows[0]
			if (row === undefined)
				return yield* new PrReviewNotFoundError({
					message: "Pull request review not found",
					reviewId,
				})
			const { report, checkRunUrl, reviewUrl, inputTokens, outputTokens, startedAt, ...listRow } = row

			const [historyRows, findingRows] = yield* Effect.all(
				[
					dbExecute((db) =>
						db
							.select(listColumns)
							.from(prReviews)
							.innerJoin(vcsRepositories, eq(vcsRepositories.id, prReviews.repositoryId))
							.where(
								and(
									eq(prReviews.orgId, orgId),
									eq(prReviews.repositoryId, row.repositoryId),
									eq(prReviews.number, row.number),
								),
							)
							.orderBy(desc(prReviews.createdAt))
							.limit(50),
					),
					dbExecute((db) =>
						db
							.select(findingColumns)
							.from(prReviewFindings)
							.leftJoin(prReviews, eq(prReviews.id, prReviewFindings.reviewId))
							.innerJoin(vcsRepositories, eq(vcsRepositories.id, prReviewFindings.repositoryId))
							.where(
								and(
									eq(prReviewFindings.orgId, orgId),
									eq(prReviewFindings.repositoryId, row.repositoryId),
									eq(prReviewFindings.number, row.number),
								),
							)
							.orderBy(prReviewFindings.createdAt),
					),
				],
				{ concurrency: 2 },
			)
			const [review] = yield* decodeRows([listItemInput(listRow)], decodeListItem)
			const history = yield* decodeRows(historyRows.map(listItemInput), decodeListItem)
			const findings = yield* decodeRows(findingRows.map(findingInput), decodeFinding)
			if (review === undefined)
				return yield* new PrReviewNotFoundError({
					message: "Pull request review not found",
					reviewId,
				})
			return new CodeReviewDetail({
				review,
				// A report from an older shape reads as none rather than failing the page.
				report: Option.getOrNull(decodeReport(report)),
				checkRunUrl,
				reviewUrl,
				inputTokens,
				outputTokens,
				startedAt: startedAt === null ? null : dateToMs(startedAt),
				history,
				findings,
			})
		})

		const listFindings = Effect.fn("PrReviewAnalyticsService.listFindings")(function* (
			orgId: OrgId,
			query: CodeReviewFindingsQuery,
		) {
			const limit = query.limit ?? DEFAULT_PAGE
			const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor)
			const window: Window = { start: msToDate(query.startTime), end: msToDate(query.endTime) }
			yield* Effect.annotateCurrentSpan({ orgId, "maple.code_review.limit": limit })
			const rows = yield* dbExecute((db) =>
				db
					.select(findingColumns)
					.from(prReviewFindings)
					.leftJoin(prReviews, eq(prReviews.id, prReviewFindings.reviewId))
					.innerJoin(vcsRepositories, eq(vcsRepositories.id, prReviewFindings.repositoryId))
					.where(
						and(
							findingFilter(orgId, window, query),
							query.severity === undefined
								? undefined
								: eq(prReviewFindings.severity, query.severity),
							query.category === undefined
								? undefined
								: eq(prReviewFindings.category, query.category),
							query.status === undefined
								? undefined
								: eq(prReviewFindings.status, query.status),
							cursor === undefined
								? undefined
								: or(
										lt(prReviewFindings.createdAt, cursor.createdAt),
										and(
											eq(prReviewFindings.createdAt, cursor.createdAt),
											lt(prReviewFindings.id, cursor.id),
										),
									),
						),
					)
					.orderBy(desc(prReviewFindings.createdAt), desc(prReviewFindings.id))
					.limit(limit + 1),
			)
			const page = rows.slice(0, limit)
			const findings = yield* decodeRows(page.map(findingInput), decodeFinding)
			const last = page.at(-1)
			return new CodeReviewFindingsResponse({
				findings,
				nextCursor:
					rows.length > limit && last !== undefined
						? encodeCursor(dateToMs(last.createdAt), last.id)
						: null,
			})
		})

		return { analytics, listReviews, getReview, listFindings } satisfies PrReviewAnalyticsServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
