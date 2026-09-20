/**
 * What a chat run is allowed to call.
 *
 * Kept out of `loop/` on purpose: deciding *when* to call a tool is the engine's job, not this
 * module's. Swapping the tool set — a read-only sub-agent, a mode with narrower reach — should not
 * touch control flow at all.
 */
import { CHAT_BOT_USER_ID, investigationIdFromChatSessionId } from "@maple/domain/chat-session"
import { evaluatePermission, type PermissionRuleset } from "@maple/domain/permission"
import {
	AiTriageSubmission,
	InvestigationDataCorruptionError,
	InvestigationNotFoundError,
	InvestigationPersistenceError,
	normalizeTriageSubmission,
	SubmitDiagnosisRequest,
} from "@maple/domain/http"
import { InvestigationId, UserId } from "@maple/domain/primitives"
import type { RunBudgetHook, RunUsageDelta } from "@effect-agent/engine/RunOptions"
import { Effect, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import type { McpToolSurface } from "@maple/domain/mcp-manifest"
import { buildMapleToolkit, MapleToolFailure, summarizeToolFailure } from "../mcp/tools/llm-tools"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"

const decodeInvestigationIdOption = Schema.decodeUnknownOption(InvestigationId)

export type SubmitDiagnosis = (
	orgId: TenantContext["orgId"],
	investigationId: InvestigationId,
	request: SubmitDiagnosisRequest,
) => Effect.Effect<
	unknown,
	InvestigationPersistenceError | InvestigationNotFoundError | InvestigationDataCorruptionError
>

/**
 * The user id every machine-started run runs as.
 *
 * An investigation's own autonomous pass is claimed under this actor; a human opening the same
 * session and asking a follow-up is not. That difference decides whether the diagnosis tool merely
 * exists or is the run's *answer*.
 */
const INTERNAL_SERVICE_USER_ID = Schema.decodeSync(UserId)("internal-service")

export const SUBMIT_DIAGNOSIS = "submit_diagnosis"

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
 * Whether this turn is an investigation's own autonomous pass — claimed under the internal actor —
 * rather than a person asking a follow-up in the same session. The pass must end on
 * `submit_diagnosis`; the follow-up may answer in prose.
 */
export const isAutonomousInvestigationTurn = (sessionId: string, tenant: TenantContext): boolean =>
	investigationForSession(sessionId) !== undefined && tenant.userId === INTERNAL_SERVICE_USER_ID

/**
 * The `submit_diagnosis` tool for an investigate-mode session (`"<orgId>:inv-<id>"`).
 *
 * Its arguments ARE the structured report. Deliberately not approval-gated: it is the structured
 * output channel, not a user-facing mutation. The investigation id and org ride from the session id,
 * so the agent never chooses which investigation it writes. Being outside the ruleset is why the
 * bot actor is refused here by name rather than left to `READ_ONLY_RULESET`.
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
	submitDiagnosis: SubmitDiagnosis,
	usage: RunUsage,
	modelName: string,
	/** This run is the close-out: whatever it files is a partial, and lands as `inconclusive`. */
	partial = false,
) => {
	const investigationId = investigationForSession(sessionId)
	if (investigationId === undefined) return undefined
	// The bot never files a diagnosis. This tool rides *outside* the ruleset — it is the
	// investigation's structured output channel, not a gated mutation — so `READ_ONLY_RULESET`
	// alone does not withhold it, and it does write: a report row, and the investigation's status.
	// Only a session id built as an investigation's while carrying the bot actor could reach here,
	// which is exactly the mismatch the actor check in `turnToolPolicy` exists to refuse.
	if (tenant.userId === CHAT_BOT_USER_ID) return undefined
	const toolkit = Toolkit.make(diagnosisTool)
	let submitted = false
	return {
		toolkit,
		layer: toolkit.toLayer({
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
		}),
		autonomous: isAutonomousInvestigationTurn(sessionId, tenant),
		submitted: () => submitted,
	}
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
	surface: McpToolSurface = "chat",
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
