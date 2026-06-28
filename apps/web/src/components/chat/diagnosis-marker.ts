import type { AiTriageResult } from "@maple/domain/http"

/**
 * Investigate-mode emits the structured report through the local `submit_diagnosis`
 * tool, whose output is this marker (NOT a proposal — it has already been
 * persisted server-side). The web renders it as the inline report card. Mirrors
 * the shape returned by `apps/chat-flue/src/lib/submit-diagnosis.ts`.
 */
export interface DiagnosisMarker {
	status: "diagnosis"
	report: AiTriageResult
}

const isReport = (value: unknown): value is AiTriageResult =>
	!!value &&
	typeof value === "object" &&
	typeof (value as Record<string, unknown>).summary === "string" &&
	typeof (value as Record<string, unknown>).suspectedCause === "string" &&
	Array.isArray((value as Record<string, unknown>).suggestedActions)

/** Parse a `submit_diagnosis` tool output into a {@link DiagnosisMarker}, or `null`. */
export const parseDiagnosisMarker = (output: unknown): DiagnosisMarker | null => {
	let value: unknown = output
	if (typeof output === "string") {
		try {
			value = JSON.parse(output)
		} catch {
			return null
		}
	}
	if (!value || typeof value !== "object") return null
	const v = value as Record<string, unknown>
	return v.status === "diagnosis" && isReport(v.report)
		? { status: "diagnosis", report: v.report }
		: null
}
