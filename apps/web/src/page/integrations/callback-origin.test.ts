import { describe, expect, test } from "vitest"
import { apiBaseUrl } from "../../lib/services/common/api-base-url"
import { isCallbackOrigin } from "./connect-returns"

const OWN = "https://app.maple.dev"

describe("integration callback origin", () => {
	test("takes the callback from the API or from this origin through the proxy", () => {
		expect(isCallbackOrigin(new URL(apiBaseUrl).origin, OWN)).toBe(true)
		expect(isCallbackOrigin(OWN, OWN)).toBe(true)
	})

	test("ignores a message any other page posts", () => {
		expect(isCallbackOrigin("https://evil.example", OWN)).toBe(false)
		expect(isCallbackOrigin("null", OWN)).toBe(false)
	})
})
