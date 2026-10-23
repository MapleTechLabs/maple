/**
 * Pure coverage-ledger transitions. Every function returns a new ledger sorted by `coverage_id`
 * (the skill sorts before each assignment), and the run checks each result with the upstream
 * validator before it can drive another assignment.
 */
import type { HunterUnitResult, MissingUnit, SeedUnit } from "../results"
import type { CoverageUnit } from "../schema"
import { coverageId, isSafeRelativePath, ledgerErrors } from "../validators"
import { unknownBlockRefs } from "../prompts"

type PriorStatus = CoverageUnit["prior_status"]

/** Parent bookkeeping beside the skill's semantic fields; the skill allows these. */
export interface Bookkeeping {
	readonly priority?: number
	readonly hardening?: ReadonlyArray<string>
	readonly failed_attempts?: number
	readonly carried_fingerprint?: string
	readonly decisions?: Readonly<Record<string, string>>
	readonly resolved_prior_leads?: ReadonlyArray<string>
}
export type LedgerUnit = CoverageUnit & Bookkeeping
export type Ledger = ReadonlyArray<LedgerUnit>

export const sortLedger = (ledger: ReadonlyArray<LedgerUnit>): ReadonlyArray<LedgerUnit> =>
	[...ledger].sort((a, b) => (a.coverage_id < b.coverage_id ? -1 : a.coverage_id > b.coverage_id ? 1 : 0))

const emptyLive = {
	agent_id: null,
	reviewed_paths: [],
	local_checks: [],
	result_fingerprints: [],
	unresolved: [],
} as const

const inScope = (paths: ReadonlyArray<string>, scope: ReadonlyArray<string>): boolean =>
	scope.length === 0 ||
	paths.some((path) =>
		scope.some((root) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)),
	)

/** Why a proposed unit cannot enter the ledger, or undefined when it can. */
export const unitRefusal = (seed: SeedUnit | MissingUnit): string | undefined => {
	const unknown = unknownBlockRefs(seed)
	if (unknown.length > 0) return `unknown skill block references: ${unknown.join(", ")}`
	if (seed.starting_paths.length === 0) return "no starting paths"
	const unsafe = seed.starting_paths.filter((path) => !isSafeRelativePath(path))
	if (unsafe.length > 0) return `unsafe starting paths: ${unsafe.join(", ")}`
	if ((seed.lifecycle === undefined) !== (seed.canonical_refs.lifecycle === undefined)) {
		return "lifecycle and canonical_refs.lifecycle must appear together"
	}
	return undefined
}

/** A seeded unit: `planned` in scope, otherwise `out_of_scope` with the reason. */
export const seedUnit = (
	seed: SeedUnit | MissingUnit,
	options: {
		readonly scope: ReadonlyArray<string>
		readonly priorStatus: PriorStatus
		readonly priority?: number
	},
): LedgerUnit => {
	const base: LedgerUnit = {
		coverage_id: coverageId(seed.canonical_refs),
		canonical_refs: seed.canonical_refs,
		surface: seed.surface,
		boundary: seed.boundary,
		subsystem: seed.subsystem,
		attack_class: seed.attack_class,
		starting_paths: seed.starting_paths,
		ordinary_attack_class_block: seed.ordinary_attack_class_block,
		selected_companion_blocks: seed.selected_companion_blocks,
		excluded_blocks: seed.excluded_blocks,
		prior_status: options.priorStatus,
		attempts: [],
		wave: 1,
		...emptyLive,
		status: "planned",
		priority: options.priority,
	}
	const withLifecycle = seed.lifecycle === undefined ? base : { ...base, lifecycle: seed.lifecycle }
	return inScope(seed.starting_paths, options.scope)
		? withLifecycle
		: {
				...withLifecycle,
				status: "out_of_scope",
				unresolved: [`outside this run's scope (${options.scope.join(", ")})`],
			}
}

/**
 * Adds units one at a time, keeping only those the upstream validator accepts: a duplicate id or a
 * semantic collision is refused, never merged (skill: "Fail rather than merge").
 */
