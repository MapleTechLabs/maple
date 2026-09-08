import { expect, it } from "vitest"
import { Schema } from "effect"
import { QualifyAnswersSchema, resolveQuickStartStep, STEP_IDS } from "./quick-start-atoms"
import { getOnboardingSetupHint } from "@/lib/onboarding-intent"

it("normalizes old single choices without dropping saved onboarding answers", () => {
	const decode = Schema.decodeUnknownSync(QualifyAnswersSchema)
	expect(decode({ role: "engineer", intent: "errors" })).toEqual({
		role: "backend",
		roleDetail: "",
		intents: ["errors"],
	})
	expect(decode({ role: null })).toEqual({ role: null, roleDetail: "", intents: [] })
	expect(decode({ role: "other", roleDetail: "Security engineer" }).roleDetail).toBe("Security engineer")
	expect(decode({ role: "engineer", intent: "errors", intents: [] }).intents).toEqual([])
	expect(decode({ role: "engineer", intents: ["errors", "traces"] }).intents).toEqual(["errors", "traces"])
})

it("maps the first wizard's themed choices onto the surfaces they were about", () => {
	const decode = Schema.decodeUnknownSync(QualifyAnswersSchema)
	expect(decode({ role: null, intent: "slow_requests" }).intents).toEqual(["traces"])
	expect(decode({ role: null, intents: ["visibility", "consolidate", "logs", "errors"] }).intents).toEqual([
		"service_map",
		"logs",
		"errors",
	])
})

it("uses all chosen interests in the setup guidance", () => {
	expect(getOnboardingSetupHint(["errors", "traces", "service_map"])).toBe(
		"Connect your app to explore errors, traces, and the service map.",
	)
})

it("writes only the multi-select format and restores every selection", () => {
	const answers = { role: "backend" as const, roleDetail: "", intents: ["errors", "traces"] as const }
	const encoded = Schema.encodeSync(QualifyAnswersSchema)(answers)
	expect(encoded).toEqual(answers)
	expect(Schema.decodeUnknownSync(QualifyAnswersSchema)(encoded)).toEqual(answers)
})

it("resumes an old demo step at the next incomplete step after role completion", () => {
	expect(resolveQuickStartStep({ activeStep: "demo", completedSteps: { role: true } })).toBe("intent")
	expect(resolveQuickStartStep({ activeStep: "demo", completedSteps: {} })).toBe("role")
	expect(STEP_IDS).toEqual(["role", "intent", "team", "plan"])
})

it("preserves navigation to a current step", () => {
	expect(resolveQuickStartStep({ activeStep: "role", completedSteps: { role: true } })).toBe("role")
	expect(resolveQuickStartStep({ activeStep: "plan", completedSteps: { role: true } })).toBe("plan")
})
