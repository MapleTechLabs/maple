import { AlertDestinationId, type EscalationSteps } from "@maple/domain/http"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
	ESCALATION_SILENCE_RECHECK_MS,
	type EscalationIncidentState,
	type EscalationRunPosition,
	escalationStepCount,
	planEscalationAdvance,
} from "./escalation"

const destinationIds = {
	slack: "00000000-0000-4000-8000-000000000001",
	pagerduty: "00000000-0000-4000-8000-000000000002",
	email: "00000000-0000-4000-8000-000000000003",
}
const destination = (name: keyof typeof destinationIds) => ({
	type: "destination" as const,
	destinationId: Schema.decodeSync(AlertDestinationId)(destinationIds[name]),
})

// Slack, wait 10; PagerDuty, wait 15; email, wait 15.
const steps: EscalationSteps = [
	{ targets: [destination("slack")], waitMinutes: 10 },
	{ targets: [destination("pagerduty")], waitMinutes: 15 },
	{ targets: [destination("email")], waitMinutes: 15 },
]

const T0 = Date.UTC(2026, 10, 6, 14, 0)
const minutes = (n: number) => T0 + n * 60_000

const run = (overrides: Partial<EscalationRunPosition> = {}): EscalationRunPosition => ({
	status: "active",
	steps,
	repeatCount: 0,
	stepIndex: 0,
	passIndex: 0,
	nextStepAt: T0,
	...overrides,
})

const firing: EscalationIncidentState = { open: true, acknowledged: false, silenced: false }

describe("planEscalationAdvance", () => {
	it("sends the due step and schedules the next one its wait later", () => {
		const plan = planEscalationAdvance(run(), firing, T0)
		expect(plan).toMatchObject({
			kind: "send",
			stepIndex: 0,
			passIndex: 0,
			step: { targets: [{ destinationId: destinationIds.slack }] },
			next: { kind: "step", stepIndex: 1, passIndex: 0, nextStepAt: minutes(10) },
		})
	})

	it("waits until the step is due", () => {
		expect(
			planEscalationAdvance(run({ stepIndex: 1, nextStepAt: minutes(10) }), firing, minutes(9)),
		).toEqual({
			kind: "wait",
		})
	})

	it("counts the wait from when a late step was actually sent", () => {
		const plan = planEscalationAdvance(
			run({ stepIndex: 1, nextStepAt: minutes(10) }),
			firing,
			minutes(11),
		)
		expect(plan).toMatchObject({ kind: "send", next: { nextStepAt: minutes(26) } })
	})

	it("walks the email example: page at 14:10, stop at the 14:12 ack, never send step 3", () => {
		const atTen = planEscalationAdvance(
			run({ stepIndex: 1, nextStepAt: minutes(10) }),
			firing,
			minutes(10),
		)
		expect(atTen).toMatchObject({
			kind: "send",
			step: { targets: [{ destinationId: destinationIds.pagerduty }] },
		})
		const acked = { ...firing, acknowledged: true }
		expect(
			planEscalationAdvance(run({ stepIndex: 2, nextStepAt: minutes(25) }), acked, minutes(12)),
		).toEqual({
			kind: "pause",
		})
		expect(
			planEscalationAdvance(
				run({ status: "acknowledged", stepIndex: 2, nextStepAt: minutes(25) }),
				acked,
				minutes(30),
			),
		).toEqual({ kind: "wait" })
	})

	it("resumes an unacknowledged run where it stopped", () => {
		const paused = run({ status: "acknowledged", stepIndex: 2, nextStepAt: minutes(25) })
		expect(planEscalationAdvance(paused, firing, minutes(20))).toEqual({ kind: "resume" })
		expect(planEscalationAdvance(paused, firing, minutes(40))).toMatchObject({
			kind: "send",
			stepIndex: 2,
		})
	})

	it("ends without sending once the incident resolves, even mid-wait", () => {
		const resolved = { ...firing, open: false }
		expect(planEscalationAdvance(run({ nextStepAt: minutes(30) }), resolved, minutes(1))).toEqual({
			kind: "end",
			status: "resolved",
		})
	})

	it("holds a due step through a silence and sends it once the silence ends", () => {
		const silenced = { ...firing, silenced: true }
		const due = run({ stepIndex: 1, nextStepAt: minutes(10) })
		expect(planEscalationAdvance(due, silenced, minutes(10))).toEqual({
			kind: "defer",
			nextStepAt: minutes(10) + ESCALATION_SILENCE_RECHECK_MS,
		})
		expect(
			planEscalationAdvance(run({ stepIndex: 1, nextStepAt: minutes(30) }), firing, minutes(30)),
		).toMatchObject({
			kind: "send",
			stepIndex: 1,
		})
	})

	it("repeats the whole chain, then reports it spent after the last step of the last pass", () => {
		const repeating = { repeatCount: 1 }
		expect(planEscalationAdvance(run({ ...repeating, stepIndex: 2 }), firing, T0)).toMatchObject({
			kind: "send",
			next: { kind: "step", stepIndex: 0, passIndex: 1, nextStepAt: minutes(15) },
		})
		expect(
			planEscalationAdvance(run({ ...repeating, stepIndex: 2, passIndex: 1 }), firing, T0),
		).toMatchObject({
			kind: "send",
			stepIndex: 2,
			passIndex: 1,
			next: { kind: "exhausted" },
		})
	})

	it("ends a run whose position is past its chain instead of sending", () => {
		expect(planEscalationAdvance(run({ stepIndex: 7 }), firing, T0)).toEqual({
			kind: "end",
			status: "exhausted",
		})
	})

	it("leaves ended runs alone", () => {
		expect(planEscalationAdvance(run({ status: "exhausted" }), firing, minutes(90))).toEqual({
			kind: "wait",
		})
		expect(planEscalationAdvance(run({ status: "superseded" }), { ...firing, open: false }, T0)).toEqual({
			kind: "wait",
		})
	})

	it("sends every step of every pass exactly once when nobody acknowledges", () => {
		const walk = (position: EscalationRunPosition, nowMs: number, sent: number): number => {
			const plan = planEscalationAdvance(position, firing, nowMs)
			if (plan.kind !== "send") return sent
			if (plan.next.kind === "exhausted") return sent + 1
			return walk(
				{
					...position,
					stepIndex: plan.next.stepIndex,
					passIndex: plan.next.passIndex,
					nextStepAt: plan.next.nextStepAt,
				},
				plan.next.nextStepAt,
				sent + 1,
			)
		}
		expect(walk(run({ repeatCount: 2 }), T0, 0)).toBe(escalationStepCount(steps, 2))
	})
})
