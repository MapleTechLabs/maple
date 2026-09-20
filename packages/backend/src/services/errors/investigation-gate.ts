/**
 * Whether an incident is worth an investigation's model pass.
 *
 * Two policies, cheapest first, both pure like {@link evaluateInvestigationQuota}
 * beside them so the whole table is testable without a database or a model:
 *
 *   - {@link evaluateIssueGate} reads what Maple already knows about the issue
 *     the incident opened under. No model call. This is where the repeats die:
 *     an error incident auto-resolves after thirty quiet minutes and the next
 *     occurrence opens a fresh one, so an issue that fires on a retry cadence
 *     opened 83 incidents in five days and was diagnosed, identically, on
 *     fifteen of them (internal org, `CheckpointCreateError`, 2026-09-15..20).
 *   - {@link evaluateIncidentGate} turns the decision model's verdict (see
 *     `incident-triage.ts` in the domain) into a start or a refusal.
 */
import type {
	AiTriageIncidentKind,
	IncidentTriageVerdict,
	IssueSeverity,
	WorkflowState,
} from "@maple/domain/http"
import type { InvestigationId } from "@maple/domain/primitives"
import { STALE_MS } from "@maple/backend/services/errors/investigation-stale"

/**
 * How sure the model has to be before its "noise" costs an incident its pass.
 *
 * Jev returns a full distribution, so this is a real threshold rather than a
 * formality: a 0.55/0.45 split between `noise` and `investigate` is the model
 * saying it does not know, and the cheap mistake there is to investigate.
 */
export const NOISE_CONFIDENCE_FLOOR = 0.8

/**
 * How sure the model has to be that a diagnosis on file already explains this
 * incident. Higher than the noise floor: a wrong "noise" costs one diagnosis,
 * a wrong "same as that one" points a responder at the wrong report.
 */
export const PRIOR_MATCH_FLOOR = 0.85

/**
 * How long a diagnosis on an issue is taken as still answering for it.
 *
 * Errors keep it for a week: the fingerprint is the cause's identity, and a
 * regression, which is the one way the answer changes, opens with its own
 * reason and bypasses this. Alerts and anomalies are re-asked after a day: the
 * same rule firing on a different day is often a different cause.
 */
export const REINVESTIGATE_AFTER_MS = {
	error: 7 * 24 * 60 * 60 * 1000,
	alert: 24 * 60 * 60 * 1000,
	anomaly: 24 * 60 * 60 * 1000,
} satisfies Record<AiTriageIncidentKind, number>

/**
 * Severities the gate will not refuse on a model's word alone.
 *
 * The detector saw the signal; the classifier only reads a summary of it. When
 * they disagree about something the detector already called urgent, the
 * detector wins and a human sees a diagnosis they can dismiss — the opposite
 * failure is an outage nobody investigated because a summary read as boring.
 */
const UNSKIPPABLE_SEVERITIES: ReadonlySet<IssueSeverity> = new Set<IssueSeverity>(["critical", "high"])

/**
 * The states in which an issue is nobody's yet. Everything else means a person
 * or an agent has taken it (`todo` onwards) or closed it, and a fresh diagnosis
 * on every flare-up tells them nothing they are not already acting on.
 */
const OPEN_FOR_TRIAGE: ReadonlySet<WorkflowState> = new Set<WorkflowState>(["triage", "regressed"])

export type IssueGateSkipReason = "issue_handled" | "investigation_in_flight" | "recently_diagnosed"

export type IssueGateVerdict =
	| { readonly kind: "investigate" }
	| {
			readonly kind: "skip"
			readonly reason: IssueGateSkipReason
			/** The run that already answers for this issue, when the skip is about one. */
			readonly priorInvestigationId: InvestigationId | null
	  }

export interface LatestIssueInvestigation {
	readonly id: InvestigationId
	readonly status: string
	readonly createdAtMs: number
	readonly startedAtMs: number | null
}

/**
 * What the issue's own history says about starting another run.
 *
 * `workflowState` null means the incident has no issue (a free-standing
 * anomaly), which gates nothing here. `reason` is the incident's open reason;
 * `regression` is the one that makes an old diagnosis stale on purpose — the
 * issue was resolved and came back, so the question is genuinely new.
 *
 * `force` is the manual path and is never refused.
 */
export const evaluateIssueGate = (input: {
	readonly workflowState: WorkflowState | null
	readonly reason: string | null
	readonly latest: LatestIssueInvestigation | null
	readonly incidentKind: AiTriageIncidentKind
	readonly nowMs: number
	readonly force?: boolean
}): IssueGateVerdict => {
	if (input.force === true) return { kind: "investigate" }

	if (input.workflowState !== null && !OPEN_FOR_TRIAGE.has(input.workflowState)) {
		return { kind: "skip", reason: "issue_handled", priorInvestigationId: input.latest?.id ?? null }
	}

	const latest = input.latest
	if (latest === null) return { kind: "investigate" }

	// A pass already under way answers for this flare-up too. One that has
	// outlived its budget is not under way, whatever the row says: the tick's
	// sweep will fail it, and waiting on it would hold the issue hostage.
	if (latest.status === "investigating") {
		const fresh = latest.startedAtMs === null || latest.startedAtMs >= input.nowMs - STALE_MS
		if (fresh) return { kind: "skip", reason: "investigation_in_flight", priorInvestigationId: latest.id }
		return { kind: "investigate" }
	}

	if (input.reason === "regression") return { kind: "investigate" }

	const answered = latest.status === "diagnosed" || latest.status === "inconclusive"
	if (answered && latest.createdAtMs >= input.nowMs - REINVESTIGATE_AFTER_MS[input.incidentKind]) {
		return { kind: "skip", reason: "recently_diagnosed", priorInvestigationId: latest.id }
	}
	return { kind: "investigate" }
}

export type IncidentGateSkipReason = "noise" | "covered_by_prior"

export type IncidentGateVerdict =
	| {
			readonly kind: "investigate"
			/** Severity to judge the quota by and to record on the run. */
			readonly severity: IssueSeverity | null
			readonly classification: IncidentTriageVerdict | null
	  }
	| {
			readonly kind: "skip"
			readonly reason: IncidentGateSkipReason
			readonly classification: IncidentTriageVerdict
			/** The diagnosis this incident is read as a flare-up of, for `covered_by_prior`. */
			readonly priorInvestigationId: InvestigationId | null
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
	const investigate = { kind: "investigate", severity, classification: verdict } as const

	if (input.force === true) return investigate
	if (detectorSeverity !== null && UNSKIPPABLE_SEVERITIES.has(detectorSeverity)) return investigate

	const prior = verdict.matchedPrior ?? null
	if (prior !== null && prior.probability >= PRIOR_MATCH_FLOOR) {
		return {
			kind: "skip",
			reason: "covered_by_prior",
			classification: verdict,
			priorInvestigationId: prior.investigationId,
		}
	}
	if (verdict.disposition === "noise" && verdict.dispositionConfidence >= NOISE_CONFIDENCE_FLOOR) {
		return { kind: "skip", reason: "noise", classification: verdict, priorInvestigationId: null }
	}
	return investigate
}

const SEVERITY_RANK = {
	critical: 4,
	high: 3,
	medium: 2,
	low: 1,
} satisfies Record<IssueSeverity, number>

/** The higher of the two, with `null` losing to anything. */
export const mostSevere = (left: IssueSeverity | null, right: IssueSeverity | null): IssueSeverity | null => {
	if (left === null) return right
	if (right === null) return left
	return SEVERITY_RANK[left] >= SEVERITY_RANK[right] ? left : right
}
