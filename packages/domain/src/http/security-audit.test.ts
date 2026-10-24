import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { IsoDateTimeString } from "../primitives"
import { publicHttpErrorBody } from "./error-policy"
import { SecurityAuditBudgetExhaustedError, SecurityAuditCreateTargetRequest } from "./security-audit"

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

	it("names the expected shape of a repository and a branch instead of a regex", () => {
		const repository = failureOf({ repository: "not a repo", branch: "main" })
		const branch = failureOf({ repository: "acme/api", branch: "--upload-pack=x" })
		expect(repository).toContain("Expected a GitHub repository as owner/name")
		expect(branch).toContain("Expected a branch name of letters")
		expect([repository, branch].some((message) => message.includes("RegExp"))).toBe(false)
	})

	it("says why a branch ending in .lock is refused", () => {
		expect(failureOf({ repository: "acme/api", branch: "main.lock" })).toContain(
			"Expected a branch name that does not end in '/' or '.lock'",
		)
	})
})

describe("SecurityAuditBudgetExhaustedError", () => {
	it("is retryable at the cycle reset it names, so a client may honour retry_at", () => {
		const body = publicHttpErrorBody(
			new SecurityAuditBudgetExhaustedError({
				message: "Budget used up.",
				remaining: 0,
				required: 9,
				resetsAt: Schema.decodeSync(IsoDateTimeString)("2026-11-01T00:00:00.000Z"),
			}),
		)
		expect([body.retryable, body.recovery, body.retry_at]).toEqual([
			true,
			"retry",
			"2026-11-01T00:00:00.000Z",
		])
	})
})
