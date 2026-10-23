/**
 * Phase 1: the strict budget gate, reconnaissance, synthesis into `architecture.md` and the seeded
 * ledger, and the prior-run rules that turn earlier ledgers and findings into current work.
 */
import { Effect, Ref } from "effect"
import { focusedReconPrompt, RECON_AGENTS, reconPrompt, synthesisPrompt } from "../prompts"
import { SynthesisResult } from "../results"
import type { CoverageUnit, Finding } from "../schema"
import { admitUnits, type LedgerUnit, scoped, seedUnit, unitRefusal } from "./ledger"
import type { CarriedRecord, Engine, PriorRun } from "./state"

/** The calls the skill reserves before any reconnaissance agent may launch. */
export const minimumInvocations = (profile: "quick" | "standard" | "deep"): number =>
	// 4 baseline reconnaissance + 1 synthesis + the profile's mandatory critics + 1 verifier.
	4 + 1 + (profile === "quick" ? 1 : 2) + 1

const recordFiles = (record: Finding): ReadonlyArray<string> => [
	...new Set([...record.trace.map((step) => step.file), ...record.evidence.map((e) => e.file)]),
]

interface PriorPlan {
	readonly units: ReadonlyArray<LedgerUnit>
	readonly carried: ReadonlyArray<CarriedRecord>
	readonly suppressed: ReadonlyMap<string, Finding>
	readonly summary: string
}

/**
 * The skill's prior-run input rules. Unchanged confirmed and needs_validation records are carried
 * to a current planned unit for re-verification; changed ones make the unit revalidation work;
 * deferred, blocked and out-of-scope units become current work; an unchanged rejection suppresses
 * only its own claim.
 */
export const planFromPrior = (
	prior: PriorRun,
	changed: (paths: ReadonlyArray<string>) => boolean,
): PriorPlan => {
	const byFingerprint = new Map(prior.findings.map((record) => [record.fingerprint, record]))
	const carried: Array<CarriedRecord> = []
	const units = prior.ledger.map((unit): LedgerUnit => {
		if (unit.status === "not_applicable") return unit
		const linked = unit.result_fingerprints.flatMap((fp) => {
			const record = byFingerprint.get(fp)
			return record === undefined ? [] : [record]
		})
		const unitChanged = changed([...unit.starting_paths, ...unit.reviewed_paths])
		const confirmed = linked.find((record) => record.verdict === "confirmed")
		const pending = linked.find((record) => record.verdict === "needs_validation")
		const carry = (record: Finding, status: CoverageUnit["prior_status"]): LedgerUnit => {
			carried.push({ record, coverageId: unit.coverage_id })
			return replan(unit, status, record.fingerprint)
		}
		if (confirmed !== undefined) {
			return changed(recordFiles(confirmed))
				? replan(unit, "prior_confirmed_changed_source")
				: carry(confirmed, "prior_confirmed_same_source")
		}
		if (pending !== undefined) {
			return changed(recordFiles(pending))
				? replan(unit, "prior_needs_validation")
				: carry(pending, "prior_needs_validation")
		}
		const status: CoverageUnit["prior_status"] =
			unit.status === "deferred" ||
			unit.status === "planned" ||
			unit.status === "in_progress" ||
			// A lead that never got an independent verdict is open work, not coverage.
			(unit.status === "candidate" && unit.result_fingerprints.some((fp) => !byFingerprint.has(fp)))
				? "prior_deferred"
				: unit.status === "blocked"
					? "prior_blocked"
					: unit.status === "out_of_scope"
						? "prior_out_of_scope"
						: unit.status === "candidate" &&
							  linked.some((record) => record.verdict === "rejected") &&
							  unitChanged
							? "prior_rejected_claim_changed"
							: unitChanged
								? "prior_covered_changed_source"
								: "prior_covered_same_source"
		return replan(unit, status)
	})
	const suppressed = new Map(
		prior.findings
			.filter((record) => record.verdict === "rejected" && !changed(recordFiles(record)))
			.map((record) => [record.fingerprint, record] as const),
	)
	const counts = units.reduce<Record<string, number>>((acc, unit) => {
		acc[unit.prior_status] = (acc[unit.prior_status] ?? 0) + 1
		return acc
	}, {})
	const summary = `Prior run ${prior.runId} at ${prior.sourceRef}: ${prior.ledger.length} units (${Object.entries(
		counts,
	)
		.map(([status, n]) => `${n} ${status}`)
		.join(
			", ",
		)}), ${carried.length} records carried for re-verification, ${suppressed.size} unchanged rejected claims suppressed. Prior units stay visible as current work; none counts as covered in this run.`
	return { units, carried, suppressed, summary }
}

/** A prior unit as current, unassigned work with its archive kept. */
const replan = (
	unit: CoverageUnit,
	priorStatus: CoverageUnit["prior_status"],
	carriedFingerprint?: string,
): LedgerUnit => {
	const base: LedgerUnit = {
		...unit,
		prior_status: priorStatus,
		status: "planned",
		agent_id: null,
		reviewed_paths: [],
		local_checks: [],
		result_fingerprints: [],
		unresolved: [],
	}
	return carriedFingerprint === undefined ? base : { ...base, carried_fingerprint: carriedFingerprint }
}

