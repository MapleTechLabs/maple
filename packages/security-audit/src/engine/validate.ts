/**
 * Phases 3 to 5: every unique candidate (and every carried prior record) goes to a fresh verifier
 * that did not hunt it; the records are checked with the upstream findings validator; then, outside
 * `quick`, a second fresh verifier checks each final confirmed and needs_validation record, and a
 * material replacement only applies after yet another fresh verifier agrees.
 */
import { Effect, Ref } from "effect"
import { candidateVerifierPrompt, recordVerifierPrompt } from "../prompts"
import { type Candidate, CandidateVerdict, RecordVerdict } from "../results"
import type { Finding } from "../schema"
import { findingsErrors } from "../validators"
import { strongest } from "./hunt"
import type { LedgerUnit } from "./ledger"
import type { AuditStoreError } from "./ports"
import type { Engine, EngineState } from "./state"

const MAX_MATERIAL_CHAIN = 3

interface ValidationItem {
	readonly fingerprint: string
	/** The hunter's proposal, or the carried prior record. */
	readonly claim: Candidate | Finding
	readonly carriedUnit?: string
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
			unit.selected_companion_blocks.map((ref) => `${ref.slice(0, ref.indexOf("#"))}#Validation rules`),
		),
	),
]

/**
 * One item per fingerprint. A carried record a hunter raised again is one item: the hunter's fresh
 * claim is what the verifier checks, and the carried unit still takes the decision.
 */
const items = (s: EngineState): ReadonlyArray<ValidationItem> => {
	const carried = new Map(s.carried.map((c) => [c.record.fingerprint, c] as const))
	const raised = [...s.candidates].flatMap(([fingerprint, entries]): ReadonlyArray<ValidationItem> => {
		const best = strongest(entries)
		const unit = carried.get(fingerprint)?.coverageId
		if (best === undefined) return []
		return [
			unit === undefined
				? { fingerprint, claim: best.candidate }
				: { fingerprint, claim: best.candidate, carriedUnit: unit },
		]
	})
	const onlyCarried = [...carried.values()]
		.filter((c) => !s.candidates.has(c.record.fingerprint))
		.map((c) => ({ fingerprint: c.record.fingerprint, claim: c.record, carriedUnit: c.coverageId }))
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
	verifierId: string,
): EngineState => {
	const ledger = s.ledger.map((unit): LedgerUnit => {
		if (unit.coverage_id === item.carriedUnit) {
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
	return { ...s, ledger, findings: new Map(s.findings).set(record.fingerprint, record) }
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
				return { _tag: "decided", record: verdict.record, agentId } as const
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
						unit.result_fingerprints.includes(item.fingerprint)
							? { ...unit, unresolved: [...unit.unresolved, `${item.fingerprint}: ${reason}`] }
							: unit,
					),
				},
			])
			return
		}
		yield* engine.mutate((s) => [undefined, recordDecision(s, item, decided.record, decided.agentId)])
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
		// A carried unit no verifier reached is still unassigned work, disclosed as such.
		yield* engine.mutate((c) => [
			undefined,
			{
				...c,
				ledger: c.ledger.map((unit) =>
					unit.status === "planned" && unit.carried_fingerprint !== undefined
						? { ...unit, status: "deferred", unresolved: ["validation_budget_exhausted"] }
						: unit,
				),
			},
		])
		yield* engine.persist
	})

const VERDICT_RANK = { rejected: 0, needs_validation: 1, confirmed: 2 } as const

const stripLines = (record: Finding) => record.trace.map(({ line: _line, ...step }) => step)

/** The skill's material change: verdict, root cause, trace (beyond line numbers), execution, impact or severity. */
export const isMaterial = (before: Finding, after: Finding): boolean => {
	if (VERDICT_RANK[before.verdict] !== VERDICT_RANK[after.verdict]) return true
	if (JSON.stringify(stripLines(before)) !== JSON.stringify(stripLines(after))) return true
	const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)
	if (before.verdict === "confirmed" && after.verdict === "confirmed") {
		return (
			before.root_cause !== after.root_cause ||
			differs(before.execution, after.execution) ||
			differs(before.conditions, after.conditions) ||
			differs(before.severity, after.severity) ||
			differs(before.confidence, after.confidence)
		)
	}
	if (before.verdict === "needs_validation" && after.verdict === "needs_validation") {
		return (
			before.claimed_root_cause !== after.claimed_root_cause ||
			differs(before.blockers, after.blockers) ||
			differs(before.validation_plan, after.validation_plan)
		)
	}
	if (before.verdict === "rejected" && after.verdict === "rejected") {
		return before.claimed_root_cause !== after.claimed_root_cause
	}
	return true
}

const verifyRecord = (engine: Engine, record: Finding, index: number) =>
	Effect.gen(function* () {
		const step = (
			current: Finding,
			pendingMaterial: boolean,
			depth: number,
			retried: boolean,
		): Effect.Effect<Finding | undefined, AuditStoreError> =>
			Effect.gen(function* () {
				if ((yield* engine.remaining) < 1 || depth > MAX_MATERIAL_CHAIN) return undefined
				const agentId = `record-${index + 1}-${depth}${retried ? "-r1" : ""}`
				const verdict = yield* engine.invoke(
					"record-verifier",
					agentId,
					recordVerifierPrompt(current, engine.context(agentId)),
					RecordVerdict,
				)
				const usable =
					verdict !== undefined &&
					(verdict.decision === "verified"
						? verdict.fingerprint === current.fingerprint
						: verdict.record.fingerprint === current.fingerprint &&
							findingsErrors([verdict.record]).length === 0)
				if (!usable) return retried ? undefined : yield* step(current, pendingMaterial, depth, true)
				if (verdict.decision === "verified") return current
				return isMaterial(current, verdict.record)
					? yield* step(verdict.record, true, depth + 1, false)
					: verdict.record
			})
		return yield* step(record, false, 0, false)
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
					const final = yield* verifyRecord(engine, record, index)
					if (final === undefined) {
						// No independent final review: the record leaves findings.json and the run is incomplete.
						yield* engine.mutate((c) => {
							const findings = new Map(c.findings)
							findings.delete(record.fingerprint)
							return [undefined, { ...c, findings }]
						})
						yield* engine.fail("record_verification_incomplete")
						return
					}
					yield* engine.mutate((c) => [
						undefined,
						{
							...c,
							findings: new Map(c.findings).set(final.fingerprint, final),
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
