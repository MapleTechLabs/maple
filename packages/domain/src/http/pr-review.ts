import { Array as Arr, Schema, String as Str } from "effect"
import { OrgId } from "../primitives"
import { HttpTaggedError } from "./error-policy"
import { PrReviewPostMerge, PrReviewPostMergeStatus, PrReviewTelemetry } from "./pr-review-telemetry"
import { GitCommitSha, VcsRepositoryId } from "./vcs"

/**
 * A code review of one pull request at one head commit; observability is one of its lenses.
 *
 * The reviewer is one turn of the `pr-review` agent on a chat session named after the review, so
 * the id doubles as the session's tab suffix (`<orgId>:pr-<id>`). A later push to the same pull
 * request is a new review: the check run GitHub shows is per head SHA, and so is the row here.
 */
export const PrReviewId = Schema.String.check(Schema.isUUID()).pipe(
	Schema.brand("@maple/PrReviewId"),
	Schema.annotate({ identifier: "@maple/PrReviewId", title: "Pull Request Review ID" }),
)
export type PrReviewId = Schema.Schema.Type<typeof PrReviewId>

export const PrReviewStatus = Schema.Literals([
	"queued",
	"running",
	"completed",
	"failed",
	"skipped",
]).annotate({
	identifier: "@maple/PrReviewStatus",
	title: "Pull Request Review Status",
})
export type PrReviewStatus = Schema.Schema.Type<typeof PrReviewStatus>

/**
 * Why a delivery produced no review. Reported on the trigger's span and outcome; only `superseded`
 * is stored, since the other skips happen before a row exists.
 */
export const PrReviewSkipReason = Schema.Literals([
	"disabled",
	"draft",
	"bot_author",
	"action",
	"no_head_sha",
	"quota",
	"duplicate",
	"superseded",
	"agent_unavailable",
	/** A push to a pull request that already had its repository's `automaticReviewLimit` reviews. */
	"automatic_limit",
	/** An automatic review of a pull request whose author is not an owner, member or collaborator. */
	"external_author",
]).annotate({ identifier: "@maple/PrReviewSkipReason", title: "Pull Request Review Skip Reason" })
export type PrReviewSkipReason = Schema.Schema.Type<typeof PrReviewSkipReason>

/**
 * Why a review ended without a report, stored as the prefix of the row's `error`
 * (`time_limit: ...`) and shown on the pull request in fixed words, never the raw cause.
 */
export const PrReviewFailureReason = Schema.Literals([
	"agent_unavailable",
	"start_failed",
	"time_limit",
	"step_limit",
	"context_limit",
	"stuck",
	"model_error",
	"provider_unavailable",
	"service_misconfigured",
	"org_key_rejected",
	"org_key_no_credits",
	"ai_credits_exhausted",
	"agent_error",
	"no_report",
	"ended_early",
	"answered_in_prose",
	"interrupted",
]).annotate({ identifier: "@maple/PrReviewFailureReason", title: "Pull Request Review Failure Reason" })
export type PrReviewFailureReason = Schema.Schema.Type<typeof PrReviewFailureReason>

/** What the pull request is told for each reason: one sentence, safe to show anyone who can read it. */
export const PR_REVIEW_FAILURE_COPY = {
	agent_unavailable: "The review agent is not available on this deployment.",
	start_failed: "The review agent could not start.",
	time_limit: "It ran out of time before it filed a report.",
	step_limit: "It used up its tool-call or token allowance before it filed a report.",
	context_limit: "The change did not fit in the model's context.",
	stuck: "Its tool calls kept failing, so it was stopped.",
	model_error: "The model provider returned an error.",
	provider_unavailable: "The model provider was unavailable or rate limited.",
	service_misconfigured:
		"Maple could not use its model provider because of a problem on Maple's side, not with this pull request.",
	org_key_rejected:
		"OpenRouter rejected this organization's OpenRouter key. An admin can replace it in Maple's organization settings.",
	org_key_no_credits:
		"This organization's OpenRouter key has run out of credits. An admin can add credits on OpenRouter.",
	ai_credits_exhausted:
		"This organization is out of AI credits or has reached its AI spending cap. An admin can review it under Settings > Billing.",
	agent_error: "The review run failed with an error.",
	no_report: "It ended without filing a report.",
	ended_early: "It stopped before it finished, so its partial findings are not posted here.",
	answered_in_prose:
		"The model kept replying in prose instead of filing its report, so its partial findings are not posted here.",
	interrupted: "Maple was restarted while it ran, more than once. Ask again with @maple review.",
} as const satisfies Record<PrReviewFailureReason, string>

