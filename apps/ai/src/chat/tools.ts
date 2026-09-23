/**
 * What a chat run is allowed to call.
 *
 * Kept out of `loop/` on purpose: deciding *when* to call a tool is the engine's job, not this
 * module's. Swapping the tool set — a read-only sub-agent, a mode with narrower reach — should not
 * touch control flow at all.
 */
import {
	type ChatTurnOrigin,
	investigationIdFromChatSessionId,
	prReviewIdFromChatSessionId,
} from "@maple/domain/chat-session"
import { evaluatePermission, type PermissionRuleset } from "@maple/domain/permission"
import {
	AiTriageSubmission,
	InvestigationDataCorruptionError,
	InvestigationNotFoundError,
	InvestigationPersistenceError,
	normalizePrReviewSubmission,
	normalizeTriageSubmission,
	PrReviewId,
	PrReviewNotFoundError,
	PrReviewPersistenceError,
	PrReviewSubmission,
	SubmitDiagnosisRequest,
	SubmitPrReviewRequest,
} from "@maple/domain/http"
import { InvestigationId } from "@maple/domain/primitives"
import type { RunBudgetHook, RunUsageDelta } from "@effect-agent/engine/RunOptions"
import { Effect, type Layer, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import type { McpToolSurface } from "@maple/domain/mcp-manifest"
import { buildMapleToolkit, MapleToolFailure, summarizeToolFailure } from "../mcp/tools/llm-tools"
import { toolHandlersWithContent } from "../platform/genai-spans"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"

const decodeInvestigationIdOption = Schema.decodeUnknownOption(InvestigationId)
const decodePrReviewIdOption = Schema.decodeUnknownOption(PrReviewId)

export type SubmitDiagnosis = (
	orgId: TenantContext["orgId"],
	investigationId: InvestigationId,
	request: SubmitDiagnosisRequest,
) => Effect.Effect<
	unknown,
	InvestigationPersistenceError | InvestigationNotFoundError | InvestigationDataCorruptionError
>

export const SUBMIT_DIAGNOSIS = "submit_diagnosis"
export const SUBMIT_REVIEW = "submit_review"

export type SubmitReview = (
	orgId: TenantContext["orgId"],
	reviewId: PrReviewId,
	request: SubmitPrReviewRequest,
) => Effect.Effect<unknown, PrReviewPersistenceError | PrReviewNotFoundError>

/**
 * The tool a run answers through, and whether the run must answer through it.
 *
 * `submitted` is read by the turn runner after the run: a completion whose tool never landed is a
 * pass the runner closes out itself, because the engine is never told the tool is required.
 */
export interface RunCompletion {
	readonly tool: string
	readonly toolkit: Toolkit.Any
	readonly layer: Layer.Layer<never>
	/** The raw handlers, which tests drive directly. */
	readonly handlers: unknown
	readonly autonomous: boolean
	readonly submitted: () => boolean
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
}

export const makeRunUsage = (): RunUsage => ({ input: 0, output: 0, cacheRead: 0 })

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
		}),
})

/**
 * `parameters` is the lenient {@link AiTriageSubmission}, not the stored `AiTriageResult`.
 *
 * The engine decodes a tool call's arguments before the handler runs, and a decode failure lands in
 * the model stream's error channel, which ends the run. Against a strict report schema that made
 * one missing key at the end of a full investigation throw the whole investigation away. The
 * handler normalizes instead, and records what the model left out.
 */
export const diagnosisTool = Tool.make(SUBMIT_DIAGNOSIS, {
	description:
		"Record your structured diagnosis for THIS investigation. Call it exactly once, " +
		"after you have gathered evidence, with your final assessment. It persists the report " +
		"and renders it for the user. After calling it, stop unless the user asks a follow-up.",
	parameters: AiTriageSubmission,
	success: Schema.String,
	failure: MapleToolFailure,
})

