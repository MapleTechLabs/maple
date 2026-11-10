/**
 * What a chat run is allowed to call.
 *
 * Kept out of `loop/` on purpose: deciding *when* to call a tool is the engine's job, not this
 * module's. Swapping the tool set — a read-only sub-agent, a mode with narrower reach — should not
 * touch control flow at all.
 */
import type { ChatTurnOrigin } from "@maple/domain/chat-session"
import { evaluatePermission, type PermissionRuleset } from "@maple/domain/permission"
import {
	AiTriageSubmission,
	type InvestigationDataCorruptionError,
	type InvestigationNotFoundError,
	type InvestigationPersistenceError,
	normalizePrReviewFinding,
	overlongFinding,
	PR_REVIEW_FINDING_WORDS,
	normalizePrReviewSubmission,
	normalizeTriageSubmission,
	PR_REVIEW_MAX_FINDINGS,
	type PrReviewFinding,
	PrReviewFindingSubmission,
	type PrReviewNotFoundError,
	PrReviewEditSubmission,
	type PrReviewPersistenceError,
	type PrReviewReplyNotFoundError,
	PrReviewReplySubmission,
	PrReviewReport,
	PrReviewSubmission,
	type PrReviewFailureReason,
	type PrReviewVerdict,
	SubmitDiagnosisRequest,
	SubmitPrReviewRequest,
	type TenantContext,
} from "@maple/domain/http"
import type { RunBudgetHook, RunUsageDelta } from "@yielded/agent/run-options"
import type { ModelCallUsage } from "@yielded/agent/usage"
import type { AiModelSpend } from "@maple/backend/services/billing/autumn-tracker"
import { autumnModelId } from "../platform/ai-credits"
import { Array as Arr, type Cause, Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import type { McpToolSurface } from "@maple/domain/mcp-manifest"
import {
	buildMapleToolkit,
	MapleToolFailure,
	summarizeToolFailure,
	type ToolUiPayload,
	type UiSource,
} from "../mcp/tools/llm-tools"
import { toolHandlersWithContent } from "../platform/genai-spans"
import { mergeSavedFindings } from "@maple/backend/services/pr-review/findings"
import {
	type ChildFindings,
	childFindingsRefusal,
	childFindingsToFile,
	closeOutFindings,
	unaccountedChildFindings,
} from "./review-child-findings"
import { type ReviewCoverage, unreadRefusal } from "./review-coverage"
import type { ReviewLedger } from "./review-ledger"
import type { AutonomousOutcome } from "./autonomous-outcome"
import {
	type CompletionRun,
	type RunCompletion,
	SUBMIT_DIAGNOSIS,
	SUBMIT_REPLY,
	SUBMIT_REVIEW,
} from "./completion"

/** Files the investigation's report; the caller has already bound the org and the investigation. */
export type SubmitDiagnosis = (
	request: SubmitDiagnosisRequest,
) => Effect.Effect<
	unknown,
	InvestigationPersistenceError | InvestigationNotFoundError | InvestigationDataCorruptionError
>

export const RECORD_FINDING = "record_finding"
export const PROPOSE_EDIT = "propose_edit"

/** Posts the reply, and stages an edit for it; the caller has bound the org and the reply. */
export interface ReplyWrites {
	readonly submit: (
		body: string,
	) => Effect.Effect<string, PrReviewPersistenceError | PrReviewReplyNotFoundError>
	readonly stageEdit: (
		edit: PrReviewEditSubmission,
	) => Effect.Effect<string, PrReviewPersistenceError | PrReviewReplyNotFoundError>
}

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

/**
 * Token totals for the run so far.
 *
 * Mutable and shared rather than returned, because `submit_diagnosis` is a *tool* invoked mid-run,
 * so there is no "after the run" moment at which to hand it a total. The Durable Object accumulates
 * it from the run's events; the billing charge is raised separately once the run ends.
 */
export interface RunUsage {
	input: number
	output: number
	cacheRead: number
	/** The same calls as AI credit charges, in Autumn's exclusive pools; see {@link recordCharge}. */
	readonly charges: Array<Mutable<AiModelSpend>>
	/**
	 * The part of the totals above that the run's child agents (`review_files`) spent, as the engine
	 * reports each one ending. Their calls are charged with the run's own.
	 */
	readonly delegated: { modelCalls: number; input: number; output: number; costMicrousd: number }
}

type Mutable<A> = { -readonly [K in keyof A]: A[K] }

export const makeRunUsage = (): RunUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	charges: [],
	delegated: { modelCalls: 0, input: 0, output: 0, costMicrousd: 0 },
})

