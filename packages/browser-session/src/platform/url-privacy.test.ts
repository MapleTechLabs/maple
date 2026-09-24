import { afterEach, describe, expect, it } from "vitest"
import { addUrlSanitizer, redactUrl, resetUrlSanitizersForTests, scrubUrl } from "./url-privacy"

afterEach(() => resetUrlSanitizersForTests())

describe("redactUrl", () => {
	it("redacts credential-shaped query parameters and keeps the rest", () => {
		expect(redactUrl("https://app.test/reset?token=abc&tab=2")).toBe(
			"https://app.test/reset?token=REDACTED&tab=2",
		)
	})

	it("redacts implicit-flow tokens in the fragment but leaves hash routes alone", () => {
		expect(redactUrl("https://app.test/cb#access_token=abc&expires_in=3600")).toBe(
			"https://app.test/cb#access_token=REDACTED&expires_in=3600",
		)
		expect(redactUrl("https://app.test/#/settings?token=x")).toBe("https://app.test/#/settings?token=x")
	})

	it("keeps relative URLs relative", () => {
		expect(redactUrl("/api/login?password=hunter2")).toBe("/api/login?password=REDACTED")
		expect(redactUrl("api/items?page=2")).toBe("api/items?page=2")
	})

	it("returns unparseable and plain URLs untouched", () => {
		expect(redactUrl("https://app.test/plain")).toBe("https://app.test/plain")
		expect(redactUrl("")).toBe("")
	})
})

describe("scrubUrl", () => {
	it("runs host sanitizers after the default redaction and survives a throwing one", () => {
		addUrlSanitizer((url) => url.replace(/\/users\/\d+/, "/users/:id"))
		addUrlSanitizer(() => {
			throw new Error("broken")
		})
		expect(scrubUrl("https://app.test/users/42?code=x")).toBe("https://app.test/users/:id?code=REDACTED")
	})
})
