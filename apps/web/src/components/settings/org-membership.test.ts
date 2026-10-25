import { describe, expect, it } from "vitest"
import { leaveEligibility, orgRoleLabel, toOrgRole } from "./org-membership"

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
	it("reads unknown Clerk roles as member", () => {
		expect(toOrgRole("org:admin")).toBe("org:admin")
		expect(toOrgRole("org:billing")).toBe("org:member")
		expect(orgRoleLabel("org:viewer")).toBe("Member")
	})
})
