import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"
import {
	PrReviewCategory,
	PrReviewFindingStatus,
	PrReviewId,
	PrReviewNotFoundError,
	PrReviewPersistenceError,
	PrReviewReport,
	PrReviewSeverity,
	PrReviewSkipReason,
	PrReviewStatus,
	PrReviewVerdict,
} from "./pr-review"
import { GitCommitSha, VcsRepositoryId } from "./vcs"

/**
 * The Code Review section's reads: analytics over a window, the organization-wide review list,
 * one review with its findings, and the findings list. Settings stay on the integrations group,
 * where the GitHub App that posts the reviews lives.
 */

/** Epoch ms up to the year 3000: past JavaScript's date range a bound turns into an Invalid Date. */
const EpochMs = Schema.NumberFromString.check(
	Schema.isInt(),
	Schema.isBetween({ minimum: 0, maximum: 32_503_680_000_000 }),
)
const PageLimit = Schema.NumberFromString.check(
	Schema.isInt(),
	Schema.isBetween({ minimum: 1, maximum: 200 }),
)
/** `<createdAtMs>_<id>` of the last row on the previous page. */
const PageCursor = Schema.String.check(Schema.isPattern(/^\d+_[0-9a-zA-Z-]+$/))
const AuthorLogin = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))

const filterFields = {
	startTime: EpochMs,
	endTime: EpochMs,
	repositoryId: Schema.optional(VcsRepositoryId),
	author: Schema.optional(AuthorLogin),
}

export const CodeReviewAnalyticsQuery = Schema.Struct(filterFields)
export type CodeReviewAnalyticsQuery = Schema.Schema.Type<typeof CodeReviewAnalyticsQuery>

export const CodeReviewListQuery = Schema.Struct({
	...filterFields,
	status: Schema.optional(PrReviewStatus),
	verdict: Schema.optional(PrReviewVerdict),
	limit: Schema.optional(PageLimit),
	cursor: Schema.optional(PageCursor),
})
export type CodeReviewListQuery = Schema.Schema.Type<typeof CodeReviewListQuery>

export const CodeReviewFindingsQuery = Schema.Struct({
	...filterFields,
	severity: Schema.optional(PrReviewSeverity),
	category: Schema.optional(PrReviewCategory),
	status: Schema.optional(PrReviewFindingStatus),
	limit: Schema.optional(PageLimit),
	cursor: Schema.optional(PageCursor),
})
export type CodeReviewFindingsQuery = Schema.Schema.Type<typeof CodeReviewFindingsQuery>

/** One window's headline numbers. Averages are null when nothing in the window has the input. */
export class CodeReviewTotals extends Schema.Class<CodeReviewTotals>("CodeReviewTotals")({
	pullRequests: Schema.Number,
	reviews: Schema.Number,
	completedReviews: Schema.Number,
	failedReviews: Schema.Number,
	skippedReviews: Schema.Number,
	findings: Schema.Number,
	criticalFindings: Schema.Number,
	resolvedFindings: Schema.Number,
	dismissedFindings: Schema.Number,
	repositoriesWithFindings: Schema.Number,
	mergedPullRequests: Schema.Number,
	/** Queue to posted, over completed reviews. */
	avgReviewSeconds: Schema.NullOr(Schema.Number),
	/** First review to merge, over merged pull requests. */
	avgMergeSeconds: Schema.NullOr(Schema.Number),
	avgConfidence: Schema.NullOr(Schema.Number),
	avgScore: Schema.NullOr(Schema.Number),
	inputTokens: Schema.Number,
	outputTokens: Schema.Number,
}) {}

export class CodeReviewBucket extends Schema.Class<CodeReviewBucket>("CodeReviewBucket")({
	/** Bucket start, epoch ms. */
	bucket: Schema.Number,
	reviews: Schema.Number,
	pullRequests: Schema.Number,
	critical: Schema.Number,
	warn: Schema.Number,
	info: Schema.Number,
}) {}

export class CodeReviewCategoryCount extends Schema.Class<CodeReviewCategoryCount>("CodeReviewCategoryCount")(
	{
		category: PrReviewCategory,
		findings: Schema.Number,
	},
) {}

export class CodeReviewRepositoryCount extends Schema.Class<CodeReviewRepositoryCount>(
	"CodeReviewRepositoryCount",
)({
	repositoryId: VcsRepositoryId,
	fullName: Schema.String,
	reviews: Schema.Number,
	findings: Schema.Number,
}) {}

export class CodeReviewAuthorCount extends Schema.Class<CodeReviewAuthorCount>("CodeReviewAuthorCount")({
	author: Schema.String,
	pullRequests: Schema.Number,
	findings: Schema.Number,
}) {}

export class CodeReviewVerdicts extends Schema.Class<CodeReviewVerdicts>("CodeReviewVerdicts")({
	clean: Schema.Number,
	issues: Schema.Number,
	notApplicable: Schema.Number,
}) {}

