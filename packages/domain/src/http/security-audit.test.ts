import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { SecurityAuditCreateTargetRequest } from "./security-audit"

const failureOf = (input: unknown) => {
	const result = Schema.decodeUnknownExit(SecurityAuditCreateTargetRequest)(input)
	return result._tag === "Failure" ? String(result.cause) : "decoded"
}

describe("SecurityAuditCreateTargetRequest", () => {
	it("says what a scope path may contain instead of a bare filter failure", () => {
		const message = failureOf({ repository: "acme/api", branch: "main", scopePaths: ["../etc"] })
		expect(message).toContain("Expected a repository-relative path like src/api")
		expect(message).not.toContain("<filter>")
	})

	it("says why a branch ending in .lock is refused", () => {
		expect(failureOf({ repository: "acme/api", branch: "main.lock" })).toContain(
			"Expected a branch name that does not end in '/' or '.lock'",
		)
	})
})
