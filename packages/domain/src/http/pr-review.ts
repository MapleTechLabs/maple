import { Schema } from "effect"
import { OrgId } from "../primitives"
import { HttpTaggedError } from "./error-policy"
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
 * is stored, since the other skips happen before a row exists. `not_rolled_out` is an organization
 * without the `prreview` rollout flag.
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
	"not_rolled_out",
]).annotate({ identifier: "@maple/PrReviewSkipReason", title: "Pull Request Review Skip Reason" })
export type PrReviewSkipReason = Schema.Schema.Type<typeof PrReviewSkipReason>

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
	/** Reviews this repository may start per UTC day; the organization's ceiling still applies. */
	dailyLimit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
}) {}

/** The stored review: the shape a reader can rely on. */
export class PrReviewReport extends Schema.Class<PrReviewReport>("PrReviewReport")({
	verdict: PrReviewVerdict,
	summary: Schema.String,
	coverage: Schema.Array(PrReviewCoverageUnit),
	findings: Schema.Array(PrReviewFinding),
}) {}

/**
 * What `submit_review` accepts off the wire.
 *
 * Every field is optional, for the reason `AiTriageSubmission` is: the engine decodes a tool call's
 * arguments before the handler runs, and a decode failure ends the run. A review that read every
 * hunk and wrote most of a report must not be thrown away over one absent key. The handler
 * normalizes and records what it dropped.
 */
/** Models quote numbers and booleans (`"12"`, `"true"`); a strict decode here ends the run. */
const LenientNumber = Schema.Union([Schema.Number, Schema.String])
const LenientBoolean = Schema.Union([Schema.Boolean, Schema.String])

export const PrReviewFindingSubmission = Schema.Struct({
	path: Schema.optionalKey(Schema.String),
	line: Schema.optionalKey(LenientNumber),
	endLine: Schema.optionalKey(LenientNumber),
	category: Schema.optionalKey(Schema.Union([PrReviewCategory, Schema.String])),
	checkId: Schema.optionalKey(Schema.String),
	severity: Schema.optionalKey(Schema.Union([PrReviewSeverity, Schema.String])),
	title: Schema.optionalKey(Schema.String),
	body: Schema.optionalKey(Schema.String),
	suggestion: Schema.optionalKey(Schema.String),
	replacement: Schema.optionalKey(Schema.String),
})
export type PrReviewFindingSubmission = Schema.Schema.Type<typeof PrReviewFindingSubmission>

export const PrReviewCoverageSubmission = Schema.Struct({
	unit: Schema.optionalKey(Schema.String),
	kind: Schema.optionalKey(Schema.String),
	instrumented: Schema.optionalKey(LenientBoolean),
	evidence: Schema.optionalKey(Schema.String),
})

export const PrReviewSubmission = Schema.Struct({
	/** Handles of earlier open findings this head fixes, as the kickoff listed them. */
	resolved: Schema.optionalKey(Schema.Array(Schema.String)),
	verdict: Schema.optionalKey(Schema.Union([PrReviewVerdict, Schema.String])),
	summary: Schema.optionalKey(Schema.String),
	coverage: Schema.optionalKey(Schema.Array(PrReviewCoverageSubmission)),
	findings: Schema.optionalKey(Schema.Array(PrReviewFindingSubmission)),
})
export type PrReviewSubmission = Schema.Schema.Type<typeof PrReviewSubmission>

const isVerdict = Schema.is(PrReviewVerdict)
const isSeverity = Schema.is(PrReviewSeverity)
const isCategory = Schema.is(PrReviewCategory)

/** A finding the review can post: it names a file and a line, and says what is wrong. */
const MAX_FINDINGS = 50
const MAX_COVERAGE = 50
const MAX_TEXT = 4_000

/** The `maple-audit` check id grammar: a family and a number, or the REN-DUAL-style suffixes. */
const AUDIT_CHECK_ID = /^(RES|STAT|SPAN|MAP|REN|LOG|MET|NAME|PII|LLM)-(\d{1,2}|[A-Z]+)$/

const toNumber = (value: number | string | undefined): number | undefined => {
	const n = typeof value === "string" ? Number(value.trim()) : value
	return n === undefined || !Number.isFinite(n) ? undefined : n
}

const toBoolean = (value: boolean | string | undefined): boolean =>
	typeof value === "string" ? value.trim().toLowerCase() === "true" : value === true

