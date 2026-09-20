import { assert, describe, it } from "@effect/vitest"
import { IncidentTriagePriorMatch, IncidentTriageVerdict } from "@maple/domain/http"
import { InvestigationId } from "@maple/domain/primitives"
import { Schema } from "effect"
import {
	NOISE_CONFIDENCE_FLOOR,
	PRIOR_MATCH_FLOOR,
	REINVESTIGATE_AFTER_MS,
	evaluateIncidentGate,
	evaluateIssueGate,
	mostSevere,
} from "./investigation-gate"
import { STALE_MS } from "./investigation-stale"

const asInvestigationId = Schema.decodeUnknownSync(InvestigationId)
const PRIOR = asInvestigationId("11111111-1111-4111-8111-111111111111")

const verdict = (overrides?: Partial<IncidentTriageVerdict>) =>
	new IncidentTriageVerdict({
		disposition: "noise",
		dispositionConfidence: 0.95,
		severity: "low",
		severityConfidence: 0.9,
		userImpact: 0.02,
		model: "~typesafe/jev-latest",
		...overrides,
	})

describe("evaluateIssueGate", () => {
	const NOW = Date.UTC(2026, 8, 20, 12, 0, 0)
	const diagnosed = (ageMs: number, status = "diagnosed") => ({
		id: PRIOR,
		status,
		createdAtMs: NOW - ageMs,
		startedAtMs: NOW - ageMs,
	})
	const open = (overrides?: Partial<Parameters<typeof evaluateIssueGate>[0]>) =>
		evaluateIssueGate({
			workflowState: "triage",
			reason: "first_seen",
			latest: null,
			incidentKind: "error",
			nowMs: NOW,
			...overrides,
		})

	it("investigates a fresh issue nobody has looked at", () => {
		assert.deepStrictEqual(open(), { kind: "investigate" })
		// No issue at all (a free-standing anomaly) gates nothing here either.
		assert.deepStrictEqual(open({ workflowState: null }), { kind: "investigate" })
	})

	it("skips an issue somebody already owns, whatever its history", () => {
		// Prod, Aug 2026: an issue moved to `in_review` with a PR attached kept
		// getting fresh diagnoses on every flare-up.
		for (const state of [
			"todo",
			"in_progress",
			"in_review",
			"verifying",
			"done",
			"cancelled",
			"wontfix",
		] as const) {
			const result = open({ workflowState: state })
			assert.strictEqual(result.kind, "skip", state)
			if (result.kind === "skip") assert.strictEqual(result.reason, "issue_handled")
		}
	})

	it("skips a flare-up of an issue diagnosed recently", () => {
		// The regression this gate exists for: 83 incidents in five days on one
		// issue, fifteen of them diagnosed, all identically.
		const result = open({ latest: diagnosed(3 * 60 * 60 * 1000) })
		assert.deepStrictEqual(result, {
			kind: "skip",
			reason: "recently_diagnosed",
			priorInvestigationId: PRIOR,
		})
		// An inconclusive report is still an answer.
		assert.strictEqual(open({ latest: diagnosed(1000, "inconclusive") }).kind, "skip")
	})

	it("re-asks once the diagnosis is old enough, on a per-kind window", () => {
		const errorWindow = REINVESTIGATE_AFTER_MS.error
		assert.strictEqual(open({ latest: diagnosed(errorWindow - 1) }).kind, "skip")
		assert.strictEqual(open({ latest: diagnosed(errorWindow + 1) }).kind, "investigate")

		// An alert firing on a different day is often a different cause.
		const alertWindow = REINVESTIGATE_AFTER_MS.alert
		assert.isBelow(alertWindow, errorWindow)
		assert.strictEqual(
			open({ incidentKind: "alert", latest: diagnosed(alertWindow + 1) }).kind,
			"investigate",
		)
	})

	it("treats a regression as a new question", () => {
		// The issue was resolved and came back: the diagnosis on file is what was
		// fixed, and the interesting part is what is different now.
		const result = open({ workflowState: "regressed", reason: "regression", latest: diagnosed(1000) })
		assert.deepStrictEqual(result, { kind: "investigate" })
	})

	it("does not start beside a pass already under way, unless that pass is dead", () => {
		const running = open({ latest: diagnosed(60 * 1000, "investigating") })
		assert.deepStrictEqual(running, {
			kind: "skip",
			reason: "investigation_in_flight",
			priorInvestigationId: PRIOR,
		})
		// Past the pass budget the row says `investigating` but nothing is running;
		// the tick's sweep will fail it, and the issue must not wait on it.
		const dead = open({ latest: diagnosed(STALE_MS + 1000, "investigating") })
		assert.deepStrictEqual(dead, { kind: "investigate" })
	})

	it("lets a failed attempt be retried", () => {
		assert.deepStrictEqual(open({ latest: diagnosed(1000, "failed") }), { kind: "investigate" })
	})

	it("never refuses a forced start", () => {
		const result = open({ workflowState: "done", latest: diagnosed(1000), force: true })
		assert.deepStrictEqual(result, { kind: "investigate" })
	})
})

