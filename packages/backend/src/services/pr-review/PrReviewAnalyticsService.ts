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
	PrReviewPostMerge,
	PrReviewReport,
	type PrReviewId,
	type VcsRepositoryId,
} from "@maple/domain/http"
import type { OrgId } from "@maple/domain/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { PrReviewFindings, PrReviews, VcsRepositories } from "@maple/db/tables"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"

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
const decodePostMerge = Schema.decodeUnknownOption(PrReviewPostMerge)
const decodeTotals = Schema.decodeUnknownEffect(CodeReviewTotals)

const decodeRows = <I, A>(rows: ReadonlyArray<I>, decode: (row: I) => Effect.Effect<A, Schema.SchemaError>) =>
	Effect.forEach(rows, decode).pipe(
		Effect.mapError((error) => new PrReviewPersistenceError({ message: error.message })),
	)

const encodeCursor = (createdAtMs: number, id: string) => `${createdAtMs}_${id}`
const decodeCursor = (cursor: string) => {
	const at = cursor.indexOf("_")
	return { createdAt: Number(cursor.slice(0, at)), id: cursor.slice(at + 1) }
}

type Reviews = PG.ColumnAccessor<typeof PrReviews.columns>
type Findings = PG.ColumnAccessor<typeof PrReviewFindings.columns>

// Read from the stored report in SQL so a list never loads the reports themselves.
const verdictOf = ($: Reviews) => PG.jsonText($.reportJson, "verdict")
const confidenceOf = ($: Reviews) => PG.sql(PG.nullable(PG.float8))`(${$.reportJson}->>'confidence')::float8`
const findingsCountOf = ($: Reviews) =>
	PG.sql(PG.int4)`coalesce(jsonb_array_length(${$.reportJson}->'findings'), 0)::int`
const pullRequestCountOf = ($: Reviews) =>
	PG.sql(PG.int4)`count(distinct ${$.repositoryId} || ':' || ${$.number})::int`
const criticalCountOf = ($: Reviews) =>
	PG.sql(
		PG.int4,
	)`coalesce((select count(*) from jsonb_array_elements(${$.reportJson}->'findings') as f where f->>'severity' = 'critical'), 0)::int`

const listColumns = ($: Reviews, repositoryFullName: PG.Expr<string>) => ({
	id: $.id,
	repositoryId: $.repositoryId,
	repositoryFullName,
	number: $.number,
	title: $.title,
	url: $.url,
	authorLogin: $.authorLogin,
	headSha: $.headSha,
	status: $.status,
	skipReason: $.skipReason,
	verdict: verdictOf($),
	score: $.score,
	confidence: confidenceOf($),
	findings: findingsCountOf($),
	criticalFindings: criticalCountOf($),
	commentUrl: $.commentUrl,
	publishError: $.publishError,
	error: $.error,
	model: $.model,
	createdAt: $.createdAt,
	finishedAt: $.finishedAt,
	mergedAt: $.mergedAt,
})

const findingColumns = (
	$: Findings,
	review: { readonly title: PG.Expr<string | null>; readonly url: PG.Expr<string | null> },
	repositoryFullName: PG.Expr<string>,
) => ({
	id: $.id,
	reviewId: $.reviewId,
	repositoryId: $.repositoryId,
	repositoryFullName,
	number: $.number,
	pullRequestTitle: review.title,
	pullRequestUrl: review.url,
	handle: $.handle,
	path: $.path,
	line: $.line,
	category: $.category,
	severity: $.severity,
	title: $.title,
	status: $.status,
	reactionsUp: $.reactionsUp,
	reactionsDown: $.reactionsDown,
	createdAt: $.createdAt,
})

/** Epoch milliseconds. */
interface Window {
	readonly start: number
	readonly end: number
}

export class PrReviewAnalyticsService extends Context.Service<
	PrReviewAnalyticsService,
	PrReviewAnalyticsServiceApi
