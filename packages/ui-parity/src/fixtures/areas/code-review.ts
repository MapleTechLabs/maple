import { Effect, Predicate, Schema } from "effect"
import { PrReviewId, PrReviewNotFoundError } from "@maple/domain/http"
import type { FixtureArea } from "../areas.ts"
import type { Dataset, EndpointHandler } from "../dataset.ts"
import { acmeAdmin, DAY, FROZEN_NOW, MINUTE } from "../identity.ts"
import { codeReviewCiTelemetry } from "../telemetry/code-review-ci.ts"
import { codeReviewCiEndpoints } from "../telemetry/code-review-ci-endpoints.ts"
import {
	CODE_REVIEW_FINDINGS,
	CODE_REVIEW_ORG_ID,
	CODE_REVIEW_REPOS,
	CODE_REVIEWS,
	reportOf,
	type CodeReviewFindingItem,
	type CodeReviewItem,
} from "../telemetry/code-review-records.ts"

/**
 * Code Review: org `org_parity_code_review` has the GitHub App on four repositories, ten reviews
 * and twelve findings over the last month (Postgres reads, canned), and three weeks of GitHub
 * Actions traces that the CI tab reads through the real CI queries. Every other org reads empty.
 */

const num = (value: unknown, key: string): number | undefined => {
	const raw = Predicate.hasProperty(value, key) ? value[key] : undefined
	return raw === undefined || raw === null || raw === "" ? undefined : Number(raw)
}
const str = (value: unknown, key: string): string | undefined => {
	const raw = Predicate.hasProperty(value, key) ? value[key] : undefined
	return typeof raw === "string" ? raw : undefined
}

const isOurs = (request: { readonly dataset: Dataset }) =>
	request.dataset.identity?.orgId === CODE_REVIEW_ORG_ID

interface Filter {
	readonly start: number
	readonly end: number
	readonly repositoryId: string | undefined
	readonly author: string | undefined
	/** False for every org but the code-review one, which then reads empty. */
	readonly ours: boolean
}
const filterOf = (request: { readonly dataset: Dataset; readonly query: unknown }): Filter => ({
	ours: isOurs(request),
	start: num(request.query, "startTime") ?? 0,
	end: num(request.query, "endTime") ?? Number.MAX_SAFE_INTEGER,
	repositoryId: str(request.query, "repositoryId"),
	author: str(request.query, "author"),
})

const reviewIn = (filter: Filter) => (review: CodeReviewItem) =>
	filter.ours &&
	review.createdAt >= filter.start &&
	review.createdAt < filter.end &&
	(filter.repositoryId === undefined || review.repositoryId === filter.repositoryId) &&
	(filter.author === undefined || review.authorLogin === filter.author)

const reviewOf = (finding: CodeReviewFindingItem) =>
	CODE_REVIEWS.find((review) => review.id === finding.reviewId)
const findingIn = (filter: Filter) => (finding: CodeReviewFindingItem) =>
	filter.ours &&
	finding.createdAt >= filter.start &&
	finding.createdAt < filter.end &&
	(filter.repositoryId === undefined || finding.repositoryId === filter.repositoryId) &&
	(filter.author === undefined || reviewOf(finding)?.authorLogin === filter.author)

const distinctPrs = (reviews: ReadonlyArray<CodeReviewItem>) =>
	new Set(reviews.map((r) => `${r.repositoryId}#${r.number}`)).size
const average = (values: ReadonlyArray<number>) =>
	values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length

const totalsOf = (filter: Filter) => {
	const reviews = CODE_REVIEWS.filter(reviewIn(filter))
	const findings = CODE_REVIEW_FINDINGS.filter(findingIn(filter))
	const completed = reviews.filter((review) => review.status === "completed")
	const merged = reviews.filter((review) => review.mergedAt !== null)
	return {
		pullRequests: distinctPrs(reviews),
		reviews: reviews.length,
		completedReviews: completed.length,
		failedReviews: reviews.filter((review) => review.status === "failed").length,
		skippedReviews: reviews.filter((review) => review.status === "skipped").length,
		findings: findings.length,
		criticalFindings: findings.filter((finding) => finding.severity === "critical").length,
		resolvedFindings: findings.filter((finding) => finding.status === "resolved").length,
		dismissedFindings: findings.filter((finding) => finding.status === "dismissed").length,
		repositoriesWithFindings: new Set(findings.map((finding) => finding.repositoryId)).size,
		mergedPullRequests: distinctPrs(merged),
		avgReviewSeconds: average(
			completed.map((review) => ((review.finishedAt ?? review.createdAt) - review.createdAt) / 1000),
		),
		avgMergeSeconds: average(
			merged.map((review) => ((review.mergedAt ?? review.createdAt) - review.createdAt) / 1000),
		),
		avgConfidence: average(
			completed.flatMap((review) => (review.confidence === null ? [] : [review.confidence])),
		),
		avgScore: average(completed.flatMap((review) => (review.score === null ? [] : [review.score]))),
		inputTokens: completed.length * 48_200,
		outputTokens: completed.length * 3_150,
	}
}

