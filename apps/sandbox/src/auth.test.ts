import { assert, describe, it } from "vitest"
import { authorize, bearerToken, tokenMatches } from "./auth"

describe("tokenMatches", () => {
	it("accepts only the exact token", () => {
		assert.isTrue(tokenMatches("s3cret-token", "s3cret-token"))
		assert.isFalse(tokenMatches("s3cret-tokes", "s3cret-token"))
		assert.isFalse(tokenMatches("", "s3cret-token"))
	})

	it("rejects a prefix or an extension rather than comparing what overlaps", () => {
		assert.isFalse(tokenMatches("s3cret", "s3cret-token"))
		assert.isFalse(tokenMatches("s3cret-token-more", "s3cret-token"))
	})

	it("compares every byte, so length is the only early exit", () => {
		// Not a timing measurement, which would be flaky; this pins the property the
		// implementation relies on.
		const body = tokenMatches.toString()
		assert.notInclude(body.slice(body.indexOf("for")), "return true")
	})
})

describe("bearerToken", () => {
	it("reads the scheme case-insensitively and keeps the token intact", () => {
		assert.strictEqual(bearerToken("Bearer abc.def"), "abc.def")
		assert.strictEqual(bearerToken("bearer abc"), "abc")
		assert.isUndefined(bearerToken("Basic abc"))
		assert.isUndefined(bearerToken("Bearer"))
		assert.isUndefined(bearerToken(null))
	})
})

describe("authorize", () => {
	it("fails closed when no token is configured, whatever the caller presents", () => {
		// A deployment without the secret must not be open; it must be shut.
		assert.strictEqual(authorize("Bearer anything", undefined), "no-token-configured")
		assert.strictEqual(authorize("Bearer anything", ""), "no-token-configured")
		assert.strictEqual(authorize(null, undefined), "no-token-configured")
	})

	it("separates a missing credential from a wrong one, so the logs say which", () => {
		assert.strictEqual(authorize(null, "expected"), "no-credential")
		assert.strictEqual(authorize("Bearer wrong", "expected"), "bad-token")
		assert.strictEqual(authorize("Bearer expected", "expected"), "authorized")
	})
})
