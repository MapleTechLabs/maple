import { Array as Arr, Option, Schema, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { V2OnboardingAgentReport } from "./http/v2/onboarding-agent-run"
import { onboardingHandoffArm } from "./onboarding-agent-run"

const orgIds = Arr.makeBy(2000, (index) => `org_${index.toString(36)}x${(index * 7919).toString(36)}`)
const handoffShare = (percent: number) =>
	Arr.filter(orgIds, (orgId) => onboardingHandoffArm(orgId, percent) === "handoff").length / orgIds.length

describe("onboardingHandoffArm", () => {
	it("puts about the rollout share of orgs in the handoff arm", () => {
		expect(handoffShare(50)).toBeGreaterThan(0.45)
		expect(handoffShare(50)).toBeLessThan(0.55)
	})

	it("keeps an org in the handoff arm as the rollout grows", () => {
		const atHalf = Arr.filter(orgIds, (orgId) => onboardingHandoffArm(orgId, 50) === "handoff")
		expect(Arr.every(atHalf, (orgId) => onboardingHandoffArm(orgId, 80) === "handoff")).toBe(true)
	})

	it("puts every org in the handoff arm at 100 and none at 0", () => {
		expect(handoffShare(100)).toBe(1)
		expect(handoffShare(0)).toBe(0)
	})
})

describe("reported service names", () => {
	const accepts = (name: string) =>
		Option.isSome(
			Schema.decodeOption(V2OnboardingAgentReport)({
				stage: "instrument_app",
				status: "active",
				service_names: [name],
			}),
		)

	it("takes any printable OpenTelemetry service.name", () => {
		expect(accepts("Checkout API")).toBe(true)
		expect(accepts("café-ä/v2")).toBe(true)
		expect(accepts("checkout-api")).toBe(true)
	})

	it("refuses control and invisible format characters, and names past 120 characters", () => {
		expect(accepts("checkout\napi")).toBe(false)
		expect(accepts("checkout\u200bapi")).toBe(false)
		expect(accepts("")).toBe(false)
		expect(accepts(Str.repeat(121)("a"))).toBe(false)
	})
})