/**
 * Below every long-context tier models.dev lists (the smallest is 32k). Autumn picks a model's
 * tier from one charge's total input, so a charge that sums calls past a tier bills them all at
 * the long-context rate. Calls are merged only while their sum stays under it.
 */
const MERGE_CEILING_TOKENS = 32_000

const chargeInput = (spend: AiModelSpend) =>
	spend.inputTokens + spend.cacheReadTokens + spend.cacheWriteTokens

/** One model call into the run's AI credit charges, merged into the last one when that is safe. */
const recordCharge = (usage: RunUsage, call: ModelCallUsage) => {
	const charge = {
		modelId: autumnModelId(call.model),
		inputTokens: call.inputTokens.uncached,
		outputTokens: call.outputTokens.text,
		cacheReadTokens: call.inputTokens.cacheRead,
		cacheWriteTokens: call.inputTokens.cacheWrite,
		reasoningTokens: call.outputTokens.reasoning,
	}
	const last = usage.charges.at(-1)
	if (
		last === undefined ||
		last.modelId !== charge.modelId ||
		chargeInput(last) + chargeInput(charge) > MERGE_CEILING_TOKENS
	) {
		usage.charges.push(charge)
		return
	}
	last.inputTokens += charge.inputTokens
	last.outputTokens += charge.outputTokens
	last.cacheReadTokens += charge.cacheReadTokens
	last.cacheWriteTokens += charge.cacheWriteTokens
	last.reasoningTokens += charge.reasoningTokens
}

/**
 * A budget hook that only watches.
 *
 * `guard` passes every pull through untouched and `consume` never rejects, because the ceilings a
 * run answers to are its `AgentPolicy`. What this exists for is the side effect: the run event
 * stream reports no token usage at all, so without it every reader of {@link RunUsage} — the
 * metering finalizer, `submit_diagnosis`, and every workflow pass's reported cost — sees zeros.
 */
export const accumulateUsage = (usage: RunUsage): RunBudgetHook => ({
	guard: (effect) => effect,
	consume: (delta: RunUsageDelta) =>
		Effect.sync(() => {
			usage.input += delta.inputTokens
			usage.output += delta.outputTokens
			usage.cacheRead += delta.usage.inputTokens.cacheRead ?? 0
			// Absent only on tool-only charges, which carry no tokens.
			if (delta.modelUsage !== undefined) recordCharge(usage, delta.modelUsage)
		}),
})

/**
 * `parameters` is the lenient {@link AiTriageSubmission}, not the stored `AiTriageResult`.
 *
 * The engine decodes a tool call's arguments before the handler runs, and a decode failure lands in
 * the model stream's error channel, which ends the run. Against a strict report schema that made
 * one missing key at the end of a full investigation throw the whole investigation away. The
 * handler normalizes instead, and records what the model left out.
 *
 * `failureMode: "return"` is what makes a call the schema still rejects a recoverable tool error:
 * the engine defers validation for such tools instead of failing the model stream.
 */
export const diagnosisTool = Tool.make(SUBMIT_DIAGNOSIS, {
	description:
		"Record your structured diagnosis for THIS investigation. Call it exactly once, " +
		"after you have gathered evidence, with your final assessment. `evidence` is an array of " +
		"objects ({traceIds, logPatterns, relatedServices, note}); `suggestedActions`, `ruledOut` " +
		"and `unchecked` are arrays of strings; `suspectCommit` ({sha, repo}) only when one observed " +
		"commit caused it. It persists the report and renders it for the user. " +
		"After calling it, stop unless the user asks a follow-up.",
	parameters: AiTriageSubmission,
	success: Schema.String,
	failure: MapleToolFailure,
	failureMode: "return",
})

