import { describe, expect, it } from "vitest"
import { auditActionLabel, auditActions, AuditResources, auditResourceLabel } from "./audit-actions"

describe("audit action labels", () => {
	it("labels every action in the catalog with a readable sentence, not the raw action", () => {
		const actions = auditActions()
		expect(actions.length).toBeGreaterThan(0)
		for (const action of actions) {
			const label = auditActionLabel(action)
			expect(label, action).not.toBeNull()
			expect(label, action).not.toContain("_")
			expect(label, action).not.toContain(".")
			expect(label?.[0], action).toBe(label?.[0]?.toUpperCase())
		}
	})

	it("labels every resource type in the catalog", () => {
		for (const type of Object.keys(AuditResources)) {
			expect(auditResourceLabel(type), type).not.toBeNull()
		}
	})

	it("returns null for an action or resource this build does not declare", () => {
		expect(auditActionLabel("dashboard.exploded")).toBeNull()
		expect(auditActionLabel("toString")).toBeNull()
		expect(auditResourceLabel("spaceship")).toBeNull()
	})
})
