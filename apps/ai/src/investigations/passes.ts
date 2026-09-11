import { makeChatSessionId } from "@maple/domain/chat-session"
import {
	AiTriageResult,
	InvestigationSubject,
	InvestigationSubjectSnapshot,
	InvestigationPlan,
	LensCandidate,
	LensVerdict,
} from "@maple/domain/http"
import type {
	InvokePlannerInput,
	InvokePlannerOutput,
	InvokeHypothesisInput,
	InvokeHypothesisOutput,
	InvokeValidatorInput,
	InvokeValidatorOutput,
} from "@maple/domain/ai-service"
import { Effect, Option, Schema, type Context } from "effect"
import {
	type LlmCallTags,
	type LlmClients,
	type LlmEnv,
	resolveTriageModel,
	resolveLensModel,
} from "../platform/Llm"
import type { ToolExecutor } from "../runtime/tool-executor"
import { runPlannerAgent } from "./planner-agent"
import { runHypothesisAgent, runSoloHypothesisAgent } from "./hypothesis-agent"
import { runValidatorAgent } from "./validator-agent"

type AgentServices = LlmClients | ToolExecutor
const decodeSubject = Schema.decodeUnknownEffect(InvestigationSubject)
const decodeSnapshotOption = Schema.decodeUnknownOption(InvestigationSubjectSnapshot)
const decodeLensVerdictOption = Schema.decodeUnknownOption(LensVerdict)
const encodeReport = Schema.encodeSync(AiTriageResult)
const snapshotOrNull = (snapshot: unknown) => Option.getOrNull(decodeSnapshotOption(snapshot))
const investigationTags = (
	surface: LlmCallTags["surface"],
	orgId: string,
	investigationId: string,
	pass: string,
): LlmCallTags => ({
	surface,
	orgId,
	sessionId: makeChatSessionId(orgId, `inv-${investigationId}`),
	turnId: `inv_${investigationId}_${pass}`,
	workflowName: "investigation",
})

export const plannerOn =
	(agents: Context.Context<AgentServices>, env: LlmEnv) =>
	(input: InvokePlannerInput): Effect.Effect<InvokePlannerOutput, Schema.SchemaError> =>
		Effect.gen(function* () {
			const subject = yield* decodeSubject(input.subject)
			const output = yield* runPlannerAgent({
				investigationId: input.investigationId,
				subject,
				snapshot: snapshotOrNull(input.snapshot),
				// The strong model. One pass decides how the whole run is spent: a bad plan
				// wastes every lane downstream of it, which is far more expensive than the
				// difference between the two tiers.
				model: resolveTriageModel(
					env,
					investigationTags("ai-triage", input.orgId, input.investigationId, "plan"),
				),
				deadlineAtMs: input.deadlineAtMs,
			}).pipe(Effect.provideContext(agents))
			return {
				plan: Option.isSome(output.plan)
					? Schema.encodeSync(InvestigationPlan)(output.plan.value)
					: null,
				model: output.model,
				inputTokens: output.usage.input,
				outputTokens: output.usage.output,
				toolCount: output.toolSteps,
			}
		})

export const hypothesisOn =
	(agents: Context.Context<AgentServices>, env: LlmEnv) =>
	(input: InvokeHypothesisInput): Effect.Effect<InvokeHypothesisOutput, Schema.SchemaError> =>
		Effect.gen(function* () {
			const agentInput = {
				investigationId: input.investigationId,
				hypothesis: input.hypothesis,
				scopeSummary: input.scopeSummary,
				subject: yield* decodeSubject(input.subject),
				snapshot: snapshotOrNull(input.snapshot),
				model: resolveLensModel(
					env,
					investigationTags(
						"investigation-lens",
						input.orgId,
						input.investigationId,
						input.hypothesis.id,
					),
				),
				deadlineAtMs: input.deadlineAtMs,
				rerun: input.rerun,
			}

			if (input.solo) {
				const output = yield* runSoloHypothesisAgent(agentInput).pipe(Effect.provideContext(agents))
				const report = Option.getOrNull(output.report)
				// Encoded for the same reason the validator's is: this leaves the lane as a
				// plain JSON value, both for the `jsonb` write and for anything that carries
				// it across a step boundary later.
				const encodedReport = report === null ? null : encodeReport(report)
				return {
					// The collapsed path has no candidate to rank, but the lane row still
					// renders: the claim slot carries the published cause so the Hypotheses tab
					// shows what was tested rather than an empty lane next to a verdict.
					claim: report?.suspectedCause ?? null,
					mechanism: null,
					confidence: report?.confidence ?? null,
					selfDoubt: null,
					suggestedActions: report?.suggestedActions ?? [],
					evidence: encodedReport?.evidence ?? [],
					report: encodedReport,
					model: output.model,
					inputTokens: output.usage.input,
					outputTokens: output.usage.output,
					toolCount: output.toolSteps,
					deadlineHit: output.deadlineHit,
				}
			}

			const output = yield* runHypothesisAgent(agentInput).pipe(Effect.provideContext(agents))
			// A lane that reached no candidate is a real result, not a failure — the
			// workflow records it as a `no_finding` lane and the validator is told it
			// reported nothing.
			const candidate = Option.isSome(output.candidate)
				? Schema.encodeSync(LensCandidate)(output.candidate.value)
				: undefined
			return {
				claim: candidate?.claim ?? null,
				mechanism: candidate?.mechanism ?? null,
				confidence: candidate?.confidence ?? null,
				selfDoubt: candidate?.selfDoubt ?? null,
				suggestedActions: candidate?.suggestedActions ?? [],
				evidence: candidate?.evidence ?? [],
				report: null,
				model: output.model,
				inputTokens: output.usage.input,
				outputTokens: output.usage.output,
				toolCount: output.toolSteps,
				deadlineHit: output.deadlineHit,
			}
		})

export const validatorOn =
	(agents: Context.Context<AgentServices>, env: LlmEnv) =>
	(input: InvokeValidatorInput): Effect.Effect<InvokeValidatorOutput, Schema.SchemaError> =>
		Effect.gen(function* () {
			const subject = yield* decodeSubject(input.subject)
			const output = yield* runValidatorAgent({
				investigationId: input.investigationId,
				subject,
				snapshot: snapshotOrNull(input.snapshot),
				candidates: input.candidates,
				// The validator runs on the strong model even when lanes run cheap: it
				// does the reasoning the whole fan-out exists to enable.
				model: resolveTriageModel(
					env,
					investigationTags(
						"investigation-validator",
						input.orgId,
						input.investigationId,
						"validator",
					),
				),
				deadlineAtMs: input.deadlineAtMs,
			}).pipe(Effect.provideContext(agents))
			return {
				promotedLensId: output.verdict.promotedLensId,
				report: output.verdict.report === null ? null : encodeReport(output.verdict.report),
				rivals: output.verdict.rivals.map((rival) => ({
					lensId: rival.lensId,
					// A verdict outside the lens alphabet is the validator not ranking the
					// lane, which `validate` records as rejected.
					verdict: Option.getOrElse(
						decodeLensVerdictOption(rival.verdict),
						(): LensVerdict => "rejected",
					),
					reason: rival.reason,
				})),
				note: output.verdict.note,
				model: output.model,
				inputTokens: output.usage.input,
				outputTokens: output.usage.output,
			}
		})
