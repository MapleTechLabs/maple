/**
 * Pure coverage-ledger transitions. Every function returns a new ledger sorted by `coverage_id`
 * (the skill sorts before each assignment), and the run checks each result with the upstream
 * validator before it can drive another assignment.
 */
import type { HunterUnitResult, MissingUnit, SeedUnit } from "../results"
import type { CoverageUnit } from "../schema"
import { coverageId, isSafeRelativePath, ledgerErrors, safeCoverageId } from "../validators"
import {
	canonicalBlockRef,
	isCompanionRequiredSection,
	ORDINARY_BLOCK_REFS,
	type SkillBlockRef,
} from "../skill"
import { Array as Arr, String as Str } from "effect"

type PriorStatus = CoverageUnit["prior_status"]

/** The ledger unit, bookkeeping included (see `CoverageUnit`). */
export type LedgerUnit = CoverageUnit
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

export const inScope = (paths: ReadonlyArray<string>, scope: ReadonlyArray<string>): boolean =>
	scope.length === 0 ||
	Arr.some(paths, (path) =>
		Arr.some(
			scope,
			(root) => path === root || Str.startsWith(Str.endsWith("/")(root) ? root : `${root}/`)(path),
		),
	)

/** A unit outside the run's scope is recorded `out_of_scope`, never assigned and never covered. */
export const scoped = (unit: LedgerUnit, scope: ReadonlyArray<string>): LedgerUnit => {
	if (inScope(unit.starting_paths, scope)) return unit
	const { carried_fingerprint: _carried, ...rest } = unit
	return {
		...rest,
		...emptyLive,
		status: "out_of_scope",
		unresolved: [`outside this run's scope (${Arr.join(scope, ", ")})`],
	}
}

type Proposal = SeedUnit | MissingUnit

/** A proposed unit whose block references are the skill's own: only `reviewProposal` builds one. */
export interface CanonicalProposal extends Pick<
	Proposal,
	"canonical_refs" | "surface" | "boundary" | "subsystem" | "attack_class" | "starting_paths" | "lifecycle"
> {
	readonly ordinary_attack_class_block: SkillBlockRef | null
	readonly selected_companion_blocks: ReadonlyArray<SkillBlockRef>
	readonly excluded_blocks: ReadonlyArray<CanonicalExclusion>
}

interface CanonicalExclusion {
	readonly block: SkillBlockRef
	readonly reason: string
}

/**
 * `Admissible`: the unit with canonical block references, and the unknown companion or excluded
 * references dropped from it. `Refused`: why it cannot enter the ledger; `unknownRefs` is set when
 * the unit's attack-class block is unknown, which a critic repair turn can fix.
 */
export type ProposalReview =
	| {
			readonly _tag: "Admissible"
			readonly unit: CanonicalProposal
			readonly dropped: ReadonlyArray<string>
	  }
	| { readonly _tag: "Refused"; readonly reason: string; readonly unknownRefs: ReadonlyArray<string> }

const refused = (reason: string, unknownRefs: ReadonlyArray<string> = []): ProposalReview => ({
	_tag: "Refused",
	reason,
	unknownRefs,
})

/** `value` as a zero- or one-element array, for `Arr.flatMap`. */
export const present = <A>(value: A | undefined): ReadonlyArray<A> => (value === undefined ? [] : [value])

/** Up to five items and a count of the rest, so one unit's note stays readable. */
const listSome = (items: ReadonlyArray<string>): string =>
	`${Arr.join(items.slice(0, 5), ", ")}${items.length > 5 ? ` (+${items.length - 5} more)` : ""}`

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/**
 * Whether a proposed unit can enter the ledger, with its block references canonicalised. An unknown
 * ordinary block refuses the unit, as does a unit left with no attack-class block at all; an
 * unknown companion or excluded reference is only dropped.
 */
