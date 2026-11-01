import { AiTriageResult } from "@maple/domain/http"
import { Option, Schema } from "effect"

/**
 * An investigation's `submit_diagnosis` output (apps/ai/src/chat/tools.ts): the report, already
 * persisted server-side (not a proposal), drawn as the inline report card.
 */
export interface DiagnosisMarker {
	status: "diagnosis"
	report: AiTriageResult
}

const decodeReport = Schema.decodeUnknownOption(AiTriageResult)

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
	if (v.status !== "diagnosis") return null
	return Option.match(decodeReport(v.report), {
		onNone: () => null,
		onSome: (report) => ({ status: "diagnosis", report }),
	})
}
