import { SecurityAuditBudgetExhaustedError, SecurityAuditRunInProgressError } from "@maple/domain/http"
import { IsoDateTimeString } from "@maple/domain/primitives"
import { SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { toStartFailure } from "./api"

describe("toStartFailure", () => {
	it("says when an exhausted audit budget resets", () => {
		const failure = toStartFailure(
			new SecurityAuditBudgetExhaustedError({
				message: "This organization has 3 security audit invocations left this billing cycle.",
				remaining: 3,
				required: 8,
				resetsAt: Schema.decodeSync(IsoDateTimeString)("2026-11-07T09:00:00.000Z"),
			}),
		)
		expect([failure.code, failure.message]).toEqual([
			"security_audit_budget_exhausted",
			"This organization has 3 security audit invocations left this billing cycle. The budget resets on November 7, 2026.",
		])
	})

	it("leaves every other refusal in the server's words", () => {
		const failure = toStartFailure(
			new SecurityAuditRunInProgressError({
				message: "This target already has an audit in progress.",
				targetId: Schema.decodeSync(SecurityAuditTargetId)(crypto.randomUUID()),
			}),
		)
		expect(failure.message).toBe("This target already has an audit in progress.")
	})
})