const clip = (value: string, max = MAX_TEXT) => (value.length > max ? `${value.slice(0, max)}…` : value)

export interface NormalizedPrReviewSubmission {
	readonly report: PrReviewReport
	/** Top-level keys the model supplied, for the span. */
	readonly filled: ReadonlyArray<string>
	/** Findings dropped for no anchor line, or an observability finding with no audit check id. */
	readonly droppedFindings: number
	/** Handles of earlier findings the model says this head fixes, upper-cased and deduplicated. */
	readonly resolved: ReadonlyArray<string>
}

/**
 * A submission as a stored report.
 *
 * A finding without a path or a positive line is dropped rather than invented, and so is an
 * observability finding without a check id from the audit; the count is what the span records.
 * An unknown category reads as observability when the finding carries an audit id, correctness
 * otherwise. The verdict is `issues` exactly when a warn or critical finding is retained;
 * otherwise the model's `not_applicable` survives and anything else reads as `clean`.
 */
export const normalizePrReviewSubmission = (submission: PrReviewSubmission): NormalizedPrReviewSubmission => {
	const filled = Object.entries(submission)
		.filter(([, value]) => value !== undefined)
		.map(([key]) => key)
	const rawFindings = submission.findings ?? []
	const findings: Array<PrReviewFinding> = []
	for (const raw of rawFindings) {
		const path = raw.path?.trim()
		const line = toNumber(raw.line)
		const rawEndLine = toNumber(raw.endLine)
		if (!path || line === undefined || line < 1) continue
		// An id the audit does not have would be posted onto the pull request as if it did.
		const rawCheckId = raw.checkId?.trim().toUpperCase()
		const checkId = rawCheckId !== undefined && AUDIT_CHECK_ID.test(rawCheckId) ? rawCheckId : undefined
		const category = isCategory(raw.category)
			? raw.category
			: checkId === undefined
				? "correctness"
				: "observability"
		if (category === "observability" && checkId === undefined) continue
		const startLine = Math.floor(line)
		const endLine =
			rawEndLine !== undefined && Math.floor(rawEndLine) > startLine
				? Math.floor(rawEndLine)
				: undefined
		findings.push(
			new PrReviewFinding({
				path,
				line: startLine,
				...(endLine === undefined ? undefined : { endLine }),
				category,
				...(category === "observability" && checkId !== undefined ? { checkId } : undefined),
				severity: isSeverity(raw.severity) ? raw.severity : "warn",
				title: clip(raw.title?.trim() || "Review finding", 200),
				body: clip(raw.body?.trim() || ""),
				...(raw.suggestion?.trim() ? { suggestion: clip(raw.suggestion.trim()) } : undefined),
				// Indentation is part of the code a suggestion commits, so only trailing newlines go.
				...(raw.replacement !== undefined && raw.replacement.length <= MAX_TEXT
					? { replacement: raw.replacement.replace(/\n+$/, "") }
					: undefined),
			}),
		)
		if (findings.length >= MAX_FINDINGS) break
	}
	const coverage: Array<PrReviewCoverageUnit> = []
	for (const raw of submission.coverage ?? []) {
		const unit = raw.unit?.trim()
		if (!unit) continue
		coverage.push(
			new PrReviewCoverageUnit({
				unit: clip(unit, 200),
				kind: clip(raw.kind?.trim() || "other", 60),
				instrumented: toBoolean(raw.instrumented),
				evidence: clip(raw.evidence?.trim() || ""),
			}),
		)
		if (coverage.length >= MAX_COVERAGE) break
	}
	// A retained warn or critical finding is an issue whatever the model called the verdict; the
	// check run's conclusion and its inline comments must never disagree. The reverse holds too.
	const hasIssues = findings.some((finding) => finding.severity !== "info")
	const submittedVerdict = isVerdict(submission.verdict) ? submission.verdict : undefined
	const verdict: PrReviewVerdict = hasIssues
		? "issues"
		: submittedVerdict === undefined || submittedVerdict === "issues"
			? "clean"
			: submittedVerdict
	return {
		report: new PrReviewReport({
			verdict,
			summary: clip(submission.summary?.trim() || ""),
			coverage,
			findings,
		}),
		filled,
		droppedFindings: rawFindings.length - findings.length,
		resolved: [
			...new Set(
				(submission.resolved ?? [])
					.map((handle) => handle.trim().toUpperCase())
					.filter((handle) => /^F\d{1,4}$/.test(handle)),
			),
		].slice(0, MAX_FINDINGS),
	}
}

