/**
 * Phases 3 to 5: every unique candidate (and every carried prior record) goes to a fresh verifier
 * that did not hunt it; the records are checked with the upstream findings validator; then, outside
 * `quick`, a second fresh verifier checks each final confirmed and needs_validation record, and a
 * material replacement only applies after yet another fresh verifier agrees.
 */
import { Effect, Ref } from "effect"
import { candidateVerifierPrompt, companionFileOf, recordVerifierPrompt } from "../prompts"
import {
	type Candidate,
	candidateEstimate,
	CandidateVerdict,
	RecordVerdict,
	verdictEstimate,
} from "../results"
import type { EstimatedSeverity, Finding } from "../schema"
import { findingsErrors } from "../validators"
import { strongest } from "./hunt"
import type { LedgerUnit } from "./ledger"
import type { AuditStoreError } from "./ports"
import { type Engine, type EngineState, withEstimate } from "./state"

const MAX_MATERIAL_CHAIN = 3

interface ValidationItem {
	readonly fingerprint: string
	/** The hunter's proposal, or the carried prior record. */
	readonly claim: Candidate | Finding
	/** Every unit carrying this prior record; one verifier decides for all of them. */
	readonly carriedUnits: ReadonlyArray<string>
}

/** The hunter's estimate for a proposed lead, else the level the lead was last stored at. */
const claimEstimate = (engine: Engine, claim: Candidate | Finding): EstimatedSeverity | null => {
	const proposed = "proposed_verdict" in claim ? candidateEstimate(claim) : null
	if (proposed !== null) return proposed
	// A carried lead, or one a hunter raised again without an estimate, keeps its last level.
	const level = engine.input.prior?.estimates?.get(claim.fingerprint)
	if (level === undefined) return null
	const carried = { score: level, reason: "Carried from the previous run's estimate." }
	return { likelihood: carried, impact: carried, overall_severity: level }
}

const files = (record: Finding): ReadonlyArray<string> => [
	...new Set([...record.trace.map((t) => t.file), ...record.evidence.map((e) => e.file)]),
]

const linkedUnits = (ledger: ReadonlyArray<LedgerUnit>, fingerprint: string) =>
	ledger.filter(
		(unit) => unit.result_fingerprints.includes(fingerprint) || unit.carried_fingerprint === fingerprint,
	)

const validationBlocks = (units: ReadonlyArray<LedgerUnit>): ReadonlyArray<string> => [
	...new Set(
		units.flatMap((unit) =>
			unit.selected_companion_blocks.map((ref) => `${companionFileOf(ref)}#Validation rules`),
		),
	),
]

/**
 * One item per fingerprint. A carried record a hunter raised again is one item: the hunter's fresh
 * claim is what the verifier checks, and every carried unit still takes the decision.
 */
const items = (s: EngineState): ReadonlyArray<ValidationItem> => {
	const carried = s.carried.reduce(
		(acc, c) =>
			new Map(acc).set(c.record.fingerprint, {
				record: c.record,
				units: [...(acc.get(c.record.fingerprint)?.units ?? []), c.coverageId],
			}),
		new Map<string, { readonly record: Finding; readonly units: ReadonlyArray<string> }>(),
	)
	const raised = [...s.candidates].flatMap(([fingerprint, entries]): ReadonlyArray<ValidationItem> => {
		const best = strongest(entries)
		if (best === undefined) return []
		return [{ fingerprint, claim: best.candidate, carriedUnits: carried.get(fingerprint)?.units ?? [] }]
	})
	const onlyCarried = [...carried]
		.filter(([fingerprint]) => !s.candidates.has(fingerprint))
		.map(([fingerprint, c]) => ({ fingerprint, claim: c.record, carriedUnits: c.units }))
	return [...raised, ...onlyCarried].sort((a, b) =>
		a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0,
	)
}

/**
 * Concurrent verifiers only when nothing is rationed: under a finite budget, who gets the last
 * invocation must not depend on completion order, or a replay would spend differently.
 */
const validationConcurrency = (engine: Engine) =>
	engine.input.budget === null ? (engine.input.concurrency ?? 4) : 1

