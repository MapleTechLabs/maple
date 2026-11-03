import { describe, expect, it } from "vitest"
import type { AuditRole } from "@maple/security-audit"
import { resolveSecurityAuditModel } from "../platform/Llm"
import { EXECUTOR_INACTIVITY_TIMEOUT_MS } from "@maple/domain/executor"
import { AGENT_MAX_DURATION, modelFor } from "./agents"
import { AGENT_STEP } from "./workflow.run"
import { Array as Arr, Duration, Record as Rec } from "effect"

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
		expect(Rec.fromEntries(Arr.map(roles, (role) => [role, modelFor(role, models).name]))).toEqual({
			recon: models.discovery.name,
			synthesis: models.discovery.name,
			hunter: models.discovery.name,
			critic: models.discovery.name,
			"candidate-verifier": models.validation.name,
			"record-verifier": models.validation.name,
		})
	})
})

describe("agent time limits", () => {
	const rail = Duration.toMillis(AGENT_MAX_DURATION)

	/** A step that times out first kills an agent still inside its own rail, with no answer. */
	it("lets every agent reach its rail inside its workflow step", () => {
		expect(rail + 5 * 60 * 1000).toBeLessThanOrEqual(Duration.toMillis(AGENT_STEP.timeout))
	})

	/** Recon and synthesis send the executor nothing: parallel recon, then up to two syntheses. */
	it("keeps the executor alive through recon and synthesis at the rail", () => {
		expect(3 * rail).toBeLessThan(EXECUTOR_INACTIVITY_TIMEOUT_MS)
	})
})