/** The investigation a session belongs to, or `undefined` for an ordinary conversation. */
export const investigationForSession = (sessionId: string): InvestigationId | undefined => {
	const rawId = investigationIdFromChatSessionId(sessionId)
	if (!rawId) return undefined
	// An unparseable id simply means this conversation is not an investigation.
	return Option.getOrUndefined(decodeInvestigationIdOption(rawId))
}

/**
 * Whether this turn is an investigation's own autonomous pass rather than a person asking a
 * follow-up in the same session. The pass must end on `submit_diagnosis`; the follow-up may answer
 * in prose.
 *
 * Both halves are stated, not inferred: the session says it is an investigation, the turn's origin
 * says it is the unattended pass.
 */
export const isAutonomousInvestigationTurn = (sessionId: string, origin: ChatTurnOrigin): boolean =>
	investigationForSession(sessionId) !== undefined && origin.kind === "autonomous"

/** The pull request review a session belongs to, or `undefined` for any other conversation. */
export const prReviewForSession = (sessionId: string): PrReviewId | undefined => {
	const rawId = prReviewIdFromChatSessionId(sessionId)
	if (!rawId) return undefined
	return Option.getOrUndefined(decodePrReviewIdOption(rawId))
}

/** A review's own unattended pass; it must end on `submit_review`. */
export const isAutonomousReviewTurn = (sessionId: string, origin: ChatTurnOrigin): boolean =>
	prReviewForSession(sessionId) !== undefined && origin.kind === "autonomous"

/** Any machine-started pass the runner closes out itself: an investigation's or a review's. */
export const isAutonomousTurn = (sessionId: string, origin: ChatTurnOrigin): boolean =>
	isAutonomousInvestigationTurn(sessionId, origin) || isAutonomousReviewTurn(sessionId, origin)

/** `parameters` is the lenient {@link PrReviewSubmission}, for the reason `diagnosisTool`'s is. */
export const reviewTool = Tool.make(SUBMIT_REVIEW, {
	description:
		"Record your review of THIS pull request. Call it exactly once, after you have " +
		"read every hunk you review, with your verdict, coverage and line-anchored findings. It " +
		"persists the review and posts it to the pull request. After calling it, stop.",
	parameters: PrReviewSubmission,
	success: Schema.String,
	failure: MapleToolFailure,
})

/**
 * The `submit_review` tool for a review session (`"<orgId>:pr-<id>"`), built like
 * {@link buildDiagnosisCompletion}: the review id rides on the session, so the agent never chooses
 * which pull request its report is posted to. A connector never files one, for the same reason it
 * never files a diagnosis.
 */
export const buildReviewCompletion = (
	sessionId: string,
	tenant: TenantContext,
	origin: ChatTurnOrigin,
	submitReview: SubmitReview,
	usage: RunUsage,
	modelName: string,
	partial = false,
	sessionAttributes?: Readonly<Record<string, string>>,
) => {
	const reviewId = prReviewForSession(sessionId)
	if (reviewId === undefined) return undefined
	// Only the unattended pass files a review. A follow-up in the session answers in prose: the
	// row is already settled, and a second submission would be dropped while reporting success.
	if (origin.kind !== "autonomous") return undefined
	const toolkit = Toolkit.make(reviewTool)
	let submitted = false
	return {
		tool: SUBMIT_REVIEW,
		toolkit,
		...toolHandlersWithContent(
			toolkit,
			{
				[SUBMIT_REVIEW]: (submission: PrReviewSubmission) =>
					Effect.suspend(() => {
						const { report, filled, droppedFindings } = normalizePrReviewSubmission(submission)
						return submitReview(
							tenant.orgId,
							reviewId,
							new SubmitPrReviewRequest({
								report,
								model: modelName,
								inputTokens: usage.input,
								outputTokens: usage.output,
								...(partial ? { partial: true } : undefined),
							}),
						).pipe(
							Effect.tap(() =>
								Effect.annotateCurrentSpan({
									"maple.pr_review.filled_fields": filled.join(","),
									"maple.pr_review.filled_count": filled.length,
									"maple.pr_review.dropped_findings": droppedFindings,
									"maple.pr_review.findings": report.findings.length,
									"maple.pr_review.verdict": report.verdict,
								}),
							),
						)
					}).pipe(
						Effect.tap(() => Effect.sync(() => (submitted = true))),
						Effect.as("Review recorded."),
						Effect.catchCause((cause) =>
							Effect.fail(
								new MapleToolFailure({
									message: `${SUBMIT_REVIEW} failed: ${summarizeToolFailure(cause)}`,
								}),
							),
						),
					),
			},
			sessionAttributes,
		),
		autonomous: isAutonomousReviewTurn(sessionId, origin),
		submitted: () => submitted,
	} satisfies RunCompletion
}

