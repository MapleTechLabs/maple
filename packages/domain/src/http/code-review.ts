import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { SessionAuthorization } from "./current-tenant"
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
import { PrReviewPostMerge } from "./pr-review-telemetry"
import { GitCommitSha, VcsRepositoryId } from "./vcs"
import { warehouseReadHttpErrors } from "./warehouse"

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
const PageCursor = Schema.String.check(Schema.isPattern(/^\d+_[0-9a-zA-Z-]+$/u))
const AuthorLogin = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))
/** Free text over a list's titles, paths, repositories and authors; `#123` or `123` also matches the number. */
const SearchTerm = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))

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
	q: Schema.optional(SearchTerm),
	limit: Schema.optional(PageLimit),
	cursor: Schema.optional(PageCursor),
})
export type CodeReviewListQuery = Schema.Schema.Type<typeof CodeReviewListQuery>

export const CodeReviewFindingsQuery = Schema.Struct({
	...filterFields,
	severity: Schema.optional(PrReviewSeverity),
	category: Schema.optional(PrReviewCategory),
	status: Schema.optional(PrReviewFindingStatus),
	q: Schema.optional(SearchTerm),
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
	/** How production behaved after the merge shipped; absent until Maple has looked. */
	postMerge: Schema.optionalKey(Schema.NullOr(PrReviewPostMerge)),
}) {}

// ---------------------------------------------------------------------------------------------
// CI: GitHub Actions runs, read from the CI traces the GitHub integration writes.

/** `cicd.pipeline.result` of a run. */
export const CiRunResult = Schema.Literals(["success", "failure", "timeout", "cancellation", "skip", "error"])
export type CiRunResult = typeof CiRunResult.Type

export const CiPipelineName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
export const CiBranchName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))
const PullRequestNumber = Schema.NumberFromString.check(
	Schema.isInt(),
	Schema.isBetween({ minimum: 1, maximum: 1e9 }),
)
/** `<startedAtMs>_<traceId>` of the last run on the previous page. */
// At most 14 digits, so the epoch ms always decodes to a valid date.
const CiRunCursor = Schema.String.check(Schema.isPattern(/^\d{1,14}_[0-9a-f]{32}$/u))

const ciFilterFields = {
	startTime: EpochMs,
	endTime: EpochMs,
	repositoryId: Schema.optional(VcsRepositoryId),
	pipeline: Schema.optional(CiPipelineName),
}

export const CodeReviewCiQuery = Schema.Struct(ciFilterFields)
export type CodeReviewCiQuery = Schema.Schema.Type<typeof CodeReviewCiQuery>

export const CodeReviewCiRunsQuery = Schema.Struct({
	...ciFilterFields,
	branch: Schema.optional(CiBranchName),
	result: Schema.optional(CiRunResult),
	pullRequest: Schema.optional(PullRequestNumber),
	limit: Schema.optional(PageLimit),
	cursor: Schema.optional(CiRunCursor),
})
export type CodeReviewCiRunsQuery = Schema.Schema.Type<typeof CodeReviewCiRunsQuery>

/** One window's run numbers. Skipped runs did nothing and are not counted. */
export class CodeReviewCiTotals extends Schema.Class<CodeReviewCiTotals>("CodeReviewCiTotals")({
	runs: Schema.Number,
	succeeded: Schema.Number,
	failed: Schema.Number,
	cancelled: Schema.Number,
	/** Null when the window has no run. */
	p50DurationMs: Schema.NullOr(Schema.Number),
	p95DurationMs: Schema.NullOr(Schema.Number),
	/** Wall-clock time of every run added up. */
	totalDurationMs: Schema.Number,
	jobs: Schema.Number,
	/** How long jobs waited for a runner; null when no job ran. */
	p50QueueMs: Schema.NullOr(Schema.Number),
	p95QueueMs: Schema.NullOr(Schema.Number),
}) {}

