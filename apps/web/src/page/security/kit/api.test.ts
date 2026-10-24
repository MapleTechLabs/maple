import {
	SecurityAuditBudgetExhaustedError,
	SecurityAuditRunInProgressError,
	SecurityAuditSpendLimitReachedError,
} from "@maple/domain/http"
import { IsoDateTimeString } from "@maple/domain/primitives"
import { SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { toStartFailure } from "./api"

describe("toStartFailure", () => {
	it("says when the plan's allowance resets", () => {
		const failure = toStartFailure(
			new SecurityAuditBudgetExhaustedError({
				message: "This organization's plan allowance for security audits is used up.",
				remaining: 3,
				required: 8,
				resetsAt: Schema.decodeSync(IsoDateTimeString)("2026-11-07T09:00:00.000Z"),
			}),
		)
		expect([failure.code, failure.message]).toEqual([
			"security_audit_budget_exhausted",
			"This organization's plan allowance for security audits is used up. It resets on November 7, 2026.",
		])
	})

	it("says when a reached spend limit resets, and that an admin can raise it", () => {
		const failure = toStartFailure(
			new SecurityAuditSpendLimitReachedError({
				message: "This organization has spent its $100 monthly security audit limit.",
				limitUsd: 100,
				spentUsd: 100.4,
				resetsAt: Schema.decodeSync(IsoDateTimeString)("2026-11-01T00:00:00.000Z"),
			}),
		)
		expect([failure.code, failure.message]).toEqual([
			"security_audit_spend_limit_reached",
			"This organization has spent its $100 monthly security audit limit. It resets on November 1, 2026, or an admin can raise it under Spend & models.",
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
