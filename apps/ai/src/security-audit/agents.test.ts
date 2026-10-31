import { describe, expect, it } from "vitest"
import type { AuditRole } from "@maple/security-audit"
import { resolveSecurityAuditModel } from "../platform/Llm"
import { modelFor } from "./agents"

const models = {
	discovery: resolveSecurityAuditModel({}, "discovery"),
	validation: resolveSecurityAuditModel({}, "validation"),
}

describe("modelFor", () => {
	it("runs both verifiers on the validation model and every other role on discovery", () => {
		const roles: ReadonlyArray<AuditRole> = [
			"recon",
			"synthesis",
			"hunter",
			"critic",
			"candidate-verifier",
			"record-verifier",
		]
		expect(Object.fromEntries(roles.map((role) => [role, modelFor(role, models).name]))).toEqual({
			recon: models.discovery.name,
			synthesis: models.discovery.name,
			hunter: models.discovery.name,
			critic: models.discovery.name,
			"candidate-verifier": models.validation.name,
			"record-verifier": models.validation.name,
		})
	})
})
