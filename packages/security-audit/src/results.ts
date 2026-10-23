/**
 * What each delegated agent returns, and the one way its text becomes a value.
 *
 * The skill: "Return exactly one JSON object, with no surrounding prose", and the parent discards a
 * malformed or prose-wrapped result without repairing it. `decodeAgentJson` is that rule. A lone
 * markdown fence around the object is formatting, not prose, and is the only thing it strips.
 *
 * Maple additions, because the parent here is code rather than a model: critic `missing_units`
 * carry `canonical_refs` and `ordinary_attack_class_block`, so the parent can derive the unit's
 * `coverage_id` and assignment block map without judgment of its own.
 */
import { Effect, Schema } from "effect"
import { findingsErrors } from "./validators"
import {
	CanonicalRefs,
	Check,
	ConfirmedFinding,
	ExcludedBlock,
	type Finding,
	Finding as FindingSchema,
	NeedsValidationFinding,
	RejectedFinding,
} from "./schema"

export class SecurityAuditResultError extends Schema.TaggedError<SecurityAuditResultError>()(
	"@maple/security-audit/ResultError",
	{
		message: Schema.String,
		role: Schema.String,
		/** The first characters of what the agent answered, for the run log. */
		rawExcerpt: Schema.String,
	},
) {}

const FENCED = /^```(?:json)?\s*\n([\s\S]*)\n```$/

/** Exactly one JSON object, or a typed failure the parent answers by discarding the result. */
export const decodeAgentJson = <S extends Schema.Top>(role: string, schema: S, text: string) =>
	Effect.gen(function* () {
		const trimmed = text.trim()
		const body = FENCED.exec(trimmed)?.[1]?.trim() ?? trimmed
		const fail = (message: string) =>
			new SecurityAuditResultError({ message, role, rawExcerpt: trimmed.slice(0, 400) })
		if (!body.startsWith("{") || !body.endsWith("}")) {
			return yield* fail(`${role} answered prose, not exactly one JSON object`)
		}
		return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body).pipe(
			Effect.mapError((cause) =>
				fail(`${role} result is not valid JSON for its contract: ${cause.message}`),
			),
		)
	})

const { verdict: _c, ...confirmedFields } = ConfirmedFinding.fields
const { verdict: _n, ...needsValidationFields } = NeedsValidationFinding.fields

export const Candidate = Schema.Union([
	Schema.Struct({ proposed_verdict: Schema.Literal("confirmed"), ...confirmedFields }),
	Schema.Struct({ proposed_verdict: Schema.Literal("needs_validation"), ...needsValidationFields }),
])
export type Candidate = typeof Candidate.Type

/** A candidate as the finding record it proposes, so the upstream validator can check it. */
export const candidateRecord = (candidate: Candidate): Finding => {
	const { proposed_verdict, ...rest } = candidate
	return { verdict: proposed_verdict, ...rest } as Finding
}

/** Upstream contract errors for one candidate; empty means it is a well-formed record. */
export const candidateErrors = (candidate: Candidate): ReadonlyArray<string> =>
	findingsErrors([candidateRecord(candidate)])

const SurfaceProposal = {
	surface: Schema.String,
	boundary: Schema.String,
	subsystem: Schema.String,
	attack_class: Schema.String,
	starting_paths: Schema.Array(Schema.String),
	reason: Schema.String,
}

export const HunterUnitResult = Schema.Struct({
	coverage_id: Schema.String,
	disposition: Schema.Literals(["covered", "candidate", "blocked"]),
	reviewed_paths: Schema.Array(Schema.String),
	checks: Schema.Array(Check),
	candidate_fingerprints: Schema.Array(Schema.String),
	unresolved: Schema.Array(Schema.String),
})
export type HunterUnitResult = typeof HunterUnitResult.Type

export const HunterResult = Schema.Struct({
	units: Schema.Array(HunterUnitResult),
	candidates: Schema.Array(Candidate),
	hardening: Schema.Array(Schema.String),
	uncovered: Schema.Array(Schema.Struct(SurfaceProposal)),
})
export type HunterResult = typeof HunterResult.Type
export type UncoveredSurface = HunterResult["uncovered"][number]

export const MissingUnit = Schema.Struct({
	...SurfaceProposal,
	canonical_refs: CanonicalRefs,
	lifecycle: Schema.optionalKey(Schema.String),
	ordinary_attack_class_block: Schema.NullOr(Schema.String),
	selected_companion_blocks: Schema.Array(Schema.String),
	excluded_blocks: Schema.Array(ExcludedBlock),
})
export type MissingUnit = typeof MissingUnit.Type

export const CriticResult = Schema.Struct({
	missing_units: Schema.Array(MissingUnit),
	reassign_ids: Schema.Array(Schema.String),
	resolved_prior_leads: Schema.Array(Schema.String),
	stop: Schema.Boolean,
})
export type CriticResult = typeof CriticResult.Type

/** Phase 3: the record matches the branch the decision names. */
export const CandidateVerdict = Schema.Union([
	Schema.Struct({ decision: Schema.Literal("confirmed"), record: ConfirmedFinding }),
	Schema.Struct({ decision: Schema.Literal("needs_validation"), record: NeedsValidationFinding }),
	Schema.Struct({ decision: Schema.Literal("rejected"), record: RejectedFinding }),
])
export type CandidateVerdict = typeof CandidateVerdict.Type

/** Phase 5. */
export const RecordVerdict = Schema.Union([
	Schema.Struct({ decision: Schema.Literal("verified"), fingerprint: Schema.String }),
	Schema.Struct({ decision: Schema.Literal("replace"), reason: Schema.String, record: FindingSchema }),
])
export type RecordVerdict = typeof RecordVerdict.Type

/** A seeded ledger unit's semantic fields, as reconnaissance synthesis proposes them. */
export const SeedUnit = Schema.Struct({
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
})
export type SeedUnit = typeof SeedUnit.Type

/** Reconnaissance synthesis: the parent's `architecture.md` and the initial ledger's units. */
export const SynthesisResult = Schema.Struct({
	architecture_md: Schema.String,
	units: Schema.Array(SeedUnit),
})
export type SynthesisResult = typeof SynthesisResult.Type