/** Records a decision on every linked unit; a carried unit's re-check becomes its first check. */
const recordDecision = (
	s: EngineState,
	item: ValidationItem,
	record: Finding,
	estimate: EstimatedSeverity | null,
	verifierId: string,
): EngineState => {
	const ledger = s.ledger.map((unit): LedgerUnit => {
		const carries = item.carriedUnits.includes(unit.coverage_id)
		if (carries && unit.status === "candidate" && unit.agent_id !== null) {
			// A unit carrying several records: each later decision adds its own check and fingerprint.
			const check = {
				agent_id: verifierId,
				reviewed_paths: [...files(record)].sort(),
				invariant: record.title,
				method: "source" as const,
				result: `re-verified the carried record against current source: ${record.verdict}`,
				artifact: null,
			}
			return {
				...unit,
				reviewed_paths: [...new Set([...unit.reviewed_paths, ...check.reviewed_paths])].sort(),
				local_checks: [...unit.local_checks, check],
				result_fingerprints: [...new Set([...unit.result_fingerprints, record.fingerprint])],
				decisions: { ...unit.decisions, [record.fingerprint]: record.verdict },
			}
		}
		if (carries) {
			return {
				...unit,
				status: "candidate",
				agent_id: verifierId,
				reviewed_paths: [...files(record)].sort(),
				local_checks: [
					{
						agent_id: verifierId,
						reviewed_paths: [...files(record)].sort(),
						invariant: record.title,
						method: "source",
						result: `re-verified the carried record against current source: ${record.verdict}`,
						artifact: null,
					},
				],
				result_fingerprints: [record.fingerprint],
				decisions: { ...unit.decisions, [record.fingerprint]: record.verdict },
			}
		}
		return unit.result_fingerprints.includes(record.fingerprint)
			? { ...unit, decisions: { ...unit.decisions, [record.fingerprint]: record.verdict } }
			: unit
	})
	return {
		...s,
		ledger,
		findings: new Map(s.findings).set(record.fingerprint, record),
		estimates: withEstimate(s.estimates, record.fingerprint, estimate),
	}
}

const validateOne = (engine: Engine, item: ValidationItem, index: number) =>
	Effect.gen(function* () {
		const attempt = (suffix: string) =>
			Effect.gen(function* () {
				if ((yield* engine.remaining) < 1) return { _tag: "budget" } as const
				const s = yield* Ref.get(engine.state)
				const linked = linkedUnits(s.ledger, item.fingerprint)
				const agentId = `verify-${index + 1}${suffix}`
				const prompt = candidateVerifierPrompt(
					{
						candidate: item.claim,
						linkedChecks: linked.flatMap((unit) => unit.local_checks),
						architectureFacts: s.architectureMd,
						companionValidationBlocks: validationBlocks(linked),
						priorRecords: (engine.input.prior?.findings ?? []).filter(
							(r) => r.fingerprint === item.fingerprint,
						),
						priorEstimate: engine.input.prior?.estimates?.get(item.fingerprint) ?? null,
						includeRecordChecks: engine.input.profile === "quick",
					},
					engine.context(agentId),
				)
				const verdict = yield* engine.invoke("candidate-verifier", agentId, prompt, CandidateVerdict)
				// A different fingerprint would be a new root cause needing its own validation: not taken here.
				if (verdict === undefined) return { _tag: "unusable" } as const
				if (verdict.record.fingerprint !== item.fingerprint)
					return { _tag: "other-root-cause" } as const
				if (findingsErrors([verdict.record]).length > 0) return { _tag: "unusable" } as const
				// The verifier's estimate replaces the hunter's; without one, the hunter's stands.
				return {
					_tag: "decided",
					record: verdict.record,
					estimate:
						verdict.decision === "needs_validation"
							? (verdictEstimate(verdict) ?? claimEstimate(engine, item.claim))
							: null,
					agentId,
				} as const
			})
		// A malformed result is discarded and re-run once with a fresh verifier when the budget permits.
		const first = yield* attempt("")
		const decided = first._tag === "decided" || first._tag === "budget" ? first : yield* attempt("-r1")
		if (decided._tag !== "decided") {
			const reason =
				decided._tag === "budget"
					? "validation_budget_exhausted"
					: decided._tag === "other-root-cause"
						? "verifier_named_a_different_root_cause"
						: "verifier_result_unusable"
			yield* engine.fail(
				reason === "validation_budget_exhausted" ? reason : "candidate_validation_failed",
			)
			// The skill: an unvalidated candidate stays a ledger candidate with its unresolved reason.
			yield* engine.mutate((s) => [
				undefined,
				{
					...s,
					ledger: s.ledger.map((unit) =>
						unit.result_fingerprints.includes(item.fingerprint) ||
						item.carriedUnits.includes(unit.coverage_id)
							? { ...unit, unresolved: [...unit.unresolved, `${item.fingerprint}: ${reason}`] }
							: unit,
					),
				},
			])
			return
		}
		yield* engine.mutate((s) => [
			undefined,
			recordDecision(s, item, decided.record, decided.estimate, decided.agentId),
		])
	})

