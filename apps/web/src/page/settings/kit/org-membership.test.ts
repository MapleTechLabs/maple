import { describe, expect, it } from "vitest"
import { leaveEligibility, orgRoleLabel, orgRoleNoun, roleChangePrompt, toOrgRole } from "./org-membership"

describe("leaveEligibility", () => {
	it("lets a member leave without waiting for the admin count", () => {
		expect(leaveEligibility({ isAdmin: false, adminCount: undefined })).toBe("allowed")
		expect(leaveEligibility({ isAdmin: false, adminCount: 1 })).toBe("allowed")
	})

	it("blocks the only admin", () => {
		expect(leaveEligibility({ isAdmin: true, adminCount: 1 })).toBe("last-admin")
		expect(leaveEligibility({ isAdmin: true, adminCount: 0 })).toBe("last-admin")
	})

	it("lets an admin leave when another admin remains", () => {
		expect(leaveEligibility({ isAdmin: true, adminCount: 2 })).toBe("allowed")
	})

	it("holds an admin until the admin count is known", () => {
		expect(leaveEligibility({ isAdmin: true, adminCount: undefined })).toBe("checking")
	})
})

describe("toOrgRole", () => {
	it("reads unknown Clerk roles as observer, the least a person can hold", () => {
		expect(toOrgRole("org:admin")).toBe("org:admin")
		expect(toOrgRole("org:billing")).toBe("org:observer")
		expect(orgRoleLabel("org:viewer")).toBe("Observer")
	})

	it("shows root, which has no entry of its own, as a member", () => {
		expect(orgRoleLabel("root")).toBe("Member")
	})

	it("names the observer role in a role change prompt", () => {
		expect(roleChangePrompt("Ada", "org:observer")).toEqual({
			question:
				"Make Ada an observer? Follows incidents, reliability, product analytics and cost, without changing anything.",
			confirmLabel: "Make observer",
		})
	})
})

describe("engineer role", () => {
	it("keeps org:engineer as its own role with its own label", () => {
		expect(toOrgRole("org:engineer")).toBe("org:engineer")
		expect(orgRoleLabel("org:engineer")).toBe("Engineer")
		expect(orgRoleNoun("org:engineer")).toBe("an engineer")
		expect(orgRoleNoun("org:member")).toBe("a member")
	})

	it("asks before a role change, naming the person and the new role", () => {
		const prompt = roleChangePrompt("Ada", "org:engineer")
		expect(prompt.confirmLabel).toBe("Make engineer")
		expect(prompt.question).toMatch(/^Make Ada an engineer\? /)
		expect(roleChangePrompt("Ada", "org:admin").confirmLabel).toBe("Make admin")
	})
})