export const replyTool = Tool.make(SUBMIT_REPLY, {
	description:
		"Post your answer on the pull request, in GitHub markdown, where the person asked. Call it " +
		"exactly once, after you have read what the answer depends on. For a fix, call it after " +
		"propose_edit: the staged edits are committed first and the result is added to your answer. " +
		"After calling it, stop.",
	parameters: PrReviewReplySubmission,
	success: Schema.String,
	failure: MapleToolFailure,
	// See `diagnosisTool`: a rejected call is a result the model fixes, not a retried model call.
	failureMode: "return",
})

export const proposeEditTool = Tool.make(PROPOSE_EDIT, {
	description:
		"Stage one exact edit for a fix someone asked for with `@maple fix`. `oldText` is copied " +
		"verbatim from the file at the pull request's head and must occur there exactly once; it " +
		"becomes `newText`. An empty `oldText` creates a new file. Edits apply in order and are " +
		"committed together when you call submit_reply. The answer says whether it was staged.",
	parameters: PrReviewEditSubmission,
	success: Schema.String,
	failure: MapleToolFailure,
	failureMode: "return",
})

/**
 * `submit_reply` and `propose_edit` for a reply's unattended pass. The caller binds the reply, so
 * the agent never chooses which thread it answers or which branch it commits to.
 */
