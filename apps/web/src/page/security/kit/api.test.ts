import {
	SecurityAuditNotInPlanError,
	SecurityAuditRunInProgressError,
	SecurityAuditSpendLimitReachedError,
} from "@maple/domain/http"
import { IsoDateTimeString } from "@maple/domain/primitives"
import { SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { toStartFailure } from "./api"

describe("toStartFailure", () => {
	it("points an org without AI credits at its billing settings", () => {
		const failure = toStartFailure(
			new SecurityAuditNotInPlanError({
				message: "This organization has used all of its AI credits for this billing period.",
			}),
		)
		expect([failure.code, failure.message]).toEqual([
			"security_audit_not_in_plan",
			"This organization has used all of its AI credits for this billing period. Add AI credits or change the plan under Settings, Billing.",
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