/** What each finding costs the score, by severity. Stated in the PR comment's footer. */
export const PR_REVIEW_SCORE_PENALTY = { critical: 25, warn: 10, info: 2 } as const

export type PrReviewGrade = "excellent" | "good" | "needs work" | "poor"

/**
 * The review's score out of 100, computed from the findings rather than asked of the model.
 *
 * A model-given number drifts run to run and cannot be explained to the author; this one is 100
 * minus a fixed penalty per finding, so two reviews of the same gaps score the same and the comment
 * can say exactly why.
 */
export const scorePrReview = (
	report: PrReviewReport,
	/** Findings from earlier reviews still open at this head: they count as much as new ones. */
	carriedOpen: ReadonlyArray<{ readonly severity: PrReviewSeverity }> = [],
): { readonly score: number; readonly grade: PrReviewGrade } => {
	const all = [...report.findings, ...carriedOpen]
	const penalty = all.reduce((sum, finding) => sum + PR_REVIEW_SCORE_PENALTY[finding.severity], 0)
	const score = Math.max(0, 100 - penalty)
	// A real issue is never "excellent", whatever the arithmetic says: the headline must agree
	// with the verdict beside it.
	const hasIssues = all.some((finding) => finding.severity !== "info")
	const grade: PrReviewGrade =
		score >= 90 && !hasIssues ? "excellent" : score >= 75 ? "good" : score >= 50 ? "needs work" : "poor"
	return { score, grade }
}

/** What the `submit_review` handler hands the service once it has normalized the submission. */
export class SubmitPrReviewRequest extends Schema.Class<SubmitPrReviewRequest>("SubmitPrReviewRequest")({
	report: PrReviewReport,
	model: Schema.optionalKey(Schema.String),
	inputTokens: Schema.optionalKey(Schema.Number),
	outputTokens: Schema.optionalKey(Schema.Number),
	/** Filed by the close-out turn after the pass ended without a report; posted as a partial. */
	partial: Schema.optionalKey(Schema.Boolean),
	/** Handles of earlier findings this head fixes. */
	resolved: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

/** One review in a repository's list: enough to scan outcomes without loading the report. */
export class PrReviewListItem extends Schema.Class<PrReviewListItem>("PrReviewListItem")({
	id: PrReviewId,
	number: Schema.Number,
	title: Schema.NullOr(Schema.String),
	url: Schema.String,
	headSha: GitCommitSha,
	status: PrReviewStatus,
	skipReason: Schema.NullOr(PrReviewSkipReason),
	verdict: Schema.NullOr(PrReviewVerdict),
	score: Schema.NullOr(Schema.Number),
	findings: Schema.Number,
	commentUrl: Schema.NullOr(Schema.String),
	publishError: Schema.NullOr(Schema.String),
	error: Schema.NullOr(Schema.String),
	createdAt: Schema.Number,
	finishedAt: Schema.NullOr(Schema.Number),
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

/**
 * How a comment addresses the reviewer: `@maple`, or the hosted App's own login. Not `@maple-dev`
 * or `@maplefoo`, and not inside an email address or a path.
 */
const MENTION = /(^|[^\w@./-])@maple(?:labsapp)?(?![\w-])/i

/** Whether a comment mentions the reviewer at all. */
export const mentionsReviewer = (body: string): boolean => MENTION.test(body)

/**
 * The command a mention carries: the first word after it, `review` or `fix`, else a question.
 * `text` is the comment with the mention removed, what the reply agent is asked.
 */
export const parseReplyCommand = (
	body: string,
): { readonly command: PrReviewReplyCommand; readonly text: string } => {
	const match = MENTION.exec(body)
	if (match === null) return { command: "ask", text: body.trim() }
	const after = body.slice(match.index + match[0].length)
	const word = /^\s*([a-z]+)\b/i.exec(after)?.[1]?.toLowerCase()
	const command: PrReviewReplyCommand = word === "review" ? "review" : word === "fix" ? "fix" : "ask"
	const text = `${body.slice(0, match.index + (match[1]?.length ?? 0))}${after}`.trim()
	return { command, text }
}

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

// Errors

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
