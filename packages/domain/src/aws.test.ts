import { describe, expect, it } from "vitest"
import { awsGrantedModules } from "./aws"

describe("awsGrantedModules", () => {
	it("counts the audit log as granted by the Security scan policy", () => {
		expect(awsGrantedModules(["cost", "security"])).toEqual(["cost", "security", "audit"])
	})

	it("needs the audit policy without Security scan", () => {
		expect(awsGrantedModules(["cost"])).toEqual(["cost"])
		expect(awsGrantedModules(["audit"])).toEqual(["audit"])
	})
})
