import { describe, expect, test } from "vitest"
import { suggestOrganizationName } from "./onboarding-org-name"

describe("suggestOrganizationName", () => {
	test("a work email names the company in its domain", () => {
		expect(suggestOrganizationName("david@acme.dev", "David Smith")).toEqual({
			name: "Acme",
			domain: "acme.dev",
		})
	})

	test("subdomains and country-code suffixes still find the company", () => {
		expect(suggestOrganizationName("ops@mail.acme.co.uk", null).name).toBe("Acme")
		expect(suggestOrganizationName("ops@heartbeat-labs.io", null).name).toBe("Heartbeat Labs")
	})

	test("a personal address falls back to the person's own team", () => {
		expect(suggestOrganizationName("david@gmail.com", "David Smith")).toEqual({
			name: "David's team",
			domain: null,
		})
	})

	test("a provider's country domain and a punycode domain are not company names", () => {
		expect(suggestOrganizationName("dana@yahoo.co.uk", "Dana Onboard").name).toBe("Dana's team")
		expect(suggestOrganizationName("dana@outlook.de", "Dana Onboard").name).toBe("Dana's team")
		expect(suggestOrganizationName("dana@xn--mnchen-3ya.de", "Dana Onboard").name).toBe("Dana's team")
	})

	test("without a name or a work domain there is still something to submit", () => {
		expect(suggestOrganizationName(null, null).name).toBe("My team")
		expect(suggestOrganizationName("not-an-email", "  ").name).toBe("My team")
	})
})