/** Reasons a retry cannot clear until someone fixes a key or Maple's config, so "try again" would mislead. */
export const PR_REVIEW_FAILURE_NEEDS_FIX: ReadonlySet<PrReviewFailureReason> = new Set([
	"agent_unavailable",
	"service_misconfigured",
	"org_key_rejected",
	"org_key_no_credits",
	"ai_credits_exhausted",
])

const isFailureReason = Schema.is(PrReviewFailureReason)

/** The reason a stored `error` names, or `undefined` for one written before reasons existed. */
export const prReviewFailureReason = (
	error: string | null | undefined,
): PrReviewFailureReason | undefined => {
	const code = error == null ? undefined : Str.trim(Str.split(":")(error)[0])
	return isFailureReason(code) ? code : undefined
}

export const PrReviewVerdict = Schema.Literals(["clean", "issues", "not_applicable"]).annotate({
	identifier: "@maple/PrReviewVerdict",
	title: "Pull Request Review Verdict",
})
export type PrReviewVerdict = Schema.Schema.Type<typeof PrReviewVerdict>

/** The audit skill's three severities, so a finding and a `maple-audit` check speak the same word. */
export const PrReviewSeverity = Schema.Literals(["critical", "warn", "info"]).annotate({
	identifier: "@maple/PrReviewSeverity",
	title: "Pull Request Review Severity",
})
export type PrReviewSeverity = Schema.Schema.Type<typeof PrReviewSeverity>

export const PrReviewCategory = Schema.Literals([
	"correctness",
	"security",
	"performance",
	"observability",
	"convention",
	"tests",
	"maintainability",
]).annotate({
	identifier: "@maple/PrReviewCategory",
	title: "Pull Request Review Category",
})
export type PrReviewCategory = Schema.Schema.Type<typeof PrReviewCategory>

/** Whether tests exercise the behavior the change adds or alters. */
export const PrReviewTestSignal = Schema.Literals(["covered", "partial", "missing", "not_needed"]).annotate({
	identifier: "@maple/PrReviewTestSignal",
	title: "Pull Request Review Test Signal",
})
export type PrReviewTestSignal = Schema.Schema.Type<typeof PrReviewTestSignal>

/** The blast radius of what the change touches: auth, tenancy, migrations, billing and concurrency are high. */
export const PrReviewRisk = Schema.Literals(["low", "medium", "high"]).annotate({
	identifier: "@maple/PrReviewRisk",
	title: "Pull Request Review Risk",
})
export type PrReviewRisk = Schema.Schema.Type<typeof PrReviewRisk>

/**
 * One issue, anchored to a line of the pull request's diff.
 *
 * `line` is on the new side of the diff, because that is the only line GitHub will accept for an
 * inline comment or a check annotation. `checkId` is a `maple-audit` id (`SPAN-03`, `MAP-01`) and
 * only an observability finding carries one. `suggestion` is a prose sketch; `replacement` is the
 * exact code for `line`..`endLine`, posted as a GitHub suggestion the author applies in one click.
 */
export class PrReviewFinding extends Schema.Class<PrReviewFinding>("PrReviewFinding")({
	path: Schema.String,
	line: Schema.Number,
	endLine: Schema.optionalKey(Schema.Number),
	category: PrReviewCategory,
	checkId: Schema.optionalKey(Schema.String),
	severity: PrReviewSeverity,
	title: Schema.String,
	body: Schema.String,
	suggestion: Schema.optionalKey(Schema.String),
	replacement: Schema.optionalKey(Schema.String),
	/** The pull request-wide handle (`F3`) it is tracked by across pushes; set when stored. */
	handle: Schema.optionalKey(Schema.String),
}) {}

/**
 * One unit of work the pull request adds, and whether it is observable.
 *
 * The coverage table is the part of the review a reader trusts when there are no findings: it
 * says what the reviewer looked at, not only what it objected to.
 */
export class PrReviewCoverageUnit extends Schema.Class<PrReviewCoverageUnit>("PrReviewCoverageUnit")({
	unit: Schema.String,
	kind: Schema.String,
	instrumented: Schema.Boolean,
	evidence: Schema.String,
}) {}

/**
 * A finding's life across pushes. `resolved` is a later head that fixed it, confirmed by a review;
 * `dismissed` is a person resolving its thread or answering it "won't fix", which the reviewer
 * must respect rather than raise again.
 */
