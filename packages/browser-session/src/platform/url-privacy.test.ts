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
		expect(redactUrl("https://app.test/#/settings")).toBe("https://app.test/#/settings")
		expect(redactUrl("https://app.test/#/reset?token=x&tab=2")).toBe(
			"https://app.test/#/reset?token=REDACTED&tab=2",
		)
		expect(redactUrl("https://app.test/#!/cb?code=x")).toBe("https://app.test/#!/cb?code=REDACTED")
	})

	it("covers provider reset links and presigned URLs", () => {
		expect(redactUrl("https://app.test/auth?mode=resetPassword&oobCode=abc")).toBe(
			"https://app.test/auth?mode=resetPassword&oobCode=REDACTED",
		)
		expect(redactUrl("https://app.test/confirm?token_hash=abc")).toBe(
			"https://app.test/confirm?token_hash=REDACTED",
		)
		expect(redactUrl("https://b.s3.test/o?X-Amz-Signature=abc&X-Amz-Expires=60")).toBe(
			"https://b.s3.test/o?X-Amz-Signature=REDACTED&X-Amz-Expires=60",
		)
	})

	it("keeps the host of a protocol-relative URL", () => {
		expect(redactUrl("//cdn.example.com/a?token=x")).toBe("//cdn.example.com/a?token=REDACTED")
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
