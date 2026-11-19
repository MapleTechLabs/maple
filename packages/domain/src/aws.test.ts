import { describe, expect, it } from "vitest"
import { awsGrantsMatch, awsModuleGranted } from "./aws"

describe("awsModuleGranted", () => {
	it("counts the audit log as granted by the Security scan policy", () => {
		expect(awsModuleGranted(["cost", "security"], "audit")).toBe(true)
	})

	it("needs the module's own policy otherwise", () => {
		expect(awsModuleGranted(["cost"], "audit")).toBe(false)
		expect(awsModuleGranted(["audit"], "security")).toBe(false)
		expect(awsModuleGranted(null, "cost")).toBe(false)
	})
})

describe("awsGrantsMatch", () => {
	it("matches a Security scan role asked for the audit log too, with no stack update", () => {
		expect(awsGrantsMatch(["security"], ["security"])).toBe(true)
		expect(awsGrantsMatch(["security", "audit"], ["security"])).toBe(true)
	})

	it("flags a module asked for and not granted, and a policy left attached", () => {
		expect(awsGrantsMatch(["cost", "audit"], ["cost"])).toBe(false)
		expect(awsGrantsMatch(["cost"], ["cost", "security"])).toBe(false)
	})
})
