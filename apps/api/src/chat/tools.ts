/**
 * What a chat run is allowed to call.
 *
 * Kept out of `loop/` on purpose: deciding *when* to call a tool is the engine's job, not this
 * module's. Swapping the tool set — a read-only sub-agent, a mode with narrower reach — should not
 * touch control flow at all.
 */
import { investigationIdFromChatSessionId } from "@maple/domain/chat-session"
import { evaluatePermission, type PermissionRuleset } from "@maple/domain/permission"
import {
	AiTriageResult,
	InvestigationDataCorruptionError,
	InvestigationNotFoundError,
	InvestigationPersistenceError,
	SubmitDiagnosisRequest,
} from "@maple/domain/http"
import { InvestigationId, UserId } from "@maple/domain/primitives"
import { Effect, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import type { McpToolExecutorApi, McpToolSurface } from "@/mcp/dispatcher"
import { buildMapleToolkit, MapleToolFailure, summarizeToolFailure } from "@/mcp/tools/llm-tools"
import type { TenantContext } from "@/services/auth/tenant-context"

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

export const diagnosisTool = Tool.make(SUBMIT_DIAGNOSIS, {
	description:
		"Record your structured diagnosis for THIS investigation. Call it exactly once, " +
		"after you have gathered evidence, with your final assessment. It persists the report " +
		"and renders it for the user. After calling it, stop unless the user asks a follow-up.",
	parameters: AiTriageResult,
	success: Schema.String,
	failure: MapleToolFailure,
})

/**
 * The `submit_diagnosis` tool for an investigate-mode session (`"<orgId>:inv-<id>"`).
 *
 * Its arguments ARE the structured report. Deliberately not approval-gated: it is the structured
 * output channel, not a user-facing mutation. The investigation id and org ride from the session id,
 * so the agent never chooses which investigation it writes.
 *
 * `submitDiagnosis` arrives as a callback rather than being resolved from `InvestigationService`
 * here: that service is itself what starts an investigation's autonomous run, so resolving it
 * through the requirements channel would make it require itself.
 */
export const buildDiagnosisCompletion = (
	sessionId: string,
	tenant: TenantContext,
	submitDiagnosis: SubmitDiagnosis,
	usage: RunUsage,
	modelName: string,
) => {
	const rawId = investigationIdFromChatSessionId(sessionId)
	if (!rawId) return undefined
	// An unparseable id simply means this conversation is not an investigation, so it gets no tool.
	const decoded = decodeInvestigationIdOption(rawId)
	if (Option.isNone(decoded)) return undefined
	const investigationId = decoded.value
	const toolkit = Toolkit.make(diagnosisTool)
	return {
		toolkit,
		layer: toolkit.toLayer({
			[SUBMIT_DIAGNOSIS]: (report: AiTriageResult) =>
				submitDiagnosis(
					tenant.orgId,
					investigationId,
					new SubmitDiagnosisRequest({
						report,
						model: modelName,
						inputTokens: usage.input,
						outputTokens: usage.output,
					}),
				).pipe(
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
		/**
		 * The autonomous pass answers *through* this tool, so the run has to close on it: it is the
		 * only thing that writes `investigations.diagnosis`, and a pass that spends its turns
		 * gathering evidence and then answers in prose files nothing at all.
		 *
		 * A human follow-up in the same session gets the same tool and no completion declaration. It
		 * *may* file a superseding diagnosis, but "what did you mean by the pool?" must be answerable
		 * in prose — requiring the close there would rewrite the report every time someone asked.
		 */
		required: tenant.userId === INTERNAL_SERVICE_USER_ID,
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
) =>
	buildMapleToolkit(executor, tenant, {
		surface,
		// `deny` means the model never sees the tool. That is a stronger guarantee than refusing the
		// call afterwards, and it is free — an unoffered tool cannot be called.
		include: (name) => evaluatePermission(ruleset, name) !== "deny",
		gate: (name) => evaluatePermission(ruleset, name) === "ask",
	})
