import { assert, describe, it } from "@effect/vitest"
import { IncidentTriageVerdict } from "@maple/domain/http"
import {
	NOISE_CONFIDENCE_FLOOR,
	evaluateIncidentGate,
	mostSevere,
} from "./investigation-gate"

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

describe("evaluateIncidentGate", () => {
	it("skips a confident noise verdict", () => {
		const result = evaluateIncidentGate({ verdict: verdict(), detectorSeverity: "low" })
		assert.strictEqual(result.kind, "skip")
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

	it("investigates noise the model is not sure about", () => {
		const result = evaluateIncidentGate({
			verdict: verdict({ dispositionConfidence: NOISE_CONFIDENCE_FLOOR - 0.01 }),
			detectorSeverity: "low",
		})
		assert.strictEqual(result.kind, "investigate")
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