export const admitUnits = (
	ledger: Ledger,
	units: ReadonlyArray<LedgerUnit>,
): {
	readonly ledger: ReadonlyArray<LedgerUnit>
	readonly refused: ReadonlyArray<{ readonly coverage_id: string; readonly reason: string }>
} =>
	units.reduce<{
		ledger: ReadonlyArray<LedgerUnit>
		refused: ReadonlyArray<{ coverage_id: string; reason: string }>
	}>(
		(acc, unit) => {
			if (acc.ledger.some((existing) => existing.coverage_id === unit.coverage_id)) {
				return {
					...acc,
					refused: [
						...acc.refused,
						{ coverage_id: unit.coverage_id, reason: "duplicate coverage_id" },
					],
				}
			}
			const next = sortLedger([...acc.ledger, unit])
			const errors = ledgerErrors(next)
			return errors.length === 0
				? { ...acc, ledger: next }
				: {
						...acc,
						refused: [
							...acc.refused,
							{ coverage_id: unit.coverage_id, reason: errors.slice(0, 2).join("; ") },
						],
					}
		},
		{ ledger: sortLedger(ledger), refused: [] },
	)

const update = (
	ledger: Ledger,
	ids: ReadonlySet<string>,
	f: (unit: LedgerUnit) => LedgerUnit,
): ReadonlyArray<LedgerUnit> => ledger.map((unit) => (ids.has(unit.coverage_id) ? f(unit) : unit))

/** Before launch: the assigned units become `in_progress` under the hunter's id. */
export const assign = (ledger: Ledger, ids: ReadonlySet<string>, agentId: string) =>
	update(ledger, ids, (unit) => ({ ...unit, ...emptyLive, status: "in_progress", agent_id: agentId }))

/** A failed or unusable result leaves its units `planned` for reassignment; repeat failures defer. */
export const revert = (ledger: Ledger, ids: ReadonlySet<string>, maxFailures: number) =>
	update(ledger, ids, (unit) => {
		const failed = (unit.failed_attempts ?? 0) + 1
		return failed >= maxFailures
			? {
					...unit,
					...emptyLive,
					status: "deferred",
					failed_attempts: failed,
					unresolved: ["hunter_result_unusable"],
				}
			: { ...unit, ...emptyLive, status: "planned", failed_attempts: failed }
	})

/** Units the budget, profile, or wave cap cannot reach: unassigned, empty evidence, the reason. */
export const defer = (ledger: Ledger, ids: ReadonlySet<string>, reason: string) =>
	update(ledger, ids, (unit) => ({ ...unit, ...emptyLive, status: "deferred", unresolved: [reason] }))

/** A hunter's per-unit result, mapped into its owned unit. */
export const applyUnitResult = (ledger: Ledger, result: HunterUnitResult, agentId: string) =>
	update(ledger, new Set([result.coverage_id]), (unit) => ({
		...unit,
		status: result.disposition,
		agent_id: agentId,
		reviewed_paths: [...new Set(result.checks.flatMap((check) => check.reviewed_paths))].sort(),
		local_checks: result.checks,
		result_fingerprints: result.disposition === "candidate" ? result.candidate_fingerprints : [],
		unresolved: result.disposition === "covered" ? [] : result.unresolved,
	}))

/**
 * A critic's legitimate reassignment: the live terminal record is archived with the reason, the
 * wave increments, and the unit starts over with empty live evidence and no owner.
 */
export const reopen = (ledger: Ledger, ids: ReadonlySet<string>, reason: string) =>
	update(ledger, ids, (unit) => {
		if (unit.status !== "blocked" && unit.status !== "covered" && unit.status !== "candidate") return unit
		const attempt = {
			wave: unit.wave,
			status: unit.status,
			agent_id: unit.agent_id,
			reviewed_paths: unit.reviewed_paths,
			local_checks: unit.local_checks,
			result_fingerprints: unit.result_fingerprints,
			unresolved: unit.unresolved,
			reassignment_reason: reason,
		}
		return {
			...unit,
			...emptyLive,
			attempts: [...unit.attempts, attempt],
			wave: unit.wave + 1,
			status: "planned",
		}
	})

/** Units hunters may take this wave, in the skill's priority order. */
export const huntable = (ledger: Ledger): ReadonlyArray<LedgerUnit> =>
	ledger
		.filter((unit) => unit.status === "planned" && unit.carried_fingerprint === undefined)
		.sort((a, b) => rank(a) - rank(b) || (a.coverage_id < b.coverage_id ? -1 : 1))

const PRIOR_GAP: ReadonlySet<PriorStatus> = new Set([
	"prior_confirmed_changed_source",
	"prior_needs_validation",
	"prior_deferred",
	"prior_blocked",
	"prior_out_of_scope",
	"prior_covered_changed_source",
	"prior_rejected_claim_changed",
])

/** Lower is sooner: reconnaissance priority first, then prior gaps before same-source re-passes. */
const rank = (unit: LedgerUnit): number =>
	(unit.priority ?? 1_000) * 4 +
	(PRIOR_GAP.has(unit.prior_status) ? 0 : unit.prior_status === "prior_covered_same_source" ? 2 : 1)