/** `codeReviewBucketSeconds`: hourly to two days, daily to 120, weekly beyond. */
const bucketSecondsOf = (spanMs: number) =>
	spanMs <= 2 * DAY ? 3_600 : spanMs <= 120 * DAY ? 86_400 : 7 * 86_400

/** `PrReviewAnalyticsService.analytics` over the fixture rows, same windows and buckets. */
const analytics: EndpointHandler = (request) => {
	const asked = filterOf(request)
	const start = Math.max(asked.start, asked.end - 366 * DAY)
	const filter: Filter = { ...asked, start }
	const spanMs = Math.max(filter.end - start, MINUTE)
	const bucketSeconds = bucketSecondsOf(spanMs)
	const bucketMs = bucketSeconds * 1000
	const first = Math.floor(start / bucketMs) * bucketMs
	const reviews = CODE_REVIEWS.filter(reviewIn(filter))
	const findings = CODE_REVIEW_FINDINGS.filter(findingIn(filter))
	const series = Array.from({ length: Math.max(0, Math.ceil((asked.end - first) / bucketMs)) }, (_, i) => {
		const bucket = first + i * bucketMs
		const inBucket = (at: number) => at >= bucket && at < bucket + bucketMs
		const bucketReviews = reviews.filter((review) => inBucket(review.createdAt))
		const bucketFindings = findings.filter((finding) => inBucket(finding.createdAt))
		const severity = (level: string) =>
			bucketFindings.filter((finding) => finding.severity === level).length
		return {
			bucket,
			reviews: bucketReviews.length,
			pullRequests: distinctPrs(bucketReviews),
			critical: severity("critical"),
			warn: severity("warn"),
			info: severity("info"),
		}
	})
	const categories = [...new Set(findings.map((finding) => finding.category))]
		.map((category) => ({
			category,
			findings: findings.filter((finding) => finding.category === category).length,
		}))
		.sort((a, b) => b.findings - a.findings || a.category.localeCompare(b.category))
	const completed = reviews.filter((review) => review.status === "completed")
	const verdict = (value: string) => completed.filter((review) => review.verdict === value).length
	const repositories = CODE_REVIEW_REPOS.flatMap((repo) => {
		const repoReviews = reviews.filter((review) => review.repositoryId === repo.id).length
		const repoFindings = findings.filter((finding) => finding.repositoryId === repo.id).length
		return repoReviews + repoFindings === 0
			? []
			: [
					{
						repositoryId: repo.id,
						fullName: repo.fullName,
						reviews: repoReviews,
						findings: repoFindings,
					},
				]
	})
	const authors = [
		...new Set(reviews.flatMap((review) => (review.authorLogin === null ? [] : [review.authorLogin]))),
	]
		.map((author) => ({
			author,
			pullRequests: distinctPrs(reviews.filter((review) => review.authorLogin === author)),
			findings: findings.filter((finding) => reviewOf(finding)?.authorLogin === author).length,
		}))
		.sort((a, b) => b.pullRequests - a.pullRequests || a.author.localeCompare(b.author))
	return Effect.succeed({
		bucketSeconds,
		current: totalsOf(filter),
		previous: totalsOf({ ...filter, start: start - spanMs, end: start }),
		series,
		categories,
		verdicts: {
			clean: verdict("clean"),
			issues: verdict("issues"),
			notApplicable: verdict("not_applicable"),
		},
		repositories,
		authors,
	})
}

const listReviews: EndpointHandler = (request) => {
	const filter = filterOf(request)
	const status = str(request.query, "status")
	const verdict = str(request.query, "verdict")
	const limit = num(request.query, "limit") ?? 50
	const reviews = CODE_REVIEWS.filter(reviewIn(filter))
		.filter(
			(review) =>
				(status === undefined || review.status === status) &&
				(verdict === undefined || review.verdict === verdict),
		)
		.sort((a, b) => b.createdAt - a.createdAt)
	return Effect.succeed({ reviews: reviews.slice(0, limit), nextCursor: null })
}

