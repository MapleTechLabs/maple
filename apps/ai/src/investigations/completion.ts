import type { AiServiceError } from "@maple/domain/ai-service"
/** Structured report submission for an investigation conversation. */
import type { RunUsage } from "../runtime/usage"
import {
	AiTriageResult,
	InvestigationDataCorruptionError,
	InvestigationNotFoundError,
	InvestigationPersistenceError,
	SubmitDiagnosisRequest,
} from "@maple/domain/http"
import { InvestigationId, UserId } from "@maple/domain/primitives"
import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { MapleToolFailure, summarizeToolFailure } from "../runtime/llm-tools"
import type { ChatTurnTenant as TenantContext } from "@maple/domain/chat-session"

export type SubmitDiagnosis = (
	orgId: TenantContext["orgId"],
	investigationId: InvestigationId,
	request: SubmitDiagnosisRequest,
) => Effect.Effect<
	unknown,
	| InvestigationPersistenceError
	| InvestigationNotFoundError
	| InvestigationDataCorruptionError
	| AiServiceError
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
 * The `submit_diagnosis` tool for an investigation conversation.
 *
 * Its arguments ARE the structured report. Deliberately not approval-gated: it is the structured
 * output channel, not a user-facing mutation. The channel supplies the validated investigation id
 * and tenant, so the agent never chooses which investigation it writes.
 *
 * `submitDiagnosis` arrives as a callback rather than being resolved from `InvestigationService`
 * here: that service is itself what starts an investigation's autonomous run, so resolving it
 * through the requirements channel would make it require itself.
 */
export const buildDiagnosisCompletion = (
	investigationId: InvestigationId | undefined,
	tenant: TenantContext,
	submitDiagnosis: SubmitDiagnosis,
	usage: RunUsage,
	modelName: string,
) => {
	if (investigationId === undefined) return undefined
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
