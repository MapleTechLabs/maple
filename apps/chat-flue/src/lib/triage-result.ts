import * as v from "valibot"

// Valibot mirror of @maple/domain/http `AiTriageResult` (an Effect Schema). Flue's
// `session.prompt(msg, { result })` validates the model's structured output
// against this — replacing the legacy `submit_triage` tool. Keep the field set
// and the severity/confidence literals in sync with packages/domain/src/http/ai-triage.ts.

export const AiTriageEvidenceSchema = v.object({
	traceIds: v.array(v.string()),
	logPatterns: v.array(v.string()),
	relatedServices: v.array(v.string()),
	note: v.string(),
})

/** Shares the canonical IssueSeverity literal (packages/domain/src/http/errors.ts). */
export const IssueSeveritySchema = v.picklist(["critical", "high", "medium", "low"])

export const AiTriageResultSchema = v.object({
	summary: v.string(),
	suspectedCause: v.string(),
	severityAssessment: IssueSeveritySchema,
	affectedScope: v.string(),
	evidence: v.array(AiTriageEvidenceSchema),
	suggestedActions: v.array(v.string()),
	confidence: v.picklist(["high", "medium", "low"]),
})

export type AiTriageResult = v.InferOutput<typeof AiTriageResultSchema>