/** Runs Phase 1. Returns false when the run cannot go on (budget gate or synthesis failure). */
export const runReconnaissance = (engine: Engine) =>
	Effect.gen(function* () {
		const { input } = engine
		if (input.budget !== null && input.budget < minimumInvocations(input.profile)) {
			yield* engine.fail("budget_cannot_fund_reconnaissance_and_reserves")
			return false
		}
		const prior =
			input.prior === null
				? undefined
				: planFromPrior(input.prior, (paths) => input.changedSincePrior(paths))
		yield* engine.event({
			_tag: "Phase",
			phase: "reconnaissance",
			detail: prior?.summary ?? "No prior ledger exists.",
		})

		const baseline = yield* Effect.forEach(
			RECON_AGENTS,
			(agent) =>
				engine
					.invokeText(
						"recon",
						`recon-${agent}`,
						reconPrompt(agent, input.target, engine.context(`recon-${agent}`)),
					)
					.pipe(Effect.map((facts) => ({ agent, facts }))),
			{ concurrency: 4 },
		)
		const focused = yield* Effect.forEach(
			input.focusedRecon ?? [],
			(area, index) =>
				Effect.gen(function* () {
					// Each focused agent passes the gate again: critics and a verifier stay reserved.
					const left = yield* engine.remaining
					if (left - 1 < minimumInvocations(input.profile) - 4) {
						yield* engine.gap(
							`focused reconnaissance for ${area.subsystem} not funded by the budget`,
						)
						return { agent: `focused ${area.subsystem}`, facts: undefined }
					}
					const id = `recon-focus-${index + 1}`
					const facts = yield* engine.invokeText(
						"recon",
						id,
						focusedReconPrompt(area.subsystem, area.paths, engine.context(id)),
					)
					return { agent: `focused ${area.subsystem}`, facts }
				}),
			{ concurrency: input.concurrency ?? 4 },
		)
		const reconResults = [...baseline, ...focused].flatMap(({ agent, facts }) =>
			facts === undefined ? [] : [{ agent, facts }],
		)
		const missing = [...baseline, ...focused].filter((r) => r.facts === undefined).map((r) => r.agent)
		if (missing.length > 0)
			yield* engine.gap(`reconnaissance returned nothing for: ${missing.join(", ")}`)

		const synthesisInput = {
			target: input.target,
			profile: input.profile,
			scopePaths: input.scopePaths,
			reconResults,
			priorSummary: prior?.summary ?? "No prior ledger exists for this repository.",
		}
		const synthesize = (id: string) =>
			engine.invoke(
				"synthesis",
				id,
				synthesisPrompt(synthesisInput, engine.context(id)),
				SynthesisResult,
			)
		const first = yield* synthesize("synthesis-1")
		const synthesis = first ?? (yield* synthesize("synthesis-2"))
		if (synthesis === undefined) {
			yield* engine.fail("reconnaissance_synthesis_failed")
			return false
		}

		const priorStatus = input.prior === null ? "none" : "new"
		const refusals = synthesis.units.flatMap((seed) => {
			const reason = unitRefusal(seed)
			return reason === undefined ? [] : [`${seed.surface} / ${seed.attack_class}: ${reason}`]
		})
		const seeds = synthesis.units
			.filter((seed) => unitRefusal(seed) === undefined)
			.map((seed) =>
				seedUnit(seed, {
					scope: input.scopePaths,
					priorStatus,
					priority: seed.priority,
				}),
			)
		// Prior units first: their identity is the stable one across runs. They pass the same scope check.
		const priorUnits = (prior?.units ?? []).map((unit) => scoped(unit, input.scopePaths))
		const inScopeIds = new Set(
			priorUnits.filter((u) => u.status !== "out_of_scope").map((u) => u.coverage_id),
		)
		const carried = (prior?.carried ?? []).filter((c) => inScopeIds.has(c.coverageId))
		const admitted = admitUnits(admitUnits([], priorUnits).ledger, seeds)
		const refused = [...refusals, ...admitted.refused.map((r) => `${r.coverage_id}: ${r.reason}`)]
		yield* Effect.forEach(refused, (message) =>
			engine.event({ _tag: "Note", message: `seed unit refused: ${message}` }),
		)
		if (refused.length > 0)
			yield* engine.gap(`synthesis proposed ${refused.length} units the ledger refused`)
		yield* engine.mutate((s) => [
			undefined,
			{
				...s,
				ledger: admitted.ledger,
				architectureMd: synthesis.architecture_md,
				carried,
				suppressed: prior?.suppressed ?? new Map(),
			},
		])
		yield* engine.persist
		yield* engine.store.saveArchitecture(input.runId, synthesis.architecture_md)
		const seeded = yield* Ref.get(engine.state)
		yield* engine.event({
			_tag: "Phase",
			phase: "ledger-seeded",
			detail: `${seeded.ledger.length} units, ${seeded.ledger.filter((u) => u.status === "planned").length} planned`,
		})
		return true
	})
