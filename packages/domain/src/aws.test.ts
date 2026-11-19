import { describe, expect, it } from "vitest"
import { awsModuleGranted } from "./aws"

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
