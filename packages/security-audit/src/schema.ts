/**
 * Typed views of the skill's records, keyed exactly as the skill writes them (snake_case wire
 * format). These decode; the upstream validators in `./validators` decide validity, so the two
 * never disagree about the contract.
 */
import { Schema } from "effect"

const Score = Schema.Literals(["informational", "low", "medium", "high", "critical"])
export type Severity = typeof Score.Type

export const TraceStep = Schema.Struct({
	kind: Schema.Literals(["entrypoint", "propagation", "sink"]),
	file: Schema.String,
	line: Schema.Int,
	scope: Schema.String,
	description: Schema.String,
})

export const Evidence = Schema.Struct({
	file: Schema.String,
	line: Schema.Int,
	description: Schema.String,
})

const Condition = Schema.Struct({
	kind: Schema.Literals([
		"authentication_level",
		"authorization_role",
		"user_interaction",
		"system_configuration",
		"network_routing",
		"environmental_dependency",
		"data_state",
		"timing_dependency",
		"third_party_dependency",
	]),
	description: Schema.String,
})

const Rated = Schema.Struct({ score: Score, reason: Schema.String })

const common = {
	fingerprint: Schema.String,
	title: Schema.String,
	description: Schema.String,
	trace: Schema.Array(TraceStep),
	evidence: Schema.Array(Evidence),
}

export const ConfirmedFinding = Schema.Struct({
	verdict: Schema.Literal("confirmed"),
	...common,
	root_cause: Schema.String,
	intended_behavior: Schema.String,
	conditions: Schema.Array(Condition),
	execution: Schema.Struct({
		attacker_perspective: Schema.String,
		payloads: Schema.Array(Schema.String),
		instructions: Schema.Array(Schema.String),
		observed_result: Schema.String,
	}),
	remediation: Schema.Struct({
		strategy: Schema.String,
		code_changes: Schema.optionalKey(
			Schema.Array(Schema.Struct({ file_name: Schema.String, fixed_code: Schema.String })),
		),
	}),
	severity: Schema.Struct({ likelihood: Rated, impact: Rated, overall_severity: Score }),
	confidence: Schema.Struct({ score: Schema.Literals(["low", "medium", "high"]), reason: Schema.String }),
})

export const NeedsValidationFinding = Schema.Struct({
	verdict: Schema.Literal("needs_validation"),
	...common,
	claimed_root_cause: Schema.String,
	blockers: Schema.Array(Schema.String),
	validation_plan: Schema.Struct({
		local: Schema.optionalKey(Schema.String),
		deployment: Schema.optionalKey(Schema.String),
	}),
})

export const RejectedFinding = Schema.Struct({
	verdict: Schema.Literal("rejected"),
	...common,
	claimed_root_cause: Schema.String,
	reason: Schema.String,
})

export const Finding = Schema.Union([ConfirmedFinding, NeedsValidationFinding, RejectedFinding])
export type Finding = typeof Finding.Type
export type Verdict = Finding["verdict"]

export const CanonicalRefs = Schema.Struct({
	surface: Schema.String,
	boundary: Schema.String,
	subsystem: Schema.String,
	attack_class: Schema.String,
	lifecycle: Schema.optionalKey(Schema.String),
})
export type CanonicalRefs = typeof CanonicalRefs.Type

export const ExcludedBlock = Schema.Struct({ block: Schema.String, reason: Schema.String })

export const Check = Schema.Struct({
	agent_id: Schema.String,
	reviewed_paths: Schema.Array(Schema.String),
	invariant: Schema.String,
	method: Schema.Literals(["source", "local"]),
	result: Schema.String,
	artifact: Schema.NullOr(Schema.String),
})
export type Check = typeof Check.Type

export const UnitStatus = Schema.Literals([
	"planned",
	"not_applicable",
	"out_of_scope",
	"deferred",
	"in_progress",
	"blocked",
	"covered",
	"candidate",
])
export type UnitStatus = typeof UnitStatus.Type

export const PriorStatus = Schema.Literals([
	"new",
	"prior_confirmed_same_source",
	"prior_confirmed_changed_source",
	"prior_needs_validation",
	"prior_deferred",
	"prior_blocked",
	"prior_out_of_scope",
	"prior_covered_same_source",
	"prior_covered_changed_source",
	"prior_rejected_claim_changed",
	"none",
])

const attemptFields = {
	wave: Schema.Int,
	status: UnitStatus,
	agent_id: Schema.NullOr(Schema.String),
	reviewed_paths: Schema.Array(Schema.String),
	local_checks: Schema.Array(Check),
	result_fingerprints: Schema.Array(Schema.String),
	unresolved: Schema.Array(Schema.String),
}

export const Attempt = Schema.Struct({ ...attemptFields, reassignment_reason: Schema.String })

/** One coverage-ledger unit. The skill's state table is enforced by the upstream validator. */
export const CoverageUnit = Schema.Struct({
	// Parent bookkeeping beside the semantic fields (the skill allows it), kept so it survives storage.
	priority: Schema.optionalKey(Schema.Int),
	hardening: Schema.optionalKey(Schema.Array(Schema.String)),
	failed_attempts: Schema.optionalKey(Schema.Int),
	carried_fingerprint: Schema.optionalKey(Schema.String),
	decisions: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	resolved_prior_leads: Schema.optionalKey(Schema.Array(Schema.String)),
	coverage_id: Schema.String,
	canonical_refs: CanonicalRefs,
	surface: Schema.String,
	boundary: Schema.String,
	subsystem: Schema.String,
	attack_class: Schema.String,
	lifecycle: Schema.optionalKey(Schema.String),
	starting_paths: Schema.Array(Schema.String),
	ordinary_attack_class_block: Schema.NullOr(Schema.String),
	selected_companion_blocks: Schema.Array(Schema.String),
	excluded_blocks: Schema.Array(ExcludedBlock),
	prior_status: PriorStatus,
	attempts: Schema.Array(Attempt),
	...attemptFields,
})
export type CoverageUnit = typeof CoverageUnit.Type

export const Ledger = Schema.Array(CoverageUnit)
export const Findings = Schema.Array(Finding)