export class CodeReviewAnalytics extends Schema.Class<CodeReviewAnalytics>("CodeReviewAnalytics")({
	bucketSeconds: Schema.Number,
	current: CodeReviewTotals,
	/** The window of the same length just before, for the deltas. */
	previous: CodeReviewTotals,
	/** Every bucket of the window, empty ones included. */
	series: Schema.Array(CodeReviewBucket),
	categories: Schema.Array(CodeReviewCategoryCount),
	verdicts: CodeReviewVerdicts,
	repositories: Schema.Array(CodeReviewRepositoryCount),
	authors: Schema.Array(CodeReviewAuthorCount),
}) {}

/** One review in the organization-wide list. */
export class CodeReviewListItem extends Schema.Class<CodeReviewListItem>("CodeReviewListItem")({
	id: PrReviewId,
	repositoryId: VcsRepositoryId,
	repositoryFullName: Schema.String,
	number: Schema.Number,
	title: Schema.NullOr(Schema.String),
	url: Schema.String,
	authorLogin: Schema.NullOr(Schema.String),
	headSha: GitCommitSha,
	status: PrReviewStatus,
	skipReason: Schema.NullOr(PrReviewSkipReason),
	verdict: Schema.NullOr(PrReviewVerdict),
	score: Schema.NullOr(Schema.Number),
	confidence: Schema.NullOr(Schema.Number),
	findings: Schema.Number,
	criticalFindings: Schema.Number,
	commentUrl: Schema.NullOr(Schema.String),
	publishError: Schema.NullOr(Schema.String),
	error: Schema.NullOr(Schema.String),
	model: Schema.NullOr(Schema.String),
	createdAt: Schema.Number,
	finishedAt: Schema.NullOr(Schema.Number),
	mergedAt: Schema.NullOr(Schema.Number),
}) {}

export class CodeReviewListResponse extends Schema.Class<CodeReviewListResponse>("CodeReviewListResponse")({
	reviews: Schema.Array(CodeReviewListItem),
	nextCursor: Schema.NullOr(Schema.String),
}) {}

/** A finding as the lifecycle tracks it: once per pull request, across pushes. */
export class CodeReviewFinding extends Schema.Class<CodeReviewFinding>("CodeReviewFinding")({
	id: Schema.String,
	reviewId: PrReviewId,
	repositoryId: VcsRepositoryId,
	repositoryFullName: Schema.String,
	number: Schema.Number,
	pullRequestTitle: Schema.NullOr(Schema.String),
	pullRequestUrl: Schema.NullOr(Schema.String),
	handle: Schema.String,
	path: Schema.String,
	line: Schema.Number,
	category: PrReviewCategory,
	severity: PrReviewSeverity,
	title: Schema.String,
	status: PrReviewFindingStatus,
	reactionsUp: Schema.Number,
	reactionsDown: Schema.Number,
	createdAt: Schema.Number,
}) {}

export class CodeReviewFindingsResponse extends Schema.Class<CodeReviewFindingsResponse>(
	"CodeReviewFindingsResponse",
)({
	findings: Schema.Array(CodeReviewFinding),
	nextCursor: Schema.NullOr(Schema.String),
}) {}

export class CodeReviewDetail extends Schema.Class<CodeReviewDetail>("CodeReviewDetail")({
	review: CodeReviewListItem,
	report: Schema.NullOr(PrReviewReport),
	checkRunUrl: Schema.NullOr(Schema.String),
	reviewUrl: Schema.NullOr(Schema.String),
	inputTokens: Schema.NullOr(Schema.Number),
	outputTokens: Schema.NullOr(Schema.Number),
	startedAt: Schema.NullOr(Schema.Number),
	/** Every review of the same pull request, newest first, this one included. */
	history: Schema.Array(CodeReviewListItem),
	/** The pull request's tracked findings, across all its reviews. */
	findings: Schema.Array(CodeReviewFinding),
}) {}

export class CodeReviewApiGroup extends HttpApiGroup.make("codeReview")
	.add(
		HttpApiEndpoint.get("analytics", "/analytics", {
			query: CodeReviewAnalyticsQuery,
			success: CodeReviewAnalytics,
			error: PrReviewPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.get("listReviews", "/reviews", {
			query: CodeReviewListQuery,
			success: CodeReviewListResponse,
			error: PrReviewPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.get("getReview", "/reviews/:reviewId", {
			params: { reviewId: PrReviewId },
			success: CodeReviewDetail,
			error: [PrReviewPersistenceError, PrReviewNotFoundError],
		}),
	)
	.add(
		HttpApiEndpoint.get("listFindings", "/findings", {
			query: CodeReviewFindingsQuery,
			success: CodeReviewFindingsResponse,
			error: PrReviewPersistenceError,
		}),
	)
	.prefix("/api/code-review")
	.middleware(Authorization) {}
