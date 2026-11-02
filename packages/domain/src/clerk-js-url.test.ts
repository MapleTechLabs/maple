import { describe, expect, it } from "vitest"
import { CLERK_JS_VERSION, clerkJsUrl } from "./clerk-js-url"

describe("clerkJsUrl", () => {
	it("loads the pinned build from the Frontend API the publishable key names", () => {
		const key = `pk_live_${btoa("clerk.maple.test$")}`
		expect(clerkJsUrl(key)).toBe(
			`https://clerk.maple.test/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`,
		)
	})
})
