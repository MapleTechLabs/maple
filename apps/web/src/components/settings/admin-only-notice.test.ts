import { describe, expect, it } from "vitest"
import { adminOnlyNoticeText, memberDisplayName } from "./admin-only-notice"

describe("memberDisplayName", () => {
	it("prefers the full name, then the identifier", () => {
		expect(memberDisplayName({ firstName: "Ada", lastName: "Lovelace", identifier: "ada@x.dev" })).toBe(
			"Ada Lovelace",
		)
		expect(memberDisplayName({ firstName: "Ada", lastName: null, identifier: "ada@x.dev" })).toBe("Ada")
		expect(memberDisplayName({ firstName: "", lastName: null, identifier: "ada@x.dev" })).toBe(
			"ada@x.dev",
		)
	})

	it("returns nothing when no admin is known", () => {
		expect(memberDisplayName(undefined)).toBeUndefined()
		expect(memberDisplayName({ firstName: null, lastName: null, identifier: "" })).toBeUndefined()
	})
})

describe("adminOnlyNoticeText", () => {
	it("names the admin to ask when one is known", () => {
		expect(adminOnlyNoticeText("billing", "Ada")).toBe("Only admins can change billing. Ask Ada.")
	})

	it("omits the ask when no admin name resolved", () => {
		expect(adminOnlyNoticeText("billing", undefined)).toBe("Only admins can change billing.")
	})
})