export class CodeReviewCiBucket extends Schema.Class<CodeReviewCiBucket>("CodeReviewCiBucket")({
	/** Bucket start, epoch ms. */
	bucket: Schema.Number,
	succeeded: Schema.Number,
	failed: Schema.Number,
	cancelled: Schema.Number,
	/** Null for a bucket without runs. */
	p50DurationMs: Schema.NullOr(Schema.Number),
	p95DurationMs: Schema.NullOr(Schema.Number),
}) {}

/** A workflow failing since its last green run, newest runs first. */
export class CodeReviewCiRedStreak extends Schema.Class<CodeReviewCiRedStreak>("CodeReviewCiRedStreak")({
	failedRuns: Schema.Number,
	/** The first failed run of the streak, epoch ms. */
	since: Schema.Number,
	firstFailedRevision: Schema.String,
	firstFailedTraceId: Schema.String,
	/** Null when no run in the window passed. */
	lastGreenRevision: Schema.NullOr(Schema.String),
	lastGreenAt: Schema.NullOr(Schema.Number),
}) {}

export class CodeReviewCiPipeline extends Schema.Class<CodeReviewCiPipeline>("CodeReviewCiPipeline")({
	owner: Schema.String,
	repository: Schema.String,
	pipeline: Schema.String,
	runs: Schema.Number,
	failed: Schema.Number,
	cancelled: Schema.Number,
	p50DurationMs: Schema.Number,
	p95DurationMs: Schema.Number,
	totalDurationMs: Schema.Number,
	lastResult: Schema.String,
	lastStartedAt: Schema.Number,
	red: Schema.NullOr(CodeReviewCiRedStreak),
}) {}

export class CodeReviewCiJob extends Schema.Class<CodeReviewCiJob>("CodeReviewCiJob")({
	owner: Schema.String,
	repository: Schema.String,
	pipeline: Schema.String,
	job: Schema.String,
	runs: Schema.Number,
	failed: Schema.Number,
	/** Runs of the job in a rerun of its workflow. */
	retried: Schema.Number,
	/** Queue included: a job's span covers its wait for a runner. */
	p50DurationMs: Schema.Number,
	p95DurationMs: Schema.Number,
	totalDurationMs: Schema.Number,
	p50QueueMs: Schema.Number,
	p95QueueMs: Schema.Number,
}) {}

export class CodeReviewCiAnalytics extends Schema.Class<CodeReviewCiAnalytics>("CodeReviewCiAnalytics")({
	/** The window read, epoch ms: raw CI traces are kept for a limited time, so a longer one is cut. */
	startTime: Schema.Number,
	endTime: Schema.Number,
	bucketSeconds: Schema.Number,
	current: CodeReviewCiTotals,
	/** The window of the same length just before, for the deltas. */
	previous: CodeReviewCiTotals,
	/** Every bucket of the window, empty ones included. */
	series: Schema.Array(CodeReviewCiBucket),
	pipelines: Schema.Array(CodeReviewCiPipeline),
	/** The jobs taking the most CI time. */
	jobs: Schema.Array(CodeReviewCiJob),
}) {}

export class CodeReviewCiFailedJob extends Schema.Class<CodeReviewCiFailedJob>("CodeReviewCiFailedJob")({
	job: Schema.String,
	/** The failure the job's annotations gave; empty when GitHub reported none. */
	reason: Schema.String,
	url: Schema.String,
}) {}

export class CodeReviewCiRun extends Schema.Class<CodeReviewCiRun>("CodeReviewCiRun")({
	traceId: Schema.String,
	pipeline: Schema.String,
	repository: Schema.String,
	branch: Schema.String,
	revision: Schema.String,
	runId: Schema.String,
	attempt: Schema.Number,
	trigger: Schema.String,
	actor: Schema.String,
	pullRequest: Schema.NullOr(Schema.Number),
	result: Schema.String,
	durationMs: Schema.Number,
	startedAt: Schema.Number,
	url: Schema.String,
	failedJobs: Schema.Array(CodeReviewCiFailedJob),
}) {}