export const reviewProposal = (seed: Proposal): ProposalReview => {
	if (safeCoverageId(seed.canonical_refs) === undefined) return refused("invalid canonical reference")
	const ordinary =
		seed.ordinary_attack_class_block === null ? null : canonicalBlockRef(seed.ordinary_attack_class_block)
	if (ordinary === undefined) {
		const raw = seed.ordinary_attack_class_block ?? ""
		return refused(`unknown ordinary attack-class block: ${raw}`, [raw])
	}
	// A companion section is a known block but not an ordinary one: the repair turn can fix it too.
	if (ordinary !== null && !ORDINARY_BLOCK_REFS.includes(ordinary)) {
		return refused(`not an ordinary attack-class block: ${ordinary}`, [ordinary])
	}
	const unknownSelected = Arr.filter(
		seed.selected_companion_blocks,
		(ref) => canonicalBlockRef(ref) === undefined,
	)
	const selected = Arr.dedupe(
		Arr.flatMap(seed.selected_companion_blocks, (ref) => present(canonicalBlockRef(ref))),
	)
	if (ordinary === null && !Arr.some(selected, (ref) => !isCompanionRequiredSection(ref))) {
		const detail =
			unknownSelected.length === 0
				? "no companion block names an attack class"
				: `${plural(unknownSelected.length, "unknown companion block reference")} (${listSome(unknownSelected)})`
		return refused(`no known attack-class block: ${detail}`, unknownSelected)
	}
	if (seed.starting_paths.length === 0) return refused("no starting paths")
	const unsafe = Arr.filter(seed.starting_paths, (path) => !isSafeRelativePath(path))
	if (unsafe.length > 0) return refused(`unsafe starting paths: ${Arr.join(unsafe, ", ")}`)
	if ((seed.lifecycle === undefined) !== (seed.canonical_refs.lifecycle === undefined)) {
		return refused("lifecycle and canonical_refs.lifecycle must appear together")
	}
	const unknownExcluded = Arr.filter(
		Arr.map(seed.excluded_blocks, (excluded) => excluded.block),
		(ref) => canonicalBlockRef(ref) === undefined,
	)
	// Two spellings of one block, or a block both selected and excluded, keep the first selection.
	const excluded = Arr.reduce<Proposal["excluded_blocks"][number], ReadonlyArray<CanonicalExclusion>>(
		seed.excluded_blocks,
		[],
		(acc, entry) => {
			const block = canonicalBlockRef(entry.block)
			return block === undefined ||
				selected.includes(block) ||
				Arr.some(acc, (kept) => kept.block === block)
				? acc
				: [...acc, { block, reason: entry.reason }]
		},
	)
	const base: CanonicalProposal = {
		canonical_refs: seed.canonical_refs,
		surface: seed.surface,
		boundary: seed.boundary,
		subsystem: seed.subsystem,
		attack_class: seed.attack_class,
		starting_paths: seed.starting_paths,
		ordinary_attack_class_block: ordinary,
		selected_companion_blocks: selected,
		excluded_blocks: excluded,
	}
	// Optional keys are left out, never set to undefined: the stored schema rejects an undefined value.
	const unit = seed.lifecycle === undefined ? base : { ...base, lifecycle: seed.lifecycle }
	return { _tag: "Admissible", unit, dropped: [...unknownSelected, ...unknownExcluded] }
}

/** One note for a reviewed proposal: why it was refused, or what was dropped from it; none when clean. */
export const proposalNote = (seed: Proposal, review: ProposalReview): string | undefined => {
	const label = `${seed.surface} / ${seed.attack_class}`
	if (review._tag === "Refused") return `refused: ${label}: ${review.reason}`
	if (review.dropped.length === 0) return undefined
	return `kept: ${label}: dropped ${plural(review.dropped.length, "unknown block reference")} (${listSome(review.dropped)})`
}

/** A seeded unit: `planned` in scope, otherwise `out_of_scope` with the reason. */
export const seedUnit = (
	seed: CanonicalProposal,
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
	}
	// Optional keys are left out, never set to undefined: the stored schema rejects an undefined value.
	const prioritized = options.priority === undefined ? base : { ...base, priority: options.priority }
	const withLifecycle =
		seed.lifecycle === undefined ? prioritized : { ...prioritized, lifecycle: seed.lifecycle }
	return inScope(seed.starting_paths, options.scope)
		? withLifecycle
		: {
				...withLifecycle,
				status: "out_of_scope",
				unresolved: [`outside this run's scope (${Arr.join(options.scope, ", ")})`],
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
	Arr.reduce<
		LedgerUnit,
		{
			ledger: ReadonlyArray<LedgerUnit>
			refused: ReadonlyArray<{ coverage_id: string; reason: string }>
		}
	>(units, { ledger: sortLedger(ledger), refused: [] }, (acc, unit) => {
		if (Arr.some(acc.ledger, (existing) => existing.coverage_id === unit.coverage_id)) {
			return {
				...acc,
				refused: [...acc.refused, { coverage_id: unit.coverage_id, reason: "duplicate coverage_id" }],
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
						{ coverage_id: unit.coverage_id, reason: Arr.join(errors.slice(0, 2), "; ") },
					],
				}
	})

const update = (
	ledger: Ledger,
	ids: ReadonlySet<string>,
	f: (unit: LedgerUnit) => LedgerUnit,
): ReadonlyArray<LedgerUnit> => Arr.map(ledger, (unit) => (ids.has(unit.coverage_id) ? f(unit) : unit))

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
		reviewed_paths: [...new Set(Arr.flatMap(result.checks, (check) => check.reviewed_paths))].sort(),
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
	Arr.filter(ledger, (unit) => unit.status === "planned" && unit.carried_fingerprint === undefined).sort(
		(a, b) => (rank(a) !== rank(b) ? rank(a) - rank(b) : a.coverage_id < b.coverage_id ? -1 : 1),
	)

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
