/**
 * What each delegated agent returns, and the one way its text becomes a value.
 *
 * The skill: "Return exactly one JSON object, with no surrounding prose", and the parent discards a
 * malformed or prose-wrapped result without repairing it. `decodeAgentJson` is that rule. A lone
 * markdown fence around the object is formatting, not prose, and is the only thing it strips.
 *
 * Maple additions, because the parent here is code rather than a model: critic `missing_units`
 * carry `canonical_refs` and `ordinary_attack_class_block`, so the parent can derive the unit's
 * `coverage_id` and assignment block map without judgment of its own. A needs_validation
 * proposal or verdict may carry `estimated_severity` beside its record, never inside it.
 */
import { Effect, Option, Schema, SchemaIssue } from "effect"
import { findingsErrors } from "./validators"
import {
	CanonicalRefs,
	Check,
	ConfirmedFinding,
	EstimatedSeverity,
	ExcludedBlock,
	type Finding,
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
		/** Where the answer broke its contract, as value-free paths. Empty when it was not one object. */
		issuePaths: Schema.Array(Schema.String),
	},
) {}

/** The object inside a lone markdown fence, by plain string operations (no backtracking regex). */
const unfence = (text: string): string => {
	if (!text.startsWith("```") || !text.endsWith("```") || text.length < 6) return text
	const firstNewline = text.indexOf("\n")
	if (firstNewline < 0) return text
	const opener = text.slice(3, firstNewline).trim()
	return opener === "" || opener === "json" ? text.slice(firstNewline + 1, -3).trim() : text
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

/** Each failing path, keys only (each capped), so no decoded value reaches a log. */
const issuePaths = (issue: SchemaIssue.Issue): ReadonlyArray<string> => [
	...new Set(
		formatIssues(issue).issues.map(({ path = [] }) =>
			path.length === 0
				? "$"
				: path
						.map((segment) =>
							String(typeof segment === "object" ? segment.key : segment).slice(0, 40),
						)
						.join("."),
		),
	),
]

/** Exactly one JSON object, or a typed failure the parent answers by discarding the result. */
export const decodeAgentJson = <S extends Schema.Top>(role: string, schema: S, text: string) =>
	Effect.gen(function* () {
		const trimmed = text.trim()
		const body = unfence(trimmed)
		const fail = (message: string, issuePaths: ReadonlyArray<string>) =>
			new SecurityAuditResultError({ message, role, rawExcerpt: trimmed.slice(0, 400), issuePaths })
		if (!body.startsWith("{") || !body.endsWith("}")) {
			return yield* fail(`${role} answered prose, not exactly one JSON object`, [])
		}
		return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body).pipe(
			Effect.mapError((cause) =>
				fail(
					`${role} result is not valid JSON for its contract: ${cause.message}`,
					issuePaths(cause.issue),
				),
			),
		)
	})

const { verdict: _c, ...confirmedFields } = ConfirmedFinding.fields
const { verdict: _n, ...needsValidationFields } = NeedsValidationFinding.fields

export const Candidate = Schema.Union([
	Schema.Struct({ proposed_verdict: Schema.Literal("confirmed"), ...confirmedFields }),
	Schema.Struct({
		proposed_verdict: Schema.Literal("needs_validation"),
		...needsValidationFields,
		// Read leniently: a missing or malformed estimate leaves the lead unscored, never discards it.
		estimated_severity: Schema.optionalKey(Schema.Unknown),
	}),
])
export type Candidate = typeof Candidate.Type

/** An agent's estimate if it has the contract's shape; anything else counts as none. */
const estimateOf = (value: unknown): EstimatedSeverity | null =>
	Option.getOrNull(Schema.decodeUnknownOption(EstimatedSeverity)(value))

/**
 * A candidate as the finding record it proposes, so the upstream validator can check it. The
 * estimate is Maple's, not the skill's: it never reaches the record.
 */
export const candidateRecord = (candidate: Candidate): Finding => {
	if (candidate.proposed_verdict === "confirmed") {
		const { proposed_verdict, ...rest } = candidate
		return { verdict: proposed_verdict, ...rest }
	}
	const { proposed_verdict, estimated_severity: _estimate, ...rest } = candidate
	return { verdict: proposed_verdict, ...rest }
}

/** A hunter's estimate for its needs_validation proposal; null for a proposed confirmation. */
export const candidateEstimate = (candidate: Candidate): EstimatedSeverity | null =>
	candidate.proposed_verdict === "needs_validation" ? estimateOf(candidate.estimated_severity) : null

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

/** Phase 3: the record matches the branch the decision names; a needs_validation one carries an estimate. */
export const CandidateVerdict = Schema.Union([
	Schema.Struct({ decision: Schema.Literal("confirmed"), record: ConfirmedFinding }),
	Schema.Struct({
		decision: Schema.Literal("needs_validation"),
		record: NeedsValidationFinding,
		estimated_severity: Schema.optionalKey(Schema.Unknown),
	}),
	Schema.Struct({ decision: Schema.Literal("rejected"), record: RejectedFinding }),
])
export type CandidateVerdict = typeof CandidateVerdict.Type

const replace = { decision: Schema.Literal("replace"), reason: Schema.String }

/** Phase 5; a needs_validation replacement carries its estimate beside the record. */
export const RecordVerdict = Schema.Union([
	Schema.Struct({ decision: Schema.Literal("verified"), fingerprint: Schema.String }),
	Schema.Struct({ ...replace, record: ConfirmedFinding }),
	Schema.Struct({
		...replace,
		record: NeedsValidationFinding,
		estimated_severity: Schema.optionalKey(Schema.Unknown),
	}),
	Schema.Struct({ ...replace, record: RejectedFinding }),
])
export type RecordVerdict = typeof RecordVerdict.Type

/** The estimate a verdict settles on: a needs_validation decision's own, otherwise none. */
export const verdictEstimate = (
	verdict: CandidateVerdict | Extract<RecordVerdict, { readonly decision: "replace" }>,
): EstimatedSeverity | null =>
	"estimated_severity" in verdict ? estimateOf(verdict.estimated_severity) : null

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
	/** 1 is hunted first: lowest-trust surfaces, then the most valuable boundaries (skill ranking 1 and 2). */
	priority: Schema.optionalKey(Schema.Int),
})
export type SeedUnit = typeof SeedUnit.Type

/** Reconnaissance synthesis: the parent's `architecture.md` and the initial ledger's units. */
export const SynthesisResult = Schema.Struct({
	architecture_md: Schema.String,
	units: Schema.Array(SeedUnit),
})
export type SynthesisResult = typeof SynthesisResult.Type