export class CodeReviewCiRunsResponse extends Schema.Class<CodeReviewCiRunsResponse>(
	"CodeReviewCiRunsResponse",
)({
	runs: Schema.Array(CodeReviewCiRun),
	nextCursor: Schema.NullOr(Schema.String),
}) {}

// ---------------------------------------------------------------------------------------------
// Team: per person, what the reviews and CI runs say, by GitHub login. Bots are left out.

export const CodeReviewTeamQuery = Schema.Struct({
	startTime: EpochMs,
	endTime: EpochMs,
	repositoryId: Schema.optional(VcsRepositoryId),
})
export type CodeReviewTeamQuery = Schema.Schema.Type<typeof CodeReviewTeamQuery>

/** Counts, not rates: the page divides, so a team median is over the same inputs. */
export class CodeReviewTeamMember extends Schema.Class<CodeReviewTeamMember>("CodeReviewTeamMember")({
	login: Schema.String,
	/** Pull requests first reviewed in the window. */
	pullRequests: Schema.Number,
	mergedPullRequests: Schema.Number,
	/** First review to merge, over merged pull requests; null when none merged. */
	medianMergeSeconds: Schema.NullOr(Schema.Number),
	findings: Schema.Number,
	criticalFindings: Schema.Number,
	/** Fixed in a later push, on merged pull requests: the fix rate is judged at the merge. */
	resolvedFindings: Schema.Number,
	/** Still open when the pull request merged. */
	openAtMergeFindings: Schema.Number,
	/** Merged pull requests the post-merge look judged. */
	shippedClean: Schema.Number,
	shippedRegressed: Schema.Number,
	/** Runs the person started that ran a job; runs that only waited for approval are left out. */
	ciRuns: Schema.Number,
	/** First attempts that passed or failed: the base of the first-try green rate. */
	firstTryRuns: Schema.Number,
	firstTryGreen: Schema.Number,
	reruns: Schema.Number,
	/** Cancelled runs, mostly a newer push taking over. */
	cancelledRuns: Schema.Number,
	/** Time jobs spent on a runner, queue left out. */
	runnerMs: Schema.Number,
}) {}

export class CodeReviewTeamTotals extends Schema.Class<CodeReviewTeamTotals>("CodeReviewTeamTotals")({
	pullRequests: Schema.Number,
	mergedPullRequests: Schema.Number,
	medianMergeSeconds: Schema.NullOr(Schema.Number),
	/** Queued to posted, the first review of each pull request. */
	medianFirstReviewSeconds: Schema.NullOr(Schema.Number),
	/** Pushes to a repository's default branch that passed or failed. */
	defaultBranchRuns: Schema.Number,
	defaultBranchFailed: Schema.Number,
	/** Every run's runner time, bots included. */
	runnerMs: Schema.Number,
	p95QueueMs: Schema.NullOr(Schema.Number),
}) {}

export class CodeReviewTeam extends Schema.Class<CodeReviewTeam>("CodeReviewTeam")({
	/** The window read, epoch ms; a longer one is cut to what CI runs keep. */
	startTime: Schema.Number,
	endTime: Schema.Number,
	totals: CodeReviewTeamTotals,
	/** By login. */
	members: Schema.Array(CodeReviewTeamMember),
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
	.add(
		HttpApiEndpoint.get("ciAnalytics", "/ci/analytics", {
			query: CodeReviewCiQuery,
			success: CodeReviewCiAnalytics,
			error: [PrReviewPersistenceError, ...warehouseReadHttpErrors],
		}),
	)
	.add(
		HttpApiEndpoint.get("ciRuns", "/ci/runs", {
			query: CodeReviewCiRunsQuery,
			success: CodeReviewCiRunsResponse,
			error: [PrReviewPersistenceError, ...warehouseReadHttpErrors],
		}),
	)
	.add(
		HttpApiEndpoint.get("team", "/team", {
			query: CodeReviewTeamQuery,
			success: CodeReviewTeam,
			error: [PrReviewPersistenceError, ...warehouseReadHttpErrors],
		}),
	)
	.prefix("/internal/code-review")
	.middleware(SessionAuthorization) {}
