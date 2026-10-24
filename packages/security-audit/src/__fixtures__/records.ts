import type { CoverageUnit, Finding } from "../schema"
import { coverageId } from "../validators"

const trace = [
	{
		kind: "entrypoint",
		file: "src/routes/keys.ts",
		line: 12,
		scope: "POST /keys/:id/roll",
		description: "accepts a key id from the path",
	},
	{
		kind: "sink",
		file: "src/services/keys.ts",
		line: 40,
		scope: "rollKey",
		description: "rolls the key without an org check",
	},
] as const

export const confirmedRecord: Finding = {
	verdict: "confirmed",
	fingerprint: "keys/roll-missing-org-scope",
	title: "Any org member can roll another org's API key",
	description: "rollKey looks the key up by id alone.",
	root_cause: "rollKey omits the org_id predicate.",
	intended_behavior: "A key is only rolled within the caller's org.",
	trace,
	evidence: [{ file: "src/services/keys.ts", line: 40, description: "lookup by id only" }],
	conditions: [{ kind: "authentication_level", description: "any authenticated org member" }],
	execution: {
		attacker_perspective: "member of org A",
		payloads: ["POST /keys/<org B key id>/roll"],
		instructions: ["call the route as an org A member with an org B key id"],
		observed_result: "the dummy org B key was rolled",
	},
	remediation: { strategy: "filter by the caller's org_id in rollKey" },
	severity: {
		likelihood: { score: "medium", reason: "requires a valid key id" },
		impact: { score: "high", reason: "cross-tenant write" },
		overall_severity: "high",
	},
	confidence: { score: "high", reason: "reproduced against a dummy tenant" },
}

export const needsValidationRecord: Finding = {
	verdict: "needs_validation",
	fingerprint: "keys/roll-missing-org-scope",
	title: "Key roll may cross orgs",
	description: "rollKey looks the key up by id alone.",
	claimed_root_cause: "rollKey omits the org_id predicate.",
	trace,
	evidence: [{ file: "src/services/keys.ts", line: 40, description: "lookup by id only" }],
	blockers: ["whether the gateway injects an org filter is deployment configuration"],
	validation_plan: { deployment: "owner confirms the gateway's key routes carry no org filter" },
}

const refs = {
	surface: "src/routes/keys.ts#POST /keys/:id/roll",
	boundary: "src/services/keys.ts#rollKey",
	subsystem: "src/services",
	attack_class: "ATTACK-CLASSES.md#Access control",
}

export const plannedUnit: CoverageUnit = {
	coverage_id: coverageId(refs),
	canonical_refs: refs,
	surface: "POST /keys/:id/roll",
	boundary: "rollKey org scope",
	subsystem: "services",
	attack_class: "Access control",
	starting_paths: ["src/routes/keys.ts"],
	ordinary_attack_class_block: "ATTACK-CLASSES.md#Access control",
	selected_companion_blocks: [
		"DATA-ISOLATION-AND-LIFECYCLE.md#Core discipline",
		"DATA-ISOLATION-AND-LIFECYCLE.md#Tenant and object-isolation attack classes",
		"DATA-ISOLATION-AND-LIFECYCLE.md#Universal moves",
		"DATA-ISOLATION-AND-LIFECYCLE.md#Validation rules",
	],
	excluded_blocks: [{ block: "CLIENT-SIDE.md#Core discipline", reason: "no browser surface on this path" }],
	prior_status: "none",
	attempts: [],
	wave: 1,
	status: "planned",
	agent_id: null,
	reviewed_paths: [],
	local_checks: [],
	result_fingerprints: [],
	unresolved: [],
}