describe("evaluateIncidentGate", () => {
	it("skips a confident noise verdict", () => {
		const result = evaluateIncidentGate({ verdict: verdict(), detectorSeverity: "low" })
		assert.strictEqual(result.kind, "skip")
		if (result.kind === "skip") {
			assert.strictEqual(result.reason, "noise")
			assert.isNull(result.priorInvestigationId)
		}
	})

	it("investigates when the classifier is unavailable", () => {
		// The whole point of the fallback: a classifier that is off, unreachable or
		// broken must not turn into a policy of dropping incidents.
		for (const absent of [null, undefined]) {
			const result = evaluateIncidentGate({ verdict: absent, detectorSeverity: "medium" })
			assert.strictEqual(result.kind, "investigate")
			if (result.kind === "investigate") {
				assert.strictEqual(result.severity, "medium")
				assert.strictEqual(result.classification, null)
			}
		}
	})

	it("investigates noise the model is not sure about, and skips at the floor itself", () => {
		const below = evaluateIncidentGate({
			verdict: verdict({ dispositionConfidence: NOISE_CONFIDENCE_FLOOR - 0.01 }),
			detectorSeverity: "low",
		})
		assert.strictEqual(below.kind, "investigate")
		// A floor is inclusive: exactly at it is enough.
		const at = evaluateIncidentGate({
			verdict: verdict({ dispositionConfidence: NOISE_CONFIDENCE_FLOOR }),
			detectorSeverity: "low",
		})
		assert.strictEqual(at.kind, "skip")
	})

	it("refuses to skip what the detector already called urgent", () => {
		// The detector saw the signal; the classifier read a summary of it.
		for (const severity of ["critical", "high"] as const) {
			const result = evaluateIncidentGate({ verdict: verdict(), detectorSeverity: severity })
			assert.strictEqual(result.kind, "investigate")
			if (result.kind === "investigate") assert.strictEqual(result.severity, severity)
		}
	})

	it("still skips low and medium detector severities", () => {
		for (const severity of ["medium", "low", null] as const) {
			const result = evaluateIncidentGate({ verdict: verdict(), detectorSeverity: severity })
			assert.strictEqual(result.kind, "skip")
		}
	})

	it("never refuses a forced start, but keeps the severity", () => {
		const result = evaluateIncidentGate({
			verdict: verdict({ severity: "high" }),
			detectorSeverity: "low",
			force: true,
		})
		assert.strictEqual(result.kind, "investigate")
		if (result.kind === "investigate") assert.strictEqual(result.severity, "high")
	})

	it("takes the higher of the detector's severity and the model's", () => {
		const raised = evaluateIncidentGate({
			verdict: verdict({ disposition: "investigate", severity: "critical" }),
			detectorSeverity: "low",
		})
		assert.strictEqual(raised.kind, "investigate")
		if (raised.kind === "investigate") assert.strictEqual(raised.severity, "critical")

		// A model that talks an urgent incident down does not get to: severity is
		// what pages people, and this path only ever raises it.
		const lowered = evaluateIncidentGate({
			verdict: verdict({ disposition: "monitor", severity: "low" }),
			detectorSeverity: "critical",
		})
		assert.strictEqual(lowered.kind, "investigate")
		if (lowered.kind === "investigate") assert.strictEqual(lowered.severity, "critical")
	})

	it("investigates a monitor verdict", () => {
		// `monitor` is the label that keeps `noise` sharp; it does not skip work.
		const result = evaluateIncidentGate({
			verdict: verdict({ disposition: "monitor", dispositionConfidence: 0.99 }),
			detectorSeverity: "low",
		})
		assert.strictEqual(result.kind, "investigate")
	})

	it("defers to a diagnosis on file the model is sure explains this incident", () => {
		// Ten fingerprints, one CLI defect: the second through tenth should point at
		// the first's report rather than each earning a pass.
		const covered = evaluateIncidentGate({
			verdict: verdict({
				disposition: "investigate",
				dispositionConfidence: 0.9,
				matchedPrior: new IncidentTriagePriorMatch({ investigationId: PRIOR, probability: 0.93 }),
			}),
			detectorSeverity: "medium",
		})
		assert.deepStrictEqual(
			{ kind: covered.kind, reason: covered.kind === "skip" ? covered.reason : null },
			{ kind: "skip", reason: "covered_by_prior" },
		)
		if (covered.kind === "skip") assert.strictEqual(covered.priorInvestigationId, PRIOR)

		// Below the floor the match is a hint, not a decision.
		const unsure = evaluateIncidentGate({
			verdict: verdict({
				disposition: "investigate",
				dispositionConfidence: 0.9,
				matchedPrior: new IncidentTriagePriorMatch({
					investigationId: PRIOR,
					probability: PRIOR_MATCH_FLOOR - 0.01,
				}),
			}),
			detectorSeverity: "medium",
		})
		assert.strictEqual(unsure.kind, "investigate")

		// And the detector's urgency still wins over a match.
		const urgent = evaluateIncidentGate({
			verdict: verdict({
				matchedPrior: new IncidentTriagePriorMatch({ investigationId: PRIOR, probability: 0.99 }),
			}),
			detectorSeverity: "high",
		})
		assert.strictEqual(urgent.kind, "investigate")
	})
})

describe("mostSevere", () => {
	it("ranks the four severities and lets null lose", () => {
		assert.strictEqual(mostSevere("low", "critical"), "critical")
		assert.strictEqual(mostSevere("high", "medium"), "high")
		assert.strictEqual(mostSevere(null, "low"), "low")
		assert.strictEqual(mostSevere("medium", null), "medium")
		assert.strictEqual(mostSevere(null, null), null)
	})
})
