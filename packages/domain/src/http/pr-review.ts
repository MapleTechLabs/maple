import { Schema } from "effect"
import { OrgId } from "../primitives"
import { HttpTaggedError } from "./error-policy"
import { GitCommitSha, VcsRepositoryId } from "./vcs"

/**
 * An observability review of one pull request at one head commit.
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
 * Why a delivery produced no review. Recorded on the row so the settings page can say "your last
 * three pull requests were drafts" instead of looking broken.
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
]).annotate({ identifier: "@maple/PrReviewSkipReason", title: "Pull Request Review Skip Reason" })
export type PrReviewSkipReason = Schema.Schema.Type<typeof PrReviewSkipReason>

export const PrReviewVerdict = Schema.Literals(["instrumented", "gaps", "not_applicable"]).annotate({
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

/**
 * One gap, anchored to a line of the pull request's diff.
 *
 * `line` is on the new side of the diff, because that is the only line GitHub will accept for an
 * inline comment or a check annotation. `checkId` is a `maple-audit` id (`SPAN-03`, `MAP-01`) so the
 * check run, the settings page and the docs say the same thing about the same gap.
 */
export class PrReviewFinding extends Schema.Class<PrReviewFinding>("PrReviewFinding")({
	path: Schema.String,
	line: Schema.Number,
	endLine: Schema.optionalKey(Schema.Number),
	checkId: Schema.String,
	severity: PrReviewSeverity,
	title: Schema.String,
	body: Schema.String,
	suggestion: Schema.optionalKey(Schema.String),
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
export const PrReviewFindingSubmission = Schema.Struct({
	path: Schema.optionalKey(Schema.String),
	line: Schema.optionalKey(Schema.Number),
	endLine: Schema.optionalKey(Schema.Number),
	checkId: Schema.optionalKey(Schema.String),
	severity: Schema.optionalKey(Schema.Union([PrReviewSeverity, Schema.String])),
	title: Schema.optionalKey(Schema.String),
	body: Schema.optionalKey(Schema.String),
	suggestion: Schema.optionalKey(Schema.String),
})
export type PrReviewFindingSubmission = Schema.Schema.Type<typeof PrReviewFindingSubmission>

export const PrReviewCoverageSubmission = Schema.Struct({
	unit: Schema.optionalKey(Schema.String),
	kind: Schema.optionalKey(Schema.String),
	instrumented: Schema.optionalKey(Schema.Boolean),
	evidence: Schema.optionalKey(Schema.String),
})

export const PrReviewSubmission = Schema.Struct({
	verdict: Schema.optionalKey(Schema.Union([PrReviewVerdict, Schema.String])),
	summary: Schema.optionalKey(Schema.String),
	coverage: Schema.optionalKey(Schema.Array(PrReviewCoverageSubmission)),
	findings: Schema.optionalKey(Schema.Array(PrReviewFindingSubmission)),
})
export type PrReviewSubmission = Schema.Schema.Type<typeof PrReviewSubmission>

const isVerdict = Schema.is(PrReviewVerdict)
const isSeverity = Schema.is(PrReviewSeverity)

/** A finding the review can post: it names a file and a line, and says what is wrong. */
const MAX_FINDINGS = 50
const MAX_COVERAGE = 50
const MAX_TEXT = 4_000

const clip = (value: string, max = MAX_TEXT) => (value.length > max ? `${value.slice(0, max)}…` : value)

export interface NormalizedPrReviewSubmission {
	readonly report: PrReviewReport
	/** Top-level keys the model supplied, for the span. */
	readonly filled: ReadonlyArray<string>
	/** Findings dropped because they could not be anchored to a line, for the span. */
	readonly droppedFindings: number
}

/**
 * A submission as a stored report.
 *
 * A finding without a path or a positive line cannot be placed on the diff and is dropped rather
 * than invented; the count is what the span records. The verdict is `gaps` exactly when a warn or
 * critical finding is retained; otherwise the model's `not_applicable` survives and anything else
 * reads as `instrumented`.
 */
export const normalizePrReviewSubmission = (submission: PrReviewSubmission): NormalizedPrReviewSubmission => {
	const filled = Object.keys(submission).filter(
		(key) => submission[key as keyof PrReviewSubmission] !== undefined,
	)
	const rawFindings = submission.findings ?? []
	const findings: Array<PrReviewFinding> = []
	for (const raw of rawFindings) {
		const path = raw.path?.trim()
		const line = raw.line
		if (!path || line === undefined || !Number.isFinite(line) || line < 1) continue
		const startLine = Math.floor(line)
		const endLine =
			raw.endLine !== undefined && Number.isFinite(raw.endLine) && Math.floor(raw.endLine) > startLine
				? Math.floor(raw.endLine)
				: undefined
		findings.push(
			new PrReviewFinding({
				path,
				line: startLine,
				...(endLine === undefined ? undefined : { endLine }),
				checkId: (raw.checkId?.trim() || "SPAN-02").toUpperCase(),
				severity: isSeverity(raw.severity) ? raw.severity : "warn",
				title: clip(raw.title?.trim() || "Observability gap", 200),
				body: clip(raw.body?.trim() || ""),
				...(raw.suggestion?.trim() ? { suggestion: clip(raw.suggestion.trim()) } : undefined),
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
				instrumented: raw.instrumented ?? false,
				evidence: clip(raw.evidence?.trim() || ""),
			}),
		)
		if (coverage.length >= MAX_COVERAGE) break
	}
	// A retained warn or critical finding is a gap whatever the model called the verdict; the
	// check run's conclusion and its inline comments must never disagree.
	const hasGaps = findings.some((finding) => finding.severity !== "info")
	const submittedVerdict = isVerdict(submission.verdict) ? submission.verdict : undefined
	// And the reverse: `gaps` with nothing above a note is not a gap, and read as one the check
	// title said "0 observability gaps to close".
	const verdict: PrReviewVerdict = hasGaps
		? "gaps"
		: submittedVerdict === undefined || submittedVerdict === "gaps"
			? "instrumented"
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
): { readonly score: number; readonly grade: PrReviewGrade } => {
	const penalty = report.findings.reduce(
		(sum, finding) => sum + PR_REVIEW_SCORE_PENALTY[finding.severity],
		0,
	)
	const score = Math.max(0, 100 - penalty)
	const grade: PrReviewGrade =
		score >= 90 ? "excellent" : score >= 75 ? "good" : score >= 50 ? "needs work" : "poor"
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

// Errors

export class PrReviewPersistenceError extends HttpTaggedError<PrReviewPersistenceError>()(
	"@maple/http/pr-review/PrReviewPersistenceError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.String) },
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