export const replyCompletion = (origin: ChatTurnOrigin, writes: ReplyWrites) => {
	if (origin.kind !== "autonomous") return undefined
	return (run: CompletionRun) => {
		const toolkit = Toolkit.make(replyTool, proposeEditTool)
		let submitted = false
		const asToolFailure = (tool: string) => (cause: Cause.Cause<unknown>) =>
			Effect.fail(new MapleToolFailure({ message: `${tool} failed: ${summarizeToolFailure(cause)}` }))
		return {
			tool: SUBMIT_REPLY,
			toolkit,
			...toolHandlersWithContent(
				toolkit,
				{
					[SUBMIT_REPLY]: (submission: PrReviewReplySubmission) =>
						writes.submit(submission.body ?? "").pipe(
							Effect.tap(() => Effect.sync(() => (submitted = true))),
							Effect.catchCause(asToolFailure(SUBMIT_REPLY)),
						),
					[PROPOSE_EDIT]: (edit: PrReviewEditSubmission) =>
						writes.stageEdit(edit).pipe(Effect.catchCause(asToolFailure(PROPOSE_EDIT))),
				},
				run.sessionAttributes,
			),
			submitted: () => submitted,
		} satisfies RunCompletion
	}
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

/**
 * The `submit_diagnosis` tool for an investigation session (`"<orgId>:inv-<id>"`).
 *
 * Its arguments ARE the structured report. Deliberately not approval-gated: it is the structured
 * output channel, not a user-facing mutation. The caller binds the investigation and org from the
 * session id, so the agent never chooses which investigation it writes. Being outside the ruleset
 * is why the origin is consulted here directly rather than left to the gate.
 *
 * `submitDiagnosis` arrives as a callback rather than being resolved from `InvestigationService`
 * here: that service is itself what starts an investigation's autonomous run, so resolving it
 * through the requirements channel would make it require itself.
 *
 * `submitted` reports whether the tool landed a report during the run. The engine is never told
 * the tool is *required*: a required completion becomes `tool_choice: required` on every model
 * call, which the providers Maple runs on do not reliably honour, and the engine fails the whole
 * run when they do not. The turn runner checks `submitted` instead and closes the pass itself.
 */
export const diagnosisCompletion = (origin: ChatTurnOrigin, submitDiagnosis: SubmitDiagnosis) => {
	// A connector never files a diagnosis. This tool rides *outside* the ruleset — it is the
	// investigation's structured output channel, not a gated mutation — so nothing else withholds
	// it, and it does write: a report row, and the investigation's status. An attended follow-up in
	// the app may file one; a channel is not where a diagnosis gets settled.
	if (origin.kind === "connector") return undefined
	return (run: CompletionRun) => buildDiagnosisCompletion(run, submitDiagnosis)
}

const buildDiagnosisCompletion = (
	{ turnId, usage, modelName, partial, sessionAttributes }: CompletionRun,
	submitDiagnosis: SubmitDiagnosis,
) => {
	const toolkit = Toolkit.make(diagnosisTool)
	let submitted = false
	return {
		tool: SUBMIT_DIAGNOSIS,
		toolkit,
		...toolHandlersWithContent(
			toolkit,
			{
				[SUBMIT_DIAGNOSIS]: (submission: AiTriageSubmission) =>
					Effect.suspend(() => {
						const { report, filled } = normalizeTriageSubmission(submission)
						return submitDiagnosis(
							new SubmitDiagnosisRequest({
								report,
								model: modelName,
								inputTokens: usage.input,
								outputTokens: usage.output,
								...(partial ? { partial: true } : undefined),
								turnId,
							}),
						).pipe(
							Effect.tap(() =>
								// What the model omitted is the signal that the prompt or the model is the
								// problem; without it a filled-in report is indistinguishable from a written one.
								Effect.annotateCurrentSpan({
									"maple.diagnosis.filled_fields": Arr.join(filled, ","),
									"maple.diagnosis.filled_count": filled.length,
								}),
							),
						)
					}).pipe(
						Effect.tap(() => Effect.sync(() => (submitted = true))),
						Effect.as("Diagnosis recorded."),
						// Named failures only. A rendered Effect cause carries stack frames and, inside a
						// DatabaseError, connection details.
						Effect.catchCause((cause) =>
							Effect.fail(
								new MapleToolFailure({
									message: `${SUBMIT_DIAGNOSIS} failed: ${summarizeToolFailure(cause)}`,
								}),
							),
						),
					),
			},
			sessionAttributes,
		),
		submitted: () => submitted,
	} satisfies RunCompletion
}

/** The pull request a review session is about, which its diff tools always read. */
export interface SessionPullRequest {
	readonly repository: string
	readonly number: number
}

const PULL_REQUEST_TOOLS: ReadonlySet<string> = new Set(["pr_changed_files", "pr_context", "pr_file_diff"])

/**
 * All Maple tools, with mutating ones gated.
 *
 * A gated tool still carries a real handler (rather than being omitted) so the schema the model sees
 * is identical to the ungated case — but it refuses, and `ChatSession.settleProposal` remains the
 * only path that actually mutates.
 */
export const buildChatToolkit = (
	executor: McpToolExecutorApi,
	tenant: TenantContext,
	ruleset: PermissionRuleset,
	surface: McpToolSurface,
	sessionAttributes?: Readonly<Record<string, string>>,
	onAnswer?: (tool: string, answer: string) => void,
	onUi?: (toolCallId: string, ui: ToolUiPayload, call: UiSource) => void,
	pullRequest?: SessionPullRequest,
) =>
	buildMapleToolkit(executor, tenant, {
		surface,
		...(sessionAttributes === undefined ? undefined : { sessionAttributes }),
		...(onAnswer === undefined ? undefined : { onAnswer }),
		...(onUi === undefined ? undefined : { onUi }),
		...(pullRequest === undefined
			? undefined
			: {
					pinned: (name: string) =>
						PULL_REQUEST_TOOLS.has(name)
							? { repository: pullRequest.repository, number: pullRequest.number }
							: undefined,
				}),
		// `deny` means the model never sees the tool. That is a stronger guarantee than refusing the
		// call afterwards, and it is free — an unoffered tool cannot be called.
		include: (name) => evaluatePermission(ruleset, name) !== "deny",
		gate: (name) => evaluatePermission(ruleset, name) === "ask",
	})