/**
 * The `submit_diagnosis` tool for an investigate-mode session (`"<orgId>:inv-<id>"`).
 *
 * Its arguments ARE the structured report. Deliberately not approval-gated: it is the structured
 * output channel, not a user-facing mutation. The investigation id and org ride from the session id,
 * so the agent never chooses which investigation it writes. Being outside the ruleset is why the
 * origin is consulted here directly rather than left to the gate.
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
export const buildDiagnosisCompletion = (
	sessionId: string,
	tenant: TenantContext,
	origin: ChatTurnOrigin,
	submitDiagnosis: SubmitDiagnosis,
	usage: RunUsage,
	modelName: string,
	/** This run is the close-out: whatever it files is a partial, and lands as `inconclusive`. */
	partial = false,
	/** The run's agent-session identity, stamped on the tool span like every other tool's. */
	sessionAttributes?: Readonly<Record<string, string>>,
) => {
	const investigationId = investigationForSession(sessionId)
	if (investigationId === undefined) return undefined
	// A connector never files a diagnosis. This tool rides *outside* the ruleset — it is the
	// investigation's structured output channel, not a gated mutation — so nothing else withholds
	// it, and it does write: a report row, and the investigation's status. An attended follow-up in
	// the app may file one; a channel is not where a diagnosis gets settled.
	if (origin.kind === "connector") return undefined
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
							tenant.orgId,
							investigationId,
							new SubmitDiagnosisRequest({
								report,
								model: modelName,
								inputTokens: usage.input,
								outputTokens: usage.output,
								...(partial ? { partial: true } : undefined),
							}),
						).pipe(
							Effect.tap(() =>
								// What the model omitted is the signal that the prompt or the model is the
								// problem; without it a filled-in report is indistinguishable from a written one.
								Effect.annotateCurrentSpan({
									"maple.diagnosis.filled_fields": filled.join(","),
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
		autonomous: isAutonomousInvestigationTurn(sessionId, origin),
		submitted: () => submitted,
	} satisfies RunCompletion
}

/**
 * All Maple tools, with mutating ones gated.
 *
 * A gated tool still carries a real handler (rather than being omitted) so the schema the model sees
 * is identical to the ungated case — but it refuses, and `POST /internal/chat/apply` remains the
 * only path that actually mutates.
 */
export const buildChatToolkit = (
	executor: McpToolExecutorApi,
	tenant: TenantContext,
	ruleset: PermissionRuleset,
	surface: McpToolSurface,
	sessionAttributes?: Readonly<Record<string, string>>,
) =>
	buildMapleToolkit(executor, tenant, {
		surface,
		...(sessionAttributes === undefined ? undefined : { sessionAttributes }),
		// `deny` means the model never sees the tool. That is a stronger guarantee than refusing the
		// call afterwards, and it is free — an unoffered tool cannot be called.
		include: (name) => evaluatePermission(ruleset, name) !== "deny",
		gate: (name) => evaluatePermission(ruleset, name) === "ask",
	})
