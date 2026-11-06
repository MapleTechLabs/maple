import type { AlertEscalationRunStatus, EscalationStep, EscalationSteps } from "@maple/domain/http"

/**
 * Escalation chains: an incident walks a chain's steps, each notifying its targets and waiting
 * `waitMinutes` for an acknowledgement before the next. Pure; the scheduler applies the plan
 * with a compare-and-set on (stepIndex, passIndex) so each step is sent at most once.
 */

/** How long a silenced run waits before the scheduler looks at it again. */
export const ESCALATION_SILENCE_RECHECK_MS = 60_000

export interface EscalationRunPosition {
	readonly status: AlertEscalationRunStatus
	readonly steps: EscalationSteps
	readonly repeatCount: number
	readonly stepIndex: number
	readonly passIndex: number
	readonly nextStepAt: number
}

export interface EscalationIncidentState {
	readonly open: boolean
	readonly acknowledged: boolean
	/** A silence covers the incident right now. */
	readonly silenced: boolean
}

export type EscalationAdvancePlan =
	/** Nothing to write: not due, or already paused for the same reason. */
	| { readonly kind: "wait" }
	/** The incident resolved, or the position is past the chain: the run ends without sending. */
	| { readonly kind: "end"; readonly status: "resolved" | "exhausted" }
	/** Someone acknowledged: the run holds its place until an unacknowledge. */
	| { readonly kind: "pause" }
	/** Unacknowledged before the step was due: the run goes back to waiting. */
	| { readonly kind: "resume" }
	/** Due but silenced: look again later, sending nothing. Leaves an acknowledged run active. */
	| { readonly kind: "defer"; readonly nextStepAt: number }
	/** Send `step`, then move to the next position, or end when the chain is spent. */
	| {
			readonly kind: "send"
			readonly step: EscalationStep
			readonly stepIndex: number
			readonly passIndex: number
			readonly next:
				| {
						readonly kind: "step"
						readonly stepIndex: number
						readonly passIndex: number
						readonly nextStepAt: number
				  }
				| { readonly kind: "exhausted" }
	  }

const nextPosition = (
	run: EscalationRunPosition,
	step: EscalationStep,
	nowMs: number,
): Extract<EscalationAdvancePlan, { kind: "send" }>["next"] => {
	const nextStepAt = nowMs + step.waitMinutes * 60_000
	if (run.stepIndex + 1 < run.steps.length) {
		return { kind: "step", stepIndex: run.stepIndex + 1, passIndex: run.passIndex, nextStepAt }
	}
	if (run.passIndex < run.repeatCount) {
		return { kind: "step", stepIndex: 0, passIndex: run.passIndex + 1, nextStepAt }
	}
	return { kind: "exhausted" }
}

export const planEscalationAdvance = (
	run: EscalationRunPosition,
	incident: EscalationIncidentState,
	nowMs: number,
): EscalationAdvancePlan => {
	if (run.status !== "active" && run.status !== "acknowledged") return { kind: "wait" }
	if (!incident.open) return { kind: "end", status: "resolved" }
	if (incident.acknowledged) return run.status === "acknowledged" ? { kind: "wait" } : { kind: "pause" }
	const due = run.nextStepAt <= nowMs
	if (run.status === "acknowledged" && !due) return { kind: "resume" }
	if (!due) return { kind: "wait" }
	if (incident.silenced) return { kind: "defer", nextStepAt: nowMs + ESCALATION_SILENCE_RECHECK_MS }
	const step = run.steps[run.stepIndex]
	// A position past the snapshot cannot be sent; treat the chain as spent.
	if (step === undefined) return { kind: "end", status: "exhausted" }
	return {
		kind: "send",
		step,
		stepIndex: run.stepIndex,
		passIndex: run.passIndex,
		next: nextPosition(run, step, nowMs),
	}
}

/** Total steps a chain sends when nobody acknowledges. */
export const escalationStepCount = (steps: EscalationSteps, repeatCount: number): number =>
	steps.length * (repeatCount + 1)
