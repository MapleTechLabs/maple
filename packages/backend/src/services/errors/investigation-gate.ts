/**
 * Whether an incident is worth an investigation's model pass.
 *
 * The decision model answers before the LLM is reached (see
 * `incident-triage.ts` in the domain); this module is the policy that turns its
 * verdict into a start or a refusal. Pure, like {@link
 * evaluateInvestigationQuota} beside it, so the whole table is testable without
 * a database or a model.
 */
import type { IncidentTriageVerdict, IssueSeverity } from "@maple/domain/http"

/**
 * How sure the model has to be before its "noise" costs an incident its pass.
 *
 * Jev returns a full distribution, so this is a real threshold rather than a
 * formality: a 0.55/0.45 split between `noise` and `investigate` is the model
 * saying it does not know, and the cheap mistake there is to investigate.
 */
export const NOISE_CONFIDENCE_FLOOR = 0.8

/**
 * Severities the gate will not refuse on a model's word alone.
 *
 * The detector saw the signal; the classifier only reads a summary of it. When
 * they disagree about something the detector already called urgent, the
 * detector wins and a human sees a diagnosis they can dismiss — the opposite
 * failure is an outage nobody investigated because a summary read as boring.
 */
const UNSKIPPABLE_SEVERITIES: ReadonlySet<IssueSeverity> = new Set<IssueSeverity>([
	"critical",
	"high",
])

export type IncidentGateVerdict =
	| {
			readonly kind: "investigate"
			/** Severity to judge the quota by and to record on the run. */
			readonly severity: IssueSeverity | null
			readonly classification: IncidentTriageVerdict | null
	  }
	| {
			readonly kind: "skip"
			readonly classification: IncidentTriageVerdict
	  }

/**
 * `verdict` absent means the classifier is off, unreachable or failed. That
 * always reads as investigate: a broken classifier must not silently become a
 * policy of dropping incidents.
 *
 * `force` is the manual path — a human asked for this investigation, so the
 * model does not get to refuse it, though its severity is still used.
 */
export const evaluateIncidentGate = (input: {
	readonly verdict: IncidentTriageVerdict | null | undefined
	readonly detectorSeverity: IssueSeverity | null | undefined
	readonly force?: boolean
}): IncidentGateVerdict => {
	const detectorSeverity = input.detectorSeverity ?? null
	const verdict = input.verdict ?? null
	if (verdict === null) {
		return { kind: "investigate", severity: detectorSeverity, classification: null }
	}

	// The detector's severity is the floor, not the answer: the model may raise
	// it, and a model that lowers an urgent one is overruled below anyway.
	const severity = mostSevere(detectorSeverity, verdict.severity)

	const refusable =
		verdict.disposition === "noise" &&
		verdict.dispositionConfidence >= NOISE_CONFIDENCE_FLOOR &&
		!(detectorSeverity !== null && UNSKIPPABLE_SEVERITIES.has(detectorSeverity))

	if (refusable && input.force !== true) return { kind: "skip", classification: verdict }
	return { kind: "investigate", severity, classification: verdict }
}

const SEVERITY_RANK = {
	critical: 4,
	high: 3,
	medium: 2,
	low: 1,
} satisfies Record<IssueSeverity, number>

/** The higher of the two, with `null` losing to anything. */
export const mostSevere = (
	left: IssueSeverity | null,
	right: IssueSeverity | null,
): IssueSeverity | null => {
	if (left === null) return right
	if (right === null) return left
	return SEVERITY_RANK[left] >= SEVERITY_RANK[right] ? left : right
}
