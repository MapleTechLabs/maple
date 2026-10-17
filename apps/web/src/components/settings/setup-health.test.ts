import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { SETUP_AUDIT_CHECKS } from "@maple/domain/setup-audit"
import { describe, expect, it } from "vitest"

import { healthSegments, orderFindings, resolvedChecks, setupHealthAction } from "./setup-health"

const RULE_ID = "3f1b7c02-9a44-4d1e-8b2f-0c5d6e7a8b91"

describe("setupHealthAction", () => {
	it("gives every check in the registry one specific action", () => {
		for (const check of SETUP_AUDIT_CHECKS) {
			const action = setupHealthAction({ id: check.id, affected: [] })
			expect(action, check.id).not.toBeNull()
			expect(action?.label, check.id).not.toMatch(/CFG-|^Fix$/)
		}
	})

	it("opens the affected alert rule in the editor by its internal id", () => {
		const action = setupHealthAction({
			id: "CFG-ALERT-03",
			affected: [
				{
					kind: "alert_rule",
					id: encodePublicId(PublicIdPrefixes.alertRule, RULE_ID),
					name: "High error rate",
					note: null,
				},
			],
		})
		expect(action).toMatchObject({
			kind: "link",
			link: { to: "/alerts/create", search: { ruleId: RULE_ID } },
		})
	})

	it("falls back to the rules list when no rule id can be decoded", () => {
		const action = setupHealthAction({
			id: "CFG-ALERT-05",
			affected: [{ kind: "alert_rule", id: "not-a-public-id", name: "Old rule", note: null }],
		})
		expect(action).toMatchObject({ kind: "link", link: { to: "/alerts", search: { tab: "rules" } } })
	})

	it("sends telemetry checks to the matching guide section", () => {
		const action = setupHealthAction({ id: "LOG-02", affected: [] })
		expect(action?.kind).toBe("docs")
		expect(action?.kind === "docs" ? action.href : "").toMatch(/otel-conventions#trace-correlation$/)
	})

	it("reconnects the integration a revoked grant names", () => {
		const action = setupHealthAction({
			id: "CFG-INTEG-01",
			affected: [{ kind: "integration", id: null, name: "railway", note: null }],
		})
		expect(action).toMatchObject({ link: { to: "/integrations", search: { integration: "railway" } } })
	})

	it("returns null for a check this build does not know", () => {
		expect(setupHealthAction({ id: "NEW-99", affected: [] })).toBeNull()
	})
})

describe("orderFindings", () => {
	it("keeps only failures, most severe first, report order within a severity", () => {
		const ordered = orderFindings([
			{ id: "a", status: "fail", severity: "info" },
			{ id: "b", status: "pass", severity: "critical" },
			{ id: "c", status: "fail", severity: "warn" },
			{ id: "d", status: "fail", severity: "critical" },
			{ id: "e", status: "fail", severity: "warn" },
			{ id: "f", status: "skip", severity: "warn" },
		])
		expect(ordered.map((check) => check.id)).toEqual(["d", "c", "e", "a"])
	})
})

describe("healthSegments", () => {
	it("orders segments critical to passing and drops empty ones", () => {
		expect(healthSegments({ critical: 0, warn: 2, info: 1, pass: 40, skip: 0 })).toEqual([
			{ segment: "warn", count: 2 },
			{ segment: "info", count: 1 },
			{ segment: "pass", count: 40 },
		])
	})
})

describe("resolvedChecks", () => {
	const checks = (statuses: ReadonlyArray<"pass" | "skip" | "fail">) =>
		statuses.map((status, index) => ({ id: `C-${index}`, status }))

	it("counts passed and skipped checks apart and leaves failures out", () => {
		const result = resolvedChecks(checks(["pass", "skip", "fail", "pass", "skip", "skip"]))
		expect(result.label).toBe("Passing (2) and skipped (3)")
		expect(result.checks.map((check) => check.id)).toEqual(["C-0", "C-1", "C-3", "C-4", "C-5"])
	})

	it("names only the group that has checks", () => {
		expect(resolvedChecks(checks(["pass", "fail"])).label).toBe("Passing (1)")
		expect(resolvedChecks(checks(["skip", "skip"])).label).toBe("Skipped (2)")
		expect(resolvedChecks(checks(["fail"])).checks).toEqual([])
	})
})