const listFindings: EndpointHandler = (request) => {
	const filter = filterOf(request)
	const severity = str(request.query, "severity")
	const category = str(request.query, "category")
	const status = str(request.query, "status")
	const limit = num(request.query, "limit") ?? 50
	const findings = CODE_REVIEW_FINDINGS.filter(findingIn(filter))
		.filter(
			(finding) =>
				(severity === undefined || finding.severity === severity) &&
				(category === undefined || finding.category === category) &&
				(status === undefined || finding.status === status),
		)
		.sort((a, b) => b.createdAt - a.createdAt)
	return Effect.succeed({ findings: findings.slice(0, limit), nextCursor: null })
}

const getReview: EndpointHandler = (request) => {
	const id = str(request.params, "reviewId") ?? ""
	const review = isOurs(request) ? CODE_REVIEWS.find((candidate) => candidate.id === id) : undefined
	if (review === undefined)
		return Effect.flatMap(Schema.decodeUnknownEffect(PrReviewId)(id), (reviewId) =>
			Effect.fail(new PrReviewNotFoundError({ message: `Review ${id} not found`, reviewId })),
		)
	const samePr = (other: CodeReviewItem) =>
		other.repositoryId === review.repositoryId && other.number === review.number
	const report = reportOf(review)
	return Effect.succeed({
		review,
		report,
		checkRunUrl: report === null ? null : `${review.url}/checks`,
		reviewUrl: review.commentUrl,
		inputTokens: report === null ? null : 48_200,
		outputTokens: report === null ? null : 3_150,
		startedAt: review.status === "skipped" ? null : review.createdAt + 20_000,
		history: CODE_REVIEWS.filter(samePr).sort((a, b) => b.createdAt - a.createdAt),
		findings: CODE_REVIEW_FINDINGS.filter((finding) =>
			CODE_REVIEWS.some((other) => samePr(other) && other.id === finding.reviewId),
		),
	})
}

const prReviewSettings: EndpointHandler = (request) =>
	Effect.succeed({
		settings: isOurs(request)
			? {
					model: "anthropic/claude-sonnet-5.5",
					defaults: {
						instructions: "Flag any query that does not filter by OrgId.",
						ignorePaths: ["docs/", "*.lock"],
						minInlineSeverity: "warn",
						reviewDrafts: false,
						dailyLimit: 40,
					},
				}
			: {},
	})

const prReviewConfig: EndpointHandler = (request) =>
	Effect.succeed({
		config:
			isOurs(request) && str(request.params, "repositoryId") === CODE_REVIEW_REPOS[1].id
				? {
						instructions: "Money moves through the ledger only. Flag direct balance updates.",
						categories: ["correctness", "security", "observability"],
						automaticReviewLimit: 5,
					}
				: {},
	})

const githubStatus: EndpointHandler = () =>
	Effect.succeed({
		connected: true,
		state: "connected",
		accountLogin: "acme-shop",
		accountType: "organization",
		repositorySelection: "selected",
		ciTracesEnabled: true,
		repositories: CODE_REVIEW_REPOS,
	})

export const CODE_REVIEW_DATASET = "code-review"

const codeReviewDataset: Dataset = {
	name: CODE_REVIEW_DATASET,
	now: FROZEN_NOW,
	identity: { ...acmeAdmin, orgId: CODE_REVIEW_ORG_ID },
	auth: "self_hosted",
	endpoints: { "integrations.githubStatus": githubStatus },
	synced: {},
	telemetry: codeReviewCiTelemetry({ orgId: CODE_REVIEW_ORG_ID, now: new Date(FROZEN_NOW), seed: 31 }),
}

export const fixtureArea: FixtureArea = {
	area: "code-review",
	endpoints: (warehouse) => ({
		"codeReview.analytics": analytics,
		"codeReview.listReviews": listReviews,
		"codeReview.listFindings": listFindings,
		"codeReview.getReview": getReview,
		"integrations.githubGetPrReviewSettings": prReviewSettings,
		"integrations.githubGetPrReviewConfig": prReviewConfig,
		...codeReviewCiEndpoints(warehouse),
	}),
	datasets: [codeReviewDataset],
}