>()("@maple/api/services/pr-review/PrReviewAnalyticsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const dbExecute = makeDbExecute(database, "PrReviewAnalyticsService", toPersistence)

		// The filters shared by every read; the author lives on the review, so findings join it.
		const reviewFilter =
			(
				orgId: OrgId,
				window: Window,
				query: {
					readonly repositoryId?: VcsRepositoryId | undefined
					readonly author?: string | undefined
				},
			) =>
			($: Reviews) => [
				$.orgId.eq(orgId),
				$.createdAt.gte(window.start),
				$.createdAt.lt(window.end),
				query.repositoryId === undefined ? undefined : $.repositoryId.eq(query.repositoryId),
				query.author === undefined ? undefined : $.authorLogin.eq(query.author),
			]
		const findingFilter =
			(
				orgId: OrgId,
				window: Window,
				query: {
					readonly repositoryId?: VcsRepositoryId | undefined
					readonly author?: string | undefined
				},
			) =>
			($: Findings, reviewAuthor: PG.Expr<string | null>) => [
				$.orgId.eq(orgId),
				$.createdAt.gte(window.start),
				$.createdAt.lt(window.end),
				query.repositoryId === undefined ? undefined : $.repositoryId.eq(query.repositoryId),
				query.author === undefined ? undefined : reviewAuthor.eq(query.author),
			]

		const reviewsWithRepositories = () =>
			PG.from(PrReviews).innerJoin(VcsRepositories, "repo", (review, repo) =>
				repo.id.eq(review.repositoryId),
			)
		const findingsWithRepositories = () =>
			PG.from(PrReviewFindings)
				.leftJoin(PrReviews, "r", (finding, review) => review.id.eq(finding.reviewId))
				.innerJoin(VcsRepositories, "repo", (finding, repo) => repo.id.eq(finding.repositoryId))

		const totals = Effect.fn("PrReviewAnalyticsService.totals")(function* (
			orgId: OrgId,
			window: Window,
			query: CodeReviewAnalyticsQuery,
		) {
			const where = reviewFilter(orgId, window, query)
			const [reviewRows, findingRows, mergeRows] = yield* Effect.all(
				[
					dbExecute((db) =>
						db.orm.run(
							PG.from(PrReviews)
								.select(($) => {
									const completed = $.status.eq("completed")
									return {
										reviews: PG.count(),
										pullRequests: pullRequestCountOf($),
										completedReviews: PG.countIf(completed),
										failedReviews: PG.countIf($.status.eq("failed")),
										skippedReviews: PG.countIf($.status.eq("skipped")),
										avgReviewSeconds: PG.sql(
											PG.nullable(PG.float8),
										)`(avg(extract(epoch from (${$.finishedAt} - ${$.createdAt}))) filter (where ${completed} and ${$.finishedAt} is not null))::float8`,
										avgConfidence: PG.sql(
											PG.nullable(PG.float8),
										)`(avg(${confidenceOf($)}) filter (where ${completed}))::float8`,
										avgScore: PG.sql(
											PG.nullable(PG.float8),
										)`(avg(${$.score}) filter (where ${completed}))::float8`,
										inputTokens: PG.sql(
											PG.float8,
										)`coalesce(sum(${$.inputTokens}), 0)::float8`,
										outputTokens: PG.sql(
											PG.float8,
										)`coalesce(sum(${$.outputTokens}), 0)::float8`,
									}
								})
								.where(where),
						),
					),
					dbExecute((db) =>
						db.orm.run(
							PG.from(PrReviewFindings)
								.leftJoin(PrReviews, "r", (finding, review) => review.id.eq(finding.reviewId))
								.select(($) => ({
									findings: PG.count(),
									criticalFindings: PG.countIf($.severity.eq("critical")),
									resolvedFindings: PG.countIf($.status.eq("resolved")),
									dismissedFindings: PG.countIf($.status.eq("dismissed")),
									repositoriesWithFindings: PG.countDistinct($.repositoryId),
								}))
								.where(($) => findingFilter(orgId, window, query)($, $.r.authorLogin)),
						),
					),
					// Per pull request: its first review in the window to its merge.
					dbExecute((db) =>
						db.orm.run(
							PG.fromQuery(
								PG.from(PrReviews)
									.select(($) => ({
										repositoryId: $.repositoryId,
										number: $.number,
										firstAt: PG.min($.createdAt),
										mergedAt: PG.max($.mergedAt),
									}))
									.where(where)
									.groupBy("repositoryId", "number"),
								"pr",
							)
								.select(($) => ({
									merged: PG.count(),
									avgSeconds: PG.sql(
										PG.nullable(PG.float8),
									)`avg(extract(epoch from (${$.mergedAt} - ${$.firstAt})))::float8`,
								}))
								.where(($) => [$.mergedAt.isNotNull()]),
						),
					),
				],
				{ concurrency: 3 },
			)
			const reviews = reviewRows[0]
			const findings = findingRows[0]
			const merge = mergeRows[0]
			return yield* decodeTotals({
				pullRequests: reviews?.pullRequests ?? 0,
				reviews: reviews?.reviews ?? 0,
				completedReviews: reviews?.completedReviews ?? 0,
				failedReviews: reviews?.failedReviews ?? 0,
				skippedReviews: reviews?.skippedReviews ?? 0,
				findings: findings?.findings ?? 0,
				criticalFindings: findings?.criticalFindings ?? 0,
				resolvedFindings: findings?.resolvedFindings ?? 0,
				dismissedFindings: findings?.dismissedFindings ?? 0,
				repositoriesWithFindings: findings?.repositoriesWithFindings ?? 0,
				mergedPullRequests: merge?.merged ?? 0,
				avgReviewSeconds: reviews?.avgReviewSeconds ?? null,
				avgMergeSeconds: merge?.avgSeconds ?? null,
				avgConfidence: reviews?.avgConfidence ?? null,
				avgScore: reviews?.avgScore ?? null,
				inputTokens: reviews?.inputTokens ?? 0,
				outputTokens: reviews?.outputTokens ?? 0,
			}).pipe(Effect.mapError(toPersistence))
		})

		const analytics = Effect.fn("PrReviewAnalyticsService.analytics")(function* (
			orgId: OrgId,
			query: CodeReviewAnalyticsQuery,
		) {
			const startTime = Math.max(query.startTime, query.endTime - MAX_SPAN_MS)
			const spanMs = Math.max(query.endTime - startTime, 60_000)
			const bucketSeconds = codeReviewBucketSeconds(spanMs)
			const window: Window = { start: startTime, end: query.endTime }
			const previous: Window = { start: startTime - spanMs, end: window.start }
			yield* Effect.annotateCurrentSpan({
				orgId,
				"maple.code_review.span_ms": spanMs,
				"maple.code_review.bucket_seconds": bucketSeconds,
				"maple.code_review.filtered": query.repositoryId !== undefined || query.author !== undefined,
			})

			// Inlined, not bound: a number in the template is written as a literal. The value is
			// computed here, never taken from the request.
			const bucketOf = (column: PG.Expr<number>) =>
				PG.sql(
					PG.float8,
				)`(floor(extract(epoch from ${column}) / ${bucketSeconds}) * ${bucketSeconds} * 1000)::float8`
			const reviewWhere = reviewFilter(orgId, window, query)
			const findingWhere = findingFilter(orgId, window, query)
			const findingsWithReviews = () =>
				PG.from(PrReviewFindings).leftJoin(PrReviews, "r", (finding, review) =>
					review.id.eq(finding.reviewId),
				)

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
						db.orm.run(
							PG.from(PrReviews)
								.select(($) => ({
									bucket: bucketOf($.createdAt),
									reviews: PG.count(),
									pullRequests: pullRequestCountOf($),
								}))
								.where(reviewWhere)
								.groupBy("bucket"),
						),
					),
					dbExecute((db) =>
						db.orm.run(
							findingsWithReviews()
								.select(($) => ({
									bucket: bucketOf($.createdAt),
									severity: $.severity,
									findings: PG.count(),
								}))
								.where(($) => findingWhere($, $.r.authorLogin))
								.groupBy("bucket", "severity"),
						),
					),
					dbExecute((db) =>
						db.orm.run(
							findingsWithReviews()
								.select(($) => ({ category: $.category, findings: PG.count() }))
								.where(($) => findingWhere($, $.r.authorLogin))
								.groupBy("category")
								.orderBy(["findings", "desc"]),
						),
					),
					dbExecute((db) =>
						db.orm.run(
							PG.from(PrReviews)
								.select(($) => ({ verdict: verdictOf($), reviews: PG.count() }))
								.where(($) => [...reviewWhere($), $.status.eq("completed")])
								.groupBy("verdict"),
						),
					),
					dbExecute((db) =>
						db.orm.run(
							PG.from(PrReviews)
								.innerJoin(VcsRepositories, "repo", (review, repo) =>
									repo.id.eq(review.repositoryId),
								)
								.select(($) => ({
									repositoryId: $.repositoryId,
									fullName: $.repo.fullName,
									reviews: PG.count(),
								}))
								.where(reviewWhere)
								.groupBy("repositoryId", "fullName")
								.orderBy(["reviews", "desc"])
								.limit(TOP),
						),
					),
					dbExecute((db) =>
						db.orm.run(
							findingsWithReviews()
								.innerJoin(VcsRepositories, "repo", (finding, repo) =>
									repo.id.eq(finding.repositoryId),
								)
								.select(($) => ({
									repositoryId: $.repositoryId,
									fullName: $.repo.fullName,
									findings: PG.count(),
								}))
								.where(($) => findingWhere($, $.r.authorLogin))
								.groupBy("repositoryId", "fullName")
								.orderBy(["findings", "desc"])
								.limit(TOP),
						),
					),
					dbExecute((db) =>
						db.orm.run(
							PG.from(PrReviews)
								.select(($) => ({
									author: $.authorLogin,
									pullRequests: pullRequestCountOf($),
								}))
								.where(($) => [...reviewWhere($), $.authorLogin.isNotNull()])
								.groupBy("author")
								.orderBy(["pullRequests", "desc"], ["author", "asc"])
								.limit(TOP),
						),
					),
					dbExecute((db) =>
						db.orm.run(
							PG.from(PrReviewFindings)
								.innerJoin(PrReviews, "r", (finding, review) =>
									review.id.eq(finding.reviewId),
								)
								.select(($) => ({ author: $.r.authorLogin, findings: PG.count() }))
								.where(($) => [
									...findingWhere($, $.r.authorLogin),
									$.r.authorLogin.isNotNull(),
								])
								.groupBy("author"),
						),
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
				const slot = series.get(row.bucket)
				if (slot === undefined) continue
				slot.reviews = row.reviews
				slot.pullRequests = row.pullRequests
			}
			for (const row of findingSeries) {
				const slot = series.get(row.bucket)
				if (slot === undefined) continue
				slot[row.severity] += row.findings
			}

			const verdictCount = (verdict: string) =>
				verdicts.find((row) => row.verdict === verdict)?.reviews ?? 0
			const findingsByRepo = new Map(repoFindings.map((row) => [row.repositoryId, row]))
			const reviewsByRepo = new Map(repoReviews.map((row) => [row.repositoryId, row]))
			const repositoryIds = [...new Set([...reviewsByRepo.keys(), ...findingsByRepo.keys()])]
			const findingsByAuthor = new Map(authorFindings.map((row) => [row.author, row.findings]))

			return new CodeReviewAnalytics({
				bucketSeconds,
				current,
				previous: before,
				series: [...series].map(([bucket, slot]) => new CodeReviewBucket({ bucket, ...slot })),
				categories: categories.map(
					(row) => new CodeReviewCategoryCount({ category: row.category, findings: row.findings }),
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
						reviews: reviewed?.reviews ?? 0,
						findings: found?.findings ?? 0,
					})
				}),
				authors: authorReviews.flatMap((row) =>
					row.author === null
						? []
						: [
								new CodeReviewAuthorCount({
									author: row.author,
									pullRequests: row.pullRequests,
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
			const window: Window = { start: query.startTime, end: query.endTime }
			yield* Effect.annotateCurrentSpan({ orgId, "maple.code_review.limit": limit })
			const rows = yield* dbExecute((db) =>
				db.orm.run(
					reviewsWithRepositories()
						.select(($) => listColumns($, $.repo.fullName))
						.where(($) => [
							...reviewFilter(orgId, window, query)($),
							query.status === undefined ? undefined : $.status.eq(query.status),
							query.verdict === undefined ? undefined : verdictOf($).eq(query.verdict),
							cursor === undefined
								? undefined
								: PG.or(
										$.createdAt.lt(cursor.createdAt),
										PG.and(
											$.createdAt.eq(cursor.createdAt),
											PG.undecoded($.id).lt(cursor.id),
										),
									),
						])
						.orderBy(["createdAt", "desc"], ["id", "desc"])
						.limit(limit + 1),
				),
			)
			const page = rows.slice(0, limit)
			const reviews = yield* decodeRows(page, decodeListItem)
			const last = page.at(-1)
			return new CodeReviewListResponse({
				reviews,
				nextCursor:
					rows.length > limit && last !== undefined ? encodeCursor(last.createdAt, last.id) : null,
			})
		})

		const getReview = Effect.fn("PrReviewAnalyticsService.getReview")(function* (
			orgId: OrgId,
			reviewId: PrReviewId,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.pr_review.id": reviewId })
			const rows = yield* dbExecute((db) =>
				db.orm.run(
					reviewsWithRepositories()
						.select(($) => ({
							...listColumns($, $.repo.fullName),
							// As stored, so a document from an older shape is decoded leniently below.
							report: PG.undecoded($.reportJson),
							checkRunUrl: $.checkRunUrl,
							reviewUrl: $.reviewUrl,
							inputTokens: $.inputTokens,
							outputTokens: $.outputTokens,
							startedAt: $.startedAt,
							postMerge: PG.undecoded($.postMergeJson),
						}))
						.where(($) => [$.orgId.eq(orgId), $.id.eq(reviewId)])
						.limit(1),
				),
			)
			const row = rows[0]
			if (row === undefined)
				return yield* new PrReviewNotFoundError({
					message: "Pull request review not found",
					reviewId,
				})
			const {
				report,
				checkRunUrl,
				reviewUrl,
				inputTokens,
				outputTokens,
				startedAt,
				postMerge,
				...listRow
			} = row

			const [historyRows, findingRows] = yield* Effect.all(
				[
					dbExecute((db) =>
						db.orm.run(
							reviewsWithRepositories()
								.select(($) => listColumns($, $.repo.fullName))
								.where(($) => [
									$.orgId.eq(orgId),
									$.repositoryId.eq(row.repositoryId),
									$.number.eq(row.number),
								])
								.orderBy(["createdAt", "desc"])
								.limit(50),
						),
					),
					dbExecute((db) =>
						db.orm.run(
							findingsWithRepositories()
								.select(($) => findingColumns($, $.r, $.repo.fullName))
								.where(($) => [
									$.orgId.eq(orgId),
									$.repositoryId.eq(row.repositoryId),
									$.number.eq(row.number),
								])
								.orderBy(["createdAt", "asc"]),
						),
					),
				],
				{ concurrency: 2 },
			)
			const [review] = yield* decodeRows([listRow], decodeListItem)
			const history = yield* decodeRows(historyRows, decodeListItem)
			const findings = yield* decodeRows(findingRows, decodeFinding)
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
				startedAt,
				history,
				findings,
				postMerge: Option.getOrNull(decodePostMerge(postMerge)),
			})
		})

		const listFindings = Effect.fn("PrReviewAnalyticsService.listFindings")(function* (
			orgId: OrgId,
			query: CodeReviewFindingsQuery,
		) {
			const limit = query.limit ?? DEFAULT_PAGE
			const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor)
			const window: Window = { start: query.startTime, end: query.endTime }
			yield* Effect.annotateCurrentSpan({ orgId, "maple.code_review.limit": limit })
			const rows = yield* dbExecute((db) =>
				db.orm.run(
					findingsWithRepositories()
						.select(($) => findingColumns($, $.r, $.repo.fullName))
						.where(($) => [
							...findingFilter(orgId, window, query)($, $.r.authorLogin),
							query.severity === undefined ? undefined : $.severity.eq(query.severity),
							query.category === undefined ? undefined : $.category.eq(query.category),
							query.status === undefined ? undefined : $.status.eq(query.status),
							cursor === undefined
								? undefined
								: PG.or(
										$.createdAt.lt(cursor.createdAt),
										PG.and($.createdAt.eq(cursor.createdAt), $.id.lt(cursor.id)),
									),
						])
						.orderBy(["createdAt", "desc"], ["id", "desc"])
						.limit(limit + 1),
				),
			)
			const page = rows.slice(0, limit)
			const findings = yield* decodeRows(page, decodeFinding)
			const last = page.at(-1)
			return new CodeReviewFindingsResponse({
				findings,
				nextCursor:
					rows.length > limit && last !== undefined ? encodeCursor(last.createdAt, last.id) : null,
			})
		})

		return { analytics, listReviews, getReview, listFindings } satisfies PrReviewAnalyticsServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