/** Phase 3. */
export const runCandidateValidation = (engine: Engine) =>
	Effect.gen(function* () {
		const s = yield* Ref.get(engine.state)
		const work = items(s)
		yield* engine.event({
			_tag: "Phase",
			phase: "candidate-validation",
			detail: `${work.length} unique candidates`,
		})
		yield* Effect.forEach(work, (item, index) => validateOne(engine, item, index), {
			concurrency: validationConcurrency(engine),
			discard: true,
		})
		// A carried unit no verifier decided is still unassigned work, deferred with its verifier's reason.
		yield* engine.mutate((c) => [
			undefined,
			{
				...c,
				ledger: c.ledger.map((unit) =>
					unit.status === "planned" && unit.carried_fingerprint !== undefined
						? {
								...unit,
								status: "deferred",
								unresolved:
									unit.unresolved.length > 0
										? unit.unresolved
										: ["carried_record_not_validated"],
							}
						: unit,
				),
			},
		])
		yield* engine.persist
	})

/** The trace's structure: step kinds, files and scopes, without line numbers or prose. */
const tracePath = (record: Finding) => record.trace.map(({ kind, file, scope }) => [kind, file, scope])

/** A record's material fields; prose reasons and descriptions are wording, not meaning. */
const materialView = (record: Finding) => {
	switch (record.verdict) {
		case "confirmed":
			return {
				root_cause: record.root_cause,
				conditions: record.conditions.map((c) => c.kind),
				payloads: record.execution.payloads,
				instructions: record.execution.instructions,
				likelihood: record.severity.likelihood.score,
				impact: record.severity.impact.score,
				overall: record.severity.overall_severity,
				confidence: record.confidence.score,
			}
		case "needs_validation":
		case "rejected":
			return { root_cause: record.claimed_root_cause }
	}
}

/**
 * The skill's material change: verdict, root cause, trace (beyond line numbers), execution input,
 * impact or severity. Rewording a reason or description is not material.
 */
export const isMaterial = (before: Finding, after: Finding): boolean =>
	before.verdict !== after.verdict ||
	JSON.stringify(tracePath(before)) !== JSON.stringify(tracePath(after)) ||
	JSON.stringify(materialView(before)) !== JSON.stringify(materialView(after))

/** A record with the estimate that travels beside it (null unless it is needs_validation). */
interface Estimated {
	readonly record: Finding
	readonly estimate: EstimatedSeverity | null
}

/**
 * The final record, or why there is none: `verifier` when a verifier failed or its answer was
 * unusable twice, `unfunded` for the budget, `unsettled` when replacements never converged.
 */
type RecordCheck =
	| ({ readonly _tag: "Final" } & Estimated)
	| { readonly _tag: "Unchecked"; readonly reason: "verifier" | "unfunded" | "unsettled" }

const unchecked = (reason: "verifier" | "unfunded" | "unsettled"): RecordCheck => ({
	_tag: "Unchecked",
	reason,
})

