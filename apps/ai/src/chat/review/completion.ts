/**
 * `submit_review` and `record_finding`: how a review's turn files its report, and what the turn
 * files itself when no report lands.
 */
import type { ChatTurnOrigin } from "@maple/domain/chat-session"
import {
	normalizePrReviewFinding,
	overlongFinding,
	PR_REVIEW_FINDING_WORDS,
	normalizePrReviewSubmission,
	PR_REVIEW_MAX_FINDINGS,
	type PrReviewFinding,
	PrReviewFindingSubmission,
	type PrReviewNotFoundError,
	type PrReviewPersistenceError,
	PrReviewReport,
	PrReviewSubmission,
	type PrReviewFailureReason,
	type PrReviewVerdict,
	SubmitPrReviewRequest,
} from "@maple/domain/http"
import { mergeSavedFindings } from "@maple/backend/services/pr-review/findings"
import { Array as Arr, Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { MapleToolFailure, summarizeToolFailure } from "../../mcp/tools/llm-tools"
import { toolHandlersWithContent } from "../../platform/genai-spans"
import type { AutonomousOutcome } from "../autonomous-outcome"
import { type CompletionRun, type RunCompletion, SUBMIT_REVIEW } from "../completion"
import type { RunUsage } from "../usage"
import {
	type ChildFindings,
	childFindingsRefusal,
	childFindingsToFile,
	closeOutFindings,
	unaccountedChildFindings,
} from "./child-findings"
import { type ReviewCoverage, unreadRefusal } from "./coverage"
import type { ReviewLedger } from "./ledger"

export const RECORD_FINDING = "record_finding"

/** Files the review; the caller has bound the org and the review. */
export type SubmitReview = (
	request: SubmitPrReviewRequest,
) => Effect.Effect<unknown, PrReviewPersistenceError | PrReviewNotFoundError>

/** A review turn's own state, shared by its pass and its close-out: what was read, what was saved. */
export interface ReviewTurnState {
	readonly coverage: ReviewCoverage
	readonly ledger: ReviewLedger
	/** What the turn's `review_files` children answered, so a continuation still accounts for it. */
	readonly childFindings: ChildFindings
}

/** `parameters` is the lenient {@link PrReviewSubmission}, for the reason `diagnosisTool`'s is. */
export const reviewTool = Tool.make(SUBMIT_REVIEW, {
	description:
		"Record your review of THIS pull request. Call it once, after you have " +
		"read every hunk you review, with your verdict, tests and risk signals, confidence reason, summary, key changes, what you checked, before-merge steps, coverage, line-anchored findings and the " +
		"handles of earlier findings this head fixes. When the kickoff lists removed telemetry names and the head still emits one elsewhere, " +
		"pass that location in telemetryDismissals. A warning or critical a review_files child reported is either " +
		"filed or listed in childDismissals with the reason it does not hold. It " +
		"persists the review and posts it to the pull request. A refusal says what to do before calling " +
		"it again; once it answers that the review is recorded, stop.",
	parameters: PrReviewSubmission,
	success: Schema.String,
	failure: MapleToolFailure,
	// A refusal (files unread, a post that failed) is an answer the model acts on, not the run's end.
	failureMode: "return",
})

/** Same lenient finding shape `submit_review` takes, one at a time. */
export const recordFindingTool = Tool.make(RECORD_FINDING, {
	description:
		"Save one finding the moment you have established it: path, new-side line, category, " +
		"severity, title, body, and suggestion or replacement. Saved findings are kept even if the " +
		"pass stops before submit_review, and submit_review adds them for you, so " +
		"never repeat one there or save the same issue twice. There is no way to edit or remove a " +
		"saved finding: check it against the code before you save it.",
	parameters: PrReviewFindingSubmission,
	success: Schema.String,
	failure: MapleToolFailure,
	failureMode: "return",
})

/** Length refusals one pass gets from `record_finding` before it saves what it is given. */
const MAX_LENGTH_REFUSALS = 4

const overlongRefusal = (overlong: ReadonlyArray<string>) =>
	Arr.join(
		[
			`Not saved: ${overlong.length === 1 ? "a finding is" : `${overlong.length} findings are`} too long for an inline comment.`,
			...Arr.map(overlong, (item) => `- ${item}`),
			`Rewrite ${overlong.length === 1 ? "it" : "them"}: the body in at most ${PR_REVIEW_FINDING_WORDS.body} words says what goes wrong, on what input, and what the user sees; the fix goes only in suggestion (at most ${PR_REVIEW_FINDING_WORDS.suggestion} words) or replacement, never in the body. Then call again.`,
		],
		"\n",
	)

/** What the model reads back after a `record_finding` call. */
const recordAnswer = (outcome: ReturnType<ReviewLedger["record"]>, count: number): string => {
	switch (outcome) {
		case "recorded":
			return `Saved (${count} ${count === 1 ? "finding" : "findings"} so far). Do not repeat it in submit_review.`
		case "repeat":
			return `Not saved: it restates a finding already saved (${count} so far). Keep going.`
		case "full":
			return `Not saved: the review holds at most ${PR_REVIEW_MAX_FINDINGS} findings. Submit the review now.`
	}
}

/**
 * The review a turn files itself when its findings were saved but no `submit_review` landed: a
 * partial with exactly those findings, so the deadline that stopped the pass does not lose them.
 */
export const savedFindingsRequest = (input: {
	readonly findings: ReadonlyArray<PrReviewFinding>
	readonly unreviewed: ReadonlyArray<string>
	readonly modelName: string
	readonly usage: RunUsage
	/** Why the pass stopped, told to the pull request in place of a generic early end. */
	readonly reason?: PrReviewFailureReason
}): SubmitPrReviewRequest =>
	new SubmitPrReviewRequest({
		report: new PrReviewReport({
			verdict: Arr.some(input.findings, (finding) => finding.severity !== "info") ? "issues" : "clean",
			summary: "",
			coverage: [],
			findings: input.findings,
			...(input.unreviewed.length > 0 ? { unreviewed: input.unreviewed } : undefined),
		}),
		model: input.modelName,
		inputTokens: input.usage.input,
		outputTokens: input.usage.output,
		partial: true,
		...(input.reason === undefined ? undefined : { partialReason: input.reason }),
	})

/** A partial carries why the pass before it stopped, so the pull request is told that. */
export const withPartialReason = (
	request: SubmitPrReviewRequest,
	reason: PrReviewFailureReason | undefined,
): SubmitPrReviewRequest =>
	reason !== undefined && request.partial === true
		? new SubmitPrReviewRequest({ ...request, partialReason: reason })
		: request

/** How long filing a review's saved findings may take once the turn has started settling. */
const SUBMIT_SAVED_TIMEOUT = "60 seconds"

/**
 * Settle a review that filed no report: the findings its pass saved, and its children's warnings,
 * are posted as a partial rather than lost with the report. Recorded in `outcome` as the verdict.
 */
export const fileSavedFindings = <E>(input: {
	readonly outcome: AutonomousOutcome
	readonly review: ReviewTurnState
	readonly modelName: string
	readonly usage: RunUsage
	readonly submit: (request: SubmitPrReviewRequest) => Effect.Effect<unknown, E>
}) =>
	Effect.gen(function* () {
		const { outcome, review } = input
		const saved = closeOutFindings(review.ledger.findings(), review.childFindings.all())
		if (outcome.submitted() || saved.length === 0) return
		const failure = outcome.failure()
		const filed = yield* input
			.submit(
				savedFindingsRequest({
					findings: saved,
					unreviewed: review.coverage.unread(),
					modelName: input.modelName,
					usage: input.usage,
					...(failure === undefined ? undefined : { reason: failure }),
				}),
			)
			.pipe(
				Effect.as(true),
				// Settling is uninterruptible, so a hung submit is bounded; `failReview` skips a filed review.
				Effect.timeout(SUBMIT_SAVED_TIMEOUT),
				Effect.catchCause((cause) =>
					Effect.logError("Could not file the saved findings", cause).pipe(Effect.as(false)),
				),
			)
		outcome.record("verdict", filed)
		yield* Effect.annotateCurrentSpan("maple.pr_review.filed_saved_findings", filed)
	})

/**
 * The `submit_review` tool for a review's unattended pass, built like {@link diagnosisCompletion}:
 * the caller binds the review, so the agent never chooses which pull request its report is posted
 * to. `review` is the turn's: the first submission with files unread (`coverage`) or a child's
 * warning unaccounted (`childFindings`) is refused once, and `ledger` holds what `record_finding` saved.
 */
export const reviewCompletion = (
	origin: ChatTurnOrigin,
	review: ReviewTurnState,
	submitReview: SubmitReview,
) => {
	// Only the unattended pass files a review. A follow-up in the session answers in prose: the
	// row is already settled, and a second submission would be dropped while reporting success.
	if (origin.kind !== "autonomous") return undefined
	return (run: CompletionRun) => buildReviewCompletion(run, review, submitReview)
}

const buildReviewCompletion = (
	{ usage, modelName, partial, sessionAttributes }: CompletionRun,
	review: ReviewTurnState,
	submitReview: SubmitReview,
) => {
	const { coverage, ledger, childFindings } = review
	const toolkit = Toolkit.make(reviewTool, recordFindingTool)
	let submitted = false
	let refusedUnread = false
	let refusedChildren = false
	let refusedLong = false
	// Bounded, so a model that cannot shorten a finding still files it rather than looping.
	let lengthRefusals = 0
	// Once only: a second call with files still unread is the agent submitting anyway. A close-out
	// files what it has and a not_applicable verdict reads nothing, so neither is held.
	const unreadToRefuse = (verdict: PrReviewVerdict): ReadonlyArray<string> => {
		if (partial || refusedUnread || verdict === "not_applicable") return []
		const unread = coverage.unread()
		refusedUnread = unread.length > 0
		return unread
	}
	const record = (submission: PrReviewSubmission) =>
		Effect.suspend(() => {
			const normalized = normalizePrReviewSubmission(submission)
			const { filled, droppedFindings, resolved, telemetryDismissals } = normalized
			const unread = unreadToRefuse(normalized.report.verdict)
			if (unread.length > 0) {
				return Effect.annotateCurrentSpan("maple.pr_review.unread_files", unread.length).pipe(
					Effect.andThen(Effect.fail(new MapleToolFailure({ message: unreadRefusal(unread) }))),
				)
			}
			const unaccounted = unaccountedChildFindings(
				childFindings.all(),
				// Deduplicated as the report is, so a finding saved and repeated counts once.
				mergeSavedFindings(ledger.findings(), normalized.report.findings),
				normalized.childDismissals,
			)
			// A close-out is not refused, but still files what the children found.
			if (unaccounted.length > 0 && !partial && !refusedChildren) {
				refusedChildren = true
				return Effect.annotateCurrentSpan(
					"maple.pr_review.unaccounted_child_findings",
					unaccounted.length,
				).pipe(
					Effect.andThen(
						Effect.fail(new MapleToolFailure({ message: childFindingsRefusal(unaccounted) })),
					),
				)
			}
			// Once only, and never for a close-out: a second call keeps what it was given.
			const overlong =
				partial || refusedLong
					? []
					: Arr.flatMap(normalized.report.findings, (finding) =>
							Arr.fromNullishOr(overlongFinding(finding)),
						)
			if (overlong.length > 0) {
				refusedLong = true
				return Effect.annotateCurrentSpan("maple.pr_review.overlong_findings", overlong.length).pipe(
					Effect.andThen(Effect.fail(new MapleToolFailure({ message: overlongRefusal(overlong) }))),
				)
			}
			// Refused once already: a peer's warning stands unless the reviewer says why it does not.
			const childFiled = childFindingsToFile(unaccounted)
			const saved = [...ledger.findings(), ...childFiled]
			const unreviewed = normalized.report.verdict === "not_applicable" ? [] : coverage.unread()
			const merged = withSavedFindings(normalized.report, saved, unreviewed)
			// A close-out files what a stopped pass saved, and not_applicable owes no reads, so
			// neither counts as a whole-diff read.
			const report =
				coverage.wholeDiff() === true &&
				!partial &&
				unreviewed.length === 0 &&
				normalized.report.verdict !== "not_applicable"
					? new PrReviewReport({ ...merged, wholeDiff: true })
					: merged
			const childPosted = Arr.filter(childFiled, (child) =>
				Arr.some(
					report.findings,
					(finding) =>
						finding.path === child.path &&
						finding.line === child.line &&
						finding.title === child.title,
				),
			).length
			return submitReview(
				new SubmitPrReviewRequest({
					report,
					model: modelName,
					inputTokens: usage.input,
					outputTokens: usage.output,
					...(partial ? { partial: true } : undefined),
					...(resolved.length > 0 ? { resolved } : undefined),
					...(telemetryDismissals.length > 0 ? { telemetryDismissals } : undefined),
				}),
			).pipe(
				Effect.tap(() =>
					Effect.annotateCurrentSpan({
						"maple.pr_review.filled_fields": Arr.join(filled, ","),
						"maple.pr_review.filled_count": filled.length,
						"maple.pr_review.dropped_findings": droppedFindings,
						"maple.pr_review.findings": report.findings.length,
						"maple.pr_review.saved_findings": saved.length,
						"maple.pr_review.unreviewed_files": unreviewed.length,
						"maple.pr_review.verdict": report.verdict,
						"maple.pr_review.resolved": resolved.length,
						"maple.pr_review.child_findings": childFindings.all().length,
						"maple.pr_review.child_findings_filed_unaccounted": childPosted,
						// Unpostable, or cut by the report's finding cap.
						"maple.pr_review.child_findings_dropped": unaccounted.length - childPosted,
						"maple.pr_review.child_dismissals": normalized.childDismissals.length,
						...(normalized.childDismissals.length > 0
							? {
									"maple.pr_review.child_dismissal_reasons": Arr.join(
										Arr.map(
											normalized.childDismissals,
											(dismissal) =>
												`${dismissal.path}:${dismissal.line}: ${dismissal.reason}`,
										),
										"\n",
									),
								}
							: undefined),
					}),
				),
				Effect.tap(() => Effect.sync(() => (submitted = true))),
				Effect.as("Review recorded."),
				Effect.catchCause((cause) =>
					Effect.fail(
						new MapleToolFailure({
							message: `${SUBMIT_REVIEW} failed: ${summarizeToolFailure(cause)}`,
						}),
					),
				),
			)
		})
	const save = (raw: PrReviewFindingSubmission) =>
		Effect.suspend(() => {
			const finding = normalizePrReviewFinding(raw)
			if (finding === undefined) {
				return Effect.fail(
					new MapleToolFailure({
						message:
							"Not saved: a finding needs a path and a positive new-side line from a hunk you read, and an observability finding needs its audit check id.",
					}),
				)
			}
			const overlong = overlongFinding(finding)
			if (overlong !== undefined && lengthRefusals < MAX_LENGTH_REFUSALS) {
				lengthRefusals++
				return Effect.annotateCurrentSpan("maple.pr_review.record_outcome", "overlong").pipe(
					Effect.andThen(
						Effect.fail(new MapleToolFailure({ message: overlongRefusal([overlong]) })),
					),
				)
			}
			const outcome = ledger.record(finding)
			return Effect.annotateCurrentSpan("maple.pr_review.record_outcome", outcome).pipe(
				Effect.as(recordAnswer(outcome, ledger.findings().length)),
			)
		})
	return {
		tool: SUBMIT_REVIEW,
		toolkit,
		...toolHandlersWithContent(
			toolkit,
			{ [SUBMIT_REVIEW]: record, [RECORD_FINDING]: save },
			sessionAttributes,
		),
		submitted: () => submitted,
		review,
	} satisfies RunCompletion
}

const SEVERITY_RANK = { critical: 2, warn: 1, info: 0 } as const satisfies Record<
	PrReviewFinding["severity"],
	number
>

/**
 * A submitted report with the pass's saved findings folded in, most important kept when over the
 * cap, and the reviewed files it never read. The verdict follows the merged findings.
 */
const withSavedFindings = (
	report: PrReviewReport,
	saved: ReadonlyArray<PrReviewFinding>,
	unreviewed: ReadonlyArray<string>,
): PrReviewReport => {
	if (saved.length === 0 && unreviewed.length === 0) return report
	// Stable, so saved findings stay ahead of submitted ones of the same severity.
	const findings = [...mergeSavedFindings(saved, report.findings)]
		.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
		.slice(0, PR_REVIEW_MAX_FINDINGS)
	return new PrReviewReport({
		...report,
		findings,
		verdict: Arr.some(findings, (finding) => finding.severity !== "info") ? "issues" : report.verdict,
		...(unreviewed.length > 0 ? { unreviewed } : undefined),
	})
}