export const PrReviewFindingStatus = Schema.Literals(["open", "resolved", "dismissed"]).annotate({
	identifier: "@maple/PrReviewFindingStatus",
	title: "Pull Request Review Finding Status",
})
export type PrReviewFindingStatus = Schema.Schema.Type<typeof PrReviewFindingStatus>

export const PrReviewFeedbackScope = Schema.Literals(["organization", "repository", "off"]).annotate({
	identifier: "@maple/PrReviewFeedbackScope",
	title: "Pull Request Review Feedback Scope",
})
export type PrReviewFeedbackScope = Schema.Schema.Type<typeof PrReviewFeedbackScope>

/**
 * The models an organization may pick for its reviews and replies, as OpenRouter ids. `eu` marks
 * a model the EU instance serves; there, a pick without it reviews on the region's default.
 */
export const PR_REVIEW_MODELS = [
	{ id: "deepseek/deepseek-v4.1-flash-1017:nitro", label: "DeepSeek V4.1 Flash", eu: false },
	{ id: "z-ai/glm-5.3-flash:nitro", label: "GLM 5.3 Flash", eu: false },
	{ id: "xiaomi/mimo-v2.6-pro", label: "MiMo V2.6 Pro", eu: false },
	{ id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna", eu: false },
	{ id: "openai/gpt-6-luna", label: "GPT-6 Luna", eu: true },
	{ id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", eu: true },
	{ id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", eu: true },
	{ id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", eu: true },
] as const

export const PrReviewModel = Schema.Literals(Arr.map(PR_REVIEW_MODELS, (model) => model.id)).annotate({
	identifier: "@maple/PrReviewModel",
	title: "Pull Request Review Model",
})
export type PrReviewModel = Schema.Schema.Type<typeof PrReviewModel>

/**
 * Per-repository review settings. Every field is optional so a repository with none set reviews
 * with the defaults: every lens, no ignored paths, drafts skipped, notes posted.
 */
export class PrReviewRepositoryConfig extends Schema.Class<PrReviewRepositoryConfig>(
	"PrReviewRepositoryConfig",
)({
	/** Extra review rules, read like the repository's own `.maple/review.md`. */
	instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
	/** Glob-like path prefixes or `*.ext` suffixes the review never reads. */
	ignorePaths: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMaxLength(200)))),
	/** Lenses the review files findings for; absent means all of them. */
	categories: Schema.optionalKey(Schema.Array(PrReviewCategory)),
	/** The lowest severity posted inline; the summary always carries every finding. */
	minInlineSeverity: Schema.optionalKey(PrReviewSeverity),
	reviewDrafts: Schema.optionalKey(Schema.Boolean),
	/**
	 * Review pull requests on a public repository from people without push access, forks included.
	 * Off by default: their text reaches an agent that reads org telemetry and posts publicly. One
	 * automatic review per pull request and three per author a day; a maintainer starts more.
	 */
	reviewExternalContributors: Schema.optionalKey(Schema.Boolean),
	/** Reviews this repository may start per UTC day. */
	dailyLimit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
	/**
	 * Reviews one pull request may get from pushes; later pushes wait for `@maple review`. Every
	 * review of the pull request counts, requested ones included. Absent means no limit.
	 */
	automaticReviewLimit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
	/**
	 * Whose votes decide which findings are suppressed before posting: every repository of the
	 * organization (the default), this repository only, or nobody (`off`).
	 */
	feedbackScope: Schema.optionalKey(PrReviewFeedbackScope),
	/**
	 * Fail the check run when the pull request removes a name an alert or dashboard reads and the
	 * review could not show it is still emitted. Off by default: the review informs.
	 */
	blockOnContractBreaks: Schema.optionalKey(Schema.Boolean),
	/** Look at production after the merged pull request ships and say how it went. On by default. */
	postMergeCheck: Schema.optionalKey(Schema.Boolean),
}) {}

/** Organization-wide review settings; absent fields use the deployment's defaults. */
export class PrReviewOrgSettings extends Schema.Class<PrReviewOrgSettings>("PrReviewOrgSettings")({
	model: Schema.optionalKey(PrReviewModel),
	/** Rules every repository starts from; a repository's own config overrides field by field. */
	defaults: Schema.optionalKey(PrReviewRepositoryConfig),
}) {}

/** What a step before merge is about; the comment groups and labels by it. */
export const PrReviewMergeStepKind = Schema.Literals([
	"secret",
	"env",
	"migration",
	"warehouse",
	"infra",
	"manual",
]).annotate({ identifier: "PrReviewMergeStepKind" })
export type PrReviewMergeStepKind = Schema.Schema.Type<typeof PrReviewMergeStepKind>

/**
 * Something a person has to do outside the diff before the change can ship: a secret to add, a
 * migration to check, a schema to deploy. `diff` steps are read off the diff by the service;
 * `reviewer` steps are ones the agent named from what it read.
 */
export class PrReviewMergeStep extends Schema.Class<PrReviewMergeStep>("PrReviewMergeStep")({
	kind: PrReviewMergeStepKind,
	title: Schema.String,
	/** The secret, variable or file the step is about; what a reviewer step must name to replace it. */
	subject: Schema.optionalKey(Schema.String),
	path: Schema.optionalKey(Schema.String),
	line: Schema.optionalKey(Schema.Number),
	source: Schema.Literals(["diff", "reviewer"]),
	/** Its identity across pushes ({@link mergeStepKey}), set once the step is tracked. */
	key: Schema.optionalKey(Schema.String),
	/** Ticked on the pull request, on this review's comment or an earlier one. */
	done: Schema.optionalKey(Schema.Boolean),
	/** Who ticked it. */
	doneBy: Schema.optionalKey(Schema.String),
}) {}

export const PrReviewMergeStepStatus = Schema.Literals(["open", "done", "obsolete"]).annotate({
	identifier: "PrReviewMergeStepStatus",
})
export type PrReviewMergeStepStatus = Schema.Schema.Type<typeof PrReviewMergeStepStatus>

/** The stored review: the shape a reader can rely on. */
export class PrReviewReport extends Schema.Class<PrReviewReport>("PrReviewReport")({
	verdict: PrReviewVerdict,
	summary: Schema.String,
	/** What the change does, one bullet per change; absent on reports stored before it existed. */
	keyChanges: Schema.optionalKey(Schema.Array(Schema.String)),
	/** The risks the reviewer examined and ruled out: what a clean review stands on. */
	checked: Schema.optionalKey(Schema.Array(Schema.String)),
	/** Whether tests cover the change; one input to the confidence. */
	tests: Schema.optionalKey(PrReviewTestSignal),
	/** How much the touched code can break; one input to the confidence. */
	risk: Schema.optionalKey(PrReviewRisk),
	/**
	 * How safe the change is to merge, 1 to 10, computed from the findings, tests, risk and
	 * observability coverage. Stored computed; see {@link confidencePrReview}.
	 */
	confidence: Schema.optionalKey(Schema.Number),
	/** One sentence on what drives the confidence. */
	confidenceReason: Schema.optionalKey(Schema.String),
	coverage: Schema.Array(PrReviewCoverageUnit),
	findings: Schema.Array(PrReviewFinding),
	/** Reviewed files whose diff the pass never read; set by the runner, never by the model. */
	unreviewed: Schema.optionalKey(Schema.Array(Schema.String)),
	/** The pass read every file of the diff, not only what changed since the last review; set by the runner. */
	wholeDiff: Schema.optionalKey(Schema.Boolean),
	/** What production telemetry says about the change; set by the service, never by the model. */
	telemetry: Schema.optionalKey(PrReviewTelemetry),
	/** What has to happen outside the diff before merge; diff steps are set by the service. */
	beforeMerge: Schema.optionalKey(Schema.Array(PrReviewMergeStep)),
}) {}

/** Models quote numbers and booleans (`"12"`, `"true"`) and send `null` for a field they skip; a strict decode here ends the run. */
const LenientNumber = Schema.Union([Schema.Number, Schema.String])
const LenientBoolean = Schema.Union([Schema.Boolean, Schema.String])
/** A list sent as its JSON text: the kept string is parsed by the normalizer, not rejected here. */
const LenientArray = <S extends Schema.Top>(item: S) => Schema.Union([Schema.Array(item), Schema.String])

export const PrReviewFindingSubmission = Schema.Struct({
	path: Schema.optionalKey(Schema.NullOr(Schema.String)),
	line: Schema.optionalKey(Schema.NullOr(LenientNumber)),
	endLine: Schema.optionalKey(Schema.NullOr(LenientNumber)),
	category: Schema.optionalKey(Schema.NullOr(Schema.Union([PrReviewCategory, Schema.String]))),
	checkId: Schema.optionalKey(Schema.NullOr(Schema.String)),
	severity: Schema.optionalKey(Schema.NullOr(Schema.Union([PrReviewSeverity, Schema.String]))),
	title: Schema.optionalKey(Schema.NullOr(Schema.String)),
	body: Schema.optionalKey(Schema.NullOr(Schema.String)),
	suggestion: Schema.optionalKey(Schema.NullOr(Schema.String)),
	replacement: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type PrReviewFindingSubmission = Schema.Schema.Type<typeof PrReviewFindingSubmission>

export const PrReviewCoverageSubmission = Schema.Struct({
	unit: Schema.optionalKey(Schema.NullOr(Schema.String)),
	kind: Schema.optionalKey(Schema.NullOr(Schema.String)),
	instrumented: Schema.optionalKey(Schema.NullOr(LenientBoolean)),
	evidence: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

/** The reviewer's evidence that a removed name is still emitted at the head: where it still is. */
export const PrReviewTelemetryDismissalSubmission = Schema.Struct({
	name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	path: Schema.optionalKey(Schema.NullOr(Schema.String)),
	line: Schema.optionalKey(Schema.NullOr(LenientNumber)),
})

/** A child reviewer's finding the parent checked and found does not hold, and why. */
export const PrReviewChildDismissalSubmission = Schema.Struct({
	path: Schema.optionalKey(Schema.NullOr(Schema.String)),
	line: Schema.optionalKey(Schema.NullOr(LenientNumber)),
	reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

/**
 * What `submit_review` accepts off the wire. Every field is optional: the engine decodes a tool call
 * before the handler runs, and a decode failure would throw away a nearly finished review.
 */
export const PrReviewSubmission = Schema.Struct({
	/** Handles of earlier open findings this head fixes, as the kickoff listed them. */
	resolved: Schema.optionalKey(Schema.NullOr(LenientArray(Schema.String))),
	verdict: Schema.optionalKey(Schema.NullOr(Schema.Union([PrReviewVerdict, Schema.String]))),
	summary: Schema.optionalKey(Schema.NullOr(Schema.String)),
	keyChanges: Schema.optionalKey(Schema.NullOr(LenientArray(Schema.String))),
	beforeMerge: Schema.optionalKey(Schema.NullOr(LenientArray(Schema.String))),
	checked: Schema.optionalKey(Schema.NullOr(LenientArray(Schema.String))),
	tests: Schema.optionalKey(Schema.NullOr(Schema.Union([PrReviewTestSignal, Schema.String]))),
	risk: Schema.optionalKey(Schema.NullOr(Schema.Union([PrReviewRisk, Schema.String]))),
	confidence: Schema.optionalKey(Schema.NullOr(LenientNumber)),
	confidenceReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
	coverage: Schema.optionalKey(Schema.NullOr(LenientArray(PrReviewCoverageSubmission))),
	findings: Schema.optionalKey(Schema.NullOr(LenientArray(PrReviewFindingSubmission))),
	telemetryDismissals: Schema.optionalKey(
		Schema.NullOr(LenientArray(PrReviewTelemetryDismissalSubmission)),
	),
	childDismissals: Schema.optionalKey(Schema.NullOr(LenientArray(PrReviewChildDismissalSubmission))),
})
export type PrReviewSubmission = Schema.Schema.Type<typeof PrReviewSubmission>

/** What the `submit_review` handler hands the service once it has normalized the submission. */
export class SubmitPrReviewRequest extends Schema.Class<SubmitPrReviewRequest>("SubmitPrReviewRequest")({
	report: PrReviewReport,
	model: Schema.optionalKey(Schema.String),
	inputTokens: Schema.optionalKey(Schema.Number),
	outputTokens: Schema.optionalKey(Schema.Number),
	/** Filed by the close-out turn after the pass ended without a report; posted as a partial. */
	partial: Schema.optionalKey(Schema.Boolean),
	/** Why the pass that preceded a partial stopped; the pull request is told this, not `ended_early`. */
	partialReason: Schema.optionalKey(PrReviewFailureReason),
	/** Handles of earlier findings this head fixes. */
	resolved: Schema.optionalKey(Schema.Array(Schema.String)),
	/** Where the reviewer says each removed telemetry name is still emitted; verified before use. */
	telemetryDismissals: Schema.optionalKey(
		Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String, line: Schema.Number })),
	),
}) {}

/** A review row as the dashboard reads it. */
export class PrReview extends Schema.Class<PrReview>("PrReview")({
	id: PrReviewId,
	orgId: OrgId,
	repositoryId: VcsRepositoryId,
	number: Schema.Number,
	headSha: GitCommitSha,
	baseSha: Schema.NullOr(GitCommitSha),
	url: Schema.String,
	title: Schema.NullOr(Schema.String),
	status: PrReviewStatus,
	skipReason: Schema.NullOr(PrReviewSkipReason),
	sessionId: Schema.NullOr(Schema.String),
	report: Schema.NullOr(PrReviewReport),
	/** Out of 100; null until a report is stored. See {@link scorePrReview}. */
	score: Schema.NullOr(Schema.Number),
	checkRunUrl: Schema.NullOr(Schema.String),
	/** The sticky summary comment on the pull request, edited in place on every later review. */
	commentUrl: Schema.NullOr(Schema.String),
	reviewUrl: Schema.NullOr(Schema.String),
	publishError: Schema.NullOr(Schema.String),
	error: Schema.NullOr(Schema.String),
	model: Schema.NullOr(Schema.String),
	inputTokens: Schema.NullOr(Schema.Number),
	outputTokens: Schema.NullOr(Schema.Number),
	startedAt: Schema.NullOr(Schema.Number),
	finishedAt: Schema.NullOr(Schema.Number),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
	/** Production after the pull request shipped; absent until a merge schedules the look. */
	postMergeStatus: Schema.optionalKey(Schema.NullOr(PrReviewPostMergeStatus)),
	postMerge: Schema.optionalKey(Schema.NullOr(PrReviewPostMerge)),
}) {}

/** One answer to a pull request comment that mentioned Maple; the id is its session's tab suffix. */
export const PrReviewReplyId = Schema.String.check(Schema.isUUID()).pipe(
	Schema.brand("@maple/PrReviewReplyId"),
	Schema.annotate({ identifier: "@maple/PrReviewReplyId", title: "Pull Request Reply ID" }),
)
export type PrReviewReplyId = Schema.Schema.Type<typeof PrReviewReplyId>

/**
 * What a mention asks for. `review` re-reviews the head now, `fix` lets the reply commit the edits
 * it stages to the pull request's branch, `ask` is everything else: a question answered in prose.
 */
export const PrReviewReplyCommand = Schema.Literals(["ask", "review", "fix"]).annotate({
	identifier: "@maple/PrReviewReplyCommand",
	title: "Pull Request Reply Command",
})
export type PrReviewReplyCommand = Schema.Schema.Type<typeof PrReviewReplyCommand>

export const PrReviewReplyStatus = Schema.Literals(["queued", "running", "completed", "failed", "skipped"])
export type PrReviewReplyStatus = Schema.Schema.Type<typeof PrReviewReplyStatus>

/** What `submit_reply` accepts: the answer, in GitHub markdown. Lenient like `submit_review`. */
export const PrReviewReplySubmission = Schema.Struct({
	body: Schema.optionalKey(Schema.String),
})
export type PrReviewReplySubmission = Schema.Schema.Type<typeof PrReviewReplySubmission>

/**
 * One exact edit `propose_edit` stages: `oldText` must occur exactly once in `path` at the pull
 * request's head, and becomes `newText`. An empty `oldText` creates the file.
 */
export const PrReviewEditSubmission = Schema.Struct({
	path: Schema.String,
	oldText: Schema.String,
	newText: Schema.String,
})
export type PrReviewEditSubmission = Schema.Schema.Type<typeof PrReviewEditSubmission>

export class PrReviewPersistenceError extends HttpTaggedError<PrReviewPersistenceError>()(
	"@maple/http/pr-review/PrReviewPersistenceError",
	{ message: Schema.String },
	{
		status: 503,
		code: "pr_reviews_unavailable",
		title: "Pull request reviews are temporarily unavailable",
		message: "Pull request reviews are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class PrReviewReplyNotFoundError extends HttpTaggedError<PrReviewReplyNotFoundError>()(
	"@maple/http/pr-review/PrReviewReplyNotFoundError",
	{ message: Schema.String, replyId: PrReviewReplyId },
	{
		status: 404,
		code: "pr_review_reply_not_found",
		title: "Pull request reply not found",
		message: "No pull request reply exists with that id.",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class PrReviewNotFoundError extends HttpTaggedError<PrReviewNotFoundError>()(
	"@maple/http/pr-review/PrReviewNotFoundError",
	{ message: Schema.String, reviewId: PrReviewId },
	{
		status: 404,
		code: "pr_review_not_found",
		title: "Pull request review not found",
		message: "No pull request review exists with that id.",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}