const verifyRecord = (engine: Engine, start: Estimated, index: number) =>
	Effect.gen(function* () {
		const step = (
			current: Estimated,
			depth: number,
			retried: boolean,
		): Effect.Effect<RecordCheck, AuditStoreError> =>
			Effect.gen(function* () {
				if ((yield* engine.remaining) < 1) return unchecked("unfunded")
				if (depth > MAX_MATERIAL_CHAIN) return unchecked("unsettled")
				const agentId = `record-${index + 1}-${depth}${retried ? "-r1" : ""}`
				const verdict = yield* engine.invoke(
					"record-verifier",
					agentId,
					recordVerifierPrompt(current.record, engine.context(agentId), current.estimate),
					RecordVerdict,
				)
				const usable =
					verdict !== undefined &&
					(verdict.decision === "verified"
						? verdict.fingerprint === current.record.fingerprint
						: verdict.record.fingerprint === current.record.fingerprint &&
							findingsErrors([verdict.record]).length === 0)
				if (!usable) return retried ? unchecked("verifier") : yield* step(current, depth, true)
				if (verdict.decision === "verified") return { _tag: "Final", ...current } as const
				// A revised estimate alone is not material: it is Maple's, outside the skill's record.
				const next = {
					record: verdict.record,
					estimate:
						verdict.record.verdict === "needs_validation"
							? (verdictEstimate(verdict) ?? current.estimate)
							: null,
				}
				return isMaterial(current.record, verdict.record)
					? yield* step(next, depth + 1, false)
					: ({ _tag: "Final", ...next } as const)
			})
		return yield* step(start, 0, false)
	})

/** Phase 5; skipped by `quick`, whose Phase 3 verifier already did these checks. */
export const runRecordVerification = (engine: Engine) =>
	Effect.gen(function* () {
		if (engine.input.profile === "quick") return
		const s = yield* Ref.get(engine.state)
		const records = [...s.findings.values()]
			.filter((record) => record.verdict !== "rejected")
			.sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1))
		yield* engine.event({
			_tag: "Phase",
			phase: "record-verification",
			detail: `${records.length} records`,
		})
		yield* Effect.forEach(
			records,
			(record, index) =>
				Effect.gen(function* () {
					const checked = yield* verifyRecord(
						engine,
						{ record, estimate: s.estimates.get(record.fingerprint) ?? null },
						index,
					)
					if (checked._tag === "Unchecked" && checked.reason === "verifier") {
						// A failed verifier says nothing about the record: it stays as candidate validation
						// decided it, marked on its units as not re-checked, and the run is incomplete.
						yield* engine.mutate((c) => [
							undefined,
							{
								...c,
								ledger: c.ledger.map((unit) =>
									unit.result_fingerprints.includes(record.fingerprint) ||
									unit.carried_fingerprint === record.fingerprint
										? {
												...unit,
												not_rechecked: [
													...new Set([
														...(unit.not_rechecked ?? []),
														record.fingerprint,
													]),
												],
											}
										: unit,
								),
							},
						])
						yield* engine.gap(
							`record ${record.fingerprint} kept as ${record.verdict} without its final re-check: the record verifier failed`,
						)
						yield* engine.fail("record_verification_incomplete")
						return
					}
					if (checked._tag === "Unchecked") {
						// No independent final review: the record leaves findings.json and the run is incomplete.
						yield* engine.mutate((c) => {
							const findings = new Map(c.findings)
							findings.delete(record.fingerprint)
							return [
								undefined,
								{
									...c,
									findings,
									estimates: withEstimate(c.estimates, record.fingerprint, null),
								},
							]
						})
						yield* engine.fail("record_verification_incomplete")
						return
					}
					const final = checked.record
					yield* engine.mutate((c) => [
						undefined,
						{
							...c,
							findings: new Map(c.findings).set(final.fingerprint, final),
							estimates: withEstimate(c.estimates, final.fingerprint, checked.estimate),
							ledger: c.ledger.map((unit) =>
								unit.result_fingerprints.includes(final.fingerprint)
									? {
											...unit,
											decisions: {
												...unit.decisions,
												[final.fingerprint]: final.verdict,
											},
										}
									: unit,
							),
						},
					])
				}),
			{ concurrency: validationConcurrency(engine), discard: true },
		)
		yield* engine.persist
	})

/** Phase 4: the final document, sorted by fingerprint and passed through the upstream validator. */
export const finalFindings = (s: EngineState): ReadonlyArray<Finding> =>
	[...s.findings.values()].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1))
