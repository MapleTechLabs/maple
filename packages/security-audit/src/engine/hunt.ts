/**
 * Phase 2: coverage-led hunting waves and coverage critics. Critics and validation are reserved
 * before any hunter launches; a `deep` run repeats waves until a post-wave critic and a separate
 * final-clean critic both accept no work.
 */
import { Effect, Ref } from "effect"
import { criticPrompt, hunterPrompt } from "../prompts"
import { type Candidate, candidateErrors, CriticResult, HunterResult } from "../results"
import { ledgerErrors } from "../validators"
import {
	admitUnits,
	applyUnitResult,
	assign,
	defer,
	huntable,
	type LedgerUnit,
	reopen,
	revert,
	seedUnit,
	unitRefusal,
} from "./ledger"
import type { AuditStoreError } from "./ports"
import type { EngineState, Engine } from "./state"

const BUDGET_DEFER = "budget_cannot_reserve_critics_and_validation"
/** A unit whose hunters returned unusable results this many times is deferred, not retried forever. */
const MAX_UNIT_FAILURES = 2
const PEER_ID_LIMIT = 300

const candidateRank = (entry: { readonly candidate: Candidate; readonly agentId: string }) =>
	[
		entry.candidate.proposed_verdict === "confirmed" ? 0 : 1,
		-entry.candidate.trace.length,
		entry.agentId,
	] as const

/** The strongest proposal for a fingerprint, chosen deterministically so a replay agrees. */
export const strongest = <E extends { readonly candidate: Candidate; readonly agentId: string }>(
	entries: ReadonlyArray<E>,
) =>
	[...entries].sort((a, b) => {
		const [x, y] = [candidateRank(a), candidateRank(b)]
		return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0)
	})[0]

/** Verifier calls the candidates already found will need, or 30% of the balance when that is larger. */
const validationReserve = (s: EngineState, perCandidate: number, balance: number): number =>
	Math.max((s.candidates.size + s.carried.length) * perCandidate, Math.ceil(balance * 0.3))

const groupUnits = (
	units: ReadonlyArray<LedgerUnit>,
	size: number,
): ReadonlyArray<ReadonlyArray<LedgerUnit>> => {
	const bySubsystem = units.reduce((acc, unit) => {
		const key = `${unit.subsystem}\u0000${unit.boundary}`
		return new Map(acc).set(key, [...(acc.get(key) ?? []), unit])
	}, new Map<string, ReadonlyArray<LedgerUnit>>())
	return [...bySubsystem.values()].flatMap((group) =>
		Array.from({ length: Math.ceil(group.length / size) }, (_, i) =>
			group.slice(i * size, (i + 1) * size),
		),
	)
}

const filesOf = (claim: {
	readonly trace: ReadonlyArray<{ readonly file: string }>
	readonly evidence: ReadonlyArray<{ readonly file: string }>
}) => new Set([...claim.trace.map((t) => t.file), ...claim.evidence.map((e) => e.file)])

/**
 * An unchanged prior rejection suppresses only its own claim: the same fingerprint over the same
 * files. A trace that reaches new files is new evidence and goes to validation.
 */
const isSuppressed = (s: EngineState, candidate: Candidate): boolean => {
	const prior = s.suppressed.get(candidate.fingerprint)
	if (prior === undefined) return false
	const priorFiles = filesOf(prior)
	return [...filesOf(candidate)].every((file) => priorFiles.has(file))
}

/** Applies one hunter result to the units it owned; anything it got wrong goes back to `planned`. */
const applyHunterResult = (
	s: EngineState,
	owned: ReadonlyArray<string>,
	agentId: string,
	result: HunterResult | undefined,
): EngineState => {
	const ids = new Set(owned)
	if (result === undefined) return { ...s, ledger: revert(s.ledger, ids, MAX_UNIT_FAILURES) }
	const reported = result.units.map((unit) => unit.coverage_id)
	if (
		reported.length !== ids.size ||
		!reported.every((id) => ids.has(id)) ||
		new Set(reported).size !== reported.length
	) {
		return { ...s, ledger: revert(s.ledger, ids, MAX_UNIT_FAILURES) }
	}
	const listed = new Set(result.units.flatMap((unit) => unit.candidate_fingerprints))
	const valid = result.candidates.filter(
		(candidate) => listed.has(candidate.fingerprint) && candidateErrors(candidate).length === 0,
	)
	const known = new Set([...valid.map((c) => c.fingerprint), ...s.suppressed.keys()])
	const good = result.units.filter(
		(unit) =>
			unit.checks.length > 0 &&
			// Without a parent-promoted artifact a `local` check is not evidence; this run has none.
			unit.checks.every(
				(check) => check.agent_id === agentId && check.method === "source" && check.artifact === null,
			) &&
			unit.candidate_fingerprints.every((fp) => known.has(fp)),
	)
	const applied = good.reduce(
		(acc, unit) => {
			const next = applyUnitResult(acc.ledger, unit, agentId)
			return ledgerErrors(next).length === 0 ? { ledger: next, ok: [...acc.ok, unit.coverage_id] } : acc
		},
		{ ledger: s.ledger, ok: [] as ReadonlyArray<string> },
	)
	const ok = new Set(applied.ok)
	const failed = new Set(owned.filter((id) => !ok.has(id)))
	const ledger = revert(applied.ledger, failed, MAX_UNIT_FAILURES).map((unit) =>
		ok.has(unit.coverage_id) && result.hardening.length > 0
			? { ...unit, hardening: [...(unit.hardening ?? []), ...result.hardening] }
			: unit,
	)
	// Only units that were applied link a candidate; a reverted unit's claims wait for its re-hunt.
	const linked = new Set(
		result.units
			.filter((unit) => ok.has(unit.coverage_id))
			.flatMap((unit) => unit.candidate_fingerprints),
	)
	const candidates = valid
		.filter((c) => linked.has(c.fingerprint) && !isSuppressed(s, c))
		.reduce(
			(acc, candidate) =>
				new Map(acc).set(candidate.fingerprint, [
					...(acc.get(candidate.fingerprint) ?? []),
					{ candidate, agentId },
				]),
			s.candidates,
		)
	return { ...s, ledger, candidates, uncovered: [...s.uncovered, ...result.uncovered] }
}

const runHunter = (
	engine: Engine,
	units: ReadonlyArray<LedgerUnit>,
	agentId: string,
	peers: ReadonlyArray<string>,
) =>
	Effect.gen(function* () {
		const s = yield* Ref.get(engine.state)
		const carriedExclusions = s.carried.flatMap(({ record }) =>
			record.verdict === "confirmed"
				? [{ fingerprint: record.fingerprint, title: record.title, root_cause: record.root_cause }]
				: [],
		)
		const prompt = hunterPrompt(
			{
				architectureMd: s.architectureMd,
				units,
				carriedExclusions,
				peerCoverageIds: peers.slice(0, PEER_ID_LIMIT),
				scratchPath: `agents/${agentId}/scratch/`,
				artifactsPath: `agents/${agentId}/artifacts/`,
				promotionAllowlist:
					engine.input.execution._tag === "Available"
						? "declared per check"
						: "none: execution is unavailable in this run",
			},
			engine.context(agentId),
		)
		const result = yield* engine.invoke("hunter", agentId, prompt, HunterResult)
		yield* engine.mutate((current) => [
			undefined,
			applyHunterResult(
				current,
				units.map((unit) => unit.coverage_id),
				agentId,
				result,
			),
		])
	})

/** A compact ledger for the critic: every unit and block map, without check prose. */
const criticLedger = (ledger: ReadonlyArray<LedgerUnit>) =>
	ledger.map(({ local_checks, attempts, hardening: _h, ...unit }) => ({
		...unit,
		checks: local_checks.map((check) => check.invariant),
		attempts: attempts.length,
	}))

/**
 * Runs one critic and applies what it accepts. Returns the amount of accepted work, or undefined.
 * With `deferAccepted` (quick profile, or a budget that cannot fund another wave) accepted work is
 * recorded as deferred with `deferReason` instead of queued.
 */
const runCritic = (
	engine: Engine,
	kind: "post-wave" | "final-clean" | "gap",
	wave: number,
	deferReason: string | undefined,
) =>
	Effect.gen(function* () {
		const s = yield* Ref.get(engine.state)
		// A gap critic is the retained final-clean critic recording what the run cannot fund: its own id.
		const agentId = `critic-w${wave}-${kind === "post-wave" ? "post" : kind === "gap" ? "gap" : "final"}`
		const prompt = criticPrompt(
			{
				kind: kind === "post-wave" ? "post-wave" : "final-clean",
				architectureMd: s.architectureMd,
				ledger: criticLedger(s.ledger),
				candidateStates: [...s.candidates.keys()].map((fingerprint) => ({
					fingerprint,
					state: "candidate",
				})),
				priorGapSummary:
					engine.input.prior === null
						? "No prior ledger exists."
						: `Prior run ${engine.input.prior.runId}.`,
				hunterUncovered: s.uncovered,
			},
			engine.context(agentId),
		)
		const result = yield* engine.invoke("critic", agentId, prompt, CriticResult)
		if (result === undefined) return undefined
		const refusals = result.missing_units.flatMap((unit) => {
			const reason = unitRefusal(unit)
			return reason === undefined ? [] : [`${unit.surface} / ${unit.attack_class}: ${reason}`]
		})
		const outcome = yield* engine.mutate((current) => {
			const priorStatus = engine.input.prior === null ? "none" : "new"
			const proposals = result.missing_units.filter((unit) => unitRefusal(unit) === undefined)
			const seeded = proposals.map((unit) =>
				seedUnit(unit, { scope: engine.input.scopePaths, priorStatus }),
			)
			const admitted = admitUnits(current.ledger, seeded)
			const newIds = new Set(
				admitted.ledger
					.filter((u) => !current.ledger.some((c) => c.coverage_id === u.coverage_id))
					.map((u) => u.coverage_id),
			)
			const reassign = new Set(
				result.reassign_ids.filter((id) =>
					current.ledger.some(
						(u) =>
							u.coverage_id === id &&
							(u.status === "blocked" || u.status === "covered" || u.status === "candidate"),
					),
				),
			)
			const reopened = reopen(
				admitted.ledger,
				reassign,
				`coverage critic ${agentId} reassigned this unit`,
			)
			const resolved = new Set(result.resolved_prior_leads)
			const marked = reopened.map((unit) => {
				const leads = unit.result_fingerprints.filter((fp) => resolved.has(fp))
				return leads.length === 0 ? unit : { ...unit, resolved_prior_leads: leads }
			})
			const planned = new Set(
				[...newIds, ...reassign].filter(
					(id) => marked.find((u) => u.coverage_id === id)?.status === "planned",
				),
			)
			const ledger = deferReason === undefined ? marked : defer(marked, planned, deferReason)
			const refused = [...refusals, ...admitted.refused.map((r) => `${r.coverage_id}: ${r.reason}`)]
			return [
				{ accepted: planned.size, refused },
				{ ...current, ledger, uncovered: [] },
			]
		})
		yield* engine.persist
		// A proposal the ledger cannot take is disclosed coverage, never silently dropped.
		if (outcome.refused.length > 0) {
			yield* engine.gap(`${agentId} proposed ${outcome.refused.length} units the ledger refused`)
			yield* Effect.forEach(outcome.refused, (message) =>
				engine.event({ _tag: "Note", message: `critic unit refused: ${message}` }),
			)
		}
		return outcome.accepted
	})

/** Phase 2 to completion: waves, post-wave critics, and the final-clean critic. */
export const runHunting = (engine: Engine) =>
	Effect.gen(function* () {
		const { input } = engine
		const quick = input.profile === "quick"
		const perCandidate = quick ? 1 : 2
		const maxWaves = quick ? 1 : (input.maxWaves ?? 6)
		const size = input.unitsPerHunter ?? (input.profile === "deep" ? 1 : 3)
		const finalCriticReserve = quick ? 0 : 1

		const setClean = (clean: boolean) => Ref.update(engine.state, (s) => ({ ...s, criticClean: clean }))

		const deferQueued = (reason: string) =>
			Effect.gen(function* () {
				const s = yield* Ref.get(engine.state)
				const ids = new Set(huntable(s.ledger).map((unit) => unit.coverage_id))
				if (ids.size === 0) return
				yield* engine.mutate((c) => [undefined, { ...c, ledger: defer(c.ledger, ids, reason) }])
				yield* engine.gap(reason)
			})

		/**
		 * Defers what the run cannot fund and, when the final-clean critic is still unspent and its
		 * reserve is not the validation reserve, spends it to record the gap.
		 */
		const recordGap = (wave: number, reason: string, finalSpent: boolean) =>
			Effect.gen(function* () {
				yield* deferQueued(reason)
				if (quick || finalSpent) return
				const s = yield* Ref.get(engine.state)
				const left = yield* engine.remaining
				if (input.budget === null || left - validationReserve(s, perCandidate, left) >= 1)
					yield* runCritic(engine, "gap", wave, reason)
			})

		const launchWave = (wave: number, planned: ReadonlyArray<LedgerUnit>) =>
			Effect.gen(function* () {
				const s = yield* Ref.get(engine.state)
				const left = yield* engine.remaining
				const critics = 1 + finalCriticReserve
				const groups = groupUnits(planned, size)
				// Unbudgeted runs fund every group; reserves only bind a finite budget.
				const allowance =
					input.budget === null
						? groups.length
						: Math.floor(left - critics - validationReserve(s, perCandidate, left - critics))
				if (allowance <= 0) return false
				const launch = groups.slice(0, allowance)
				const unfunded = new Set(
					groups
						.slice(launch.length)
						.flat()
						.map((unit) => unit.coverage_id),
				)
				if (unfunded.size > 0) {
					yield* engine.mutate((c) => [
						undefined,
						{ ...c, ledger: defer(c.ledger, unfunded, BUDGET_DEFER) },
					])
					yield* engine.gap(BUDGET_DEFER)
				}
				const owners = launch.map((group, i) => ({ group, agentId: `hunter-w${wave}-${i + 1}` }))
				yield* engine.mutate((c) => [
					undefined,
					{
						...c,
						ledger: owners.reduce(
							(ledger, { group, agentId }) =>
								assign(ledger, new Set(group.map((u) => u.coverage_id)), agentId),
							c.ledger,
						),
					},
				])
				yield* engine.event({
					_tag: "Phase",
					phase: `wave-${wave}`,
					detail: `${owners.length} hunters over ${launch.flat().length} units`,
				})
				const allIds = launch.flat().map((unit) => unit.coverage_id)
				yield* Effect.forEach(
					owners,
					({ group, agentId }) =>
						runHunter(
							engine,
							group,
							agentId,
							allIds.filter((id) => !group.some((unit) => unit.coverage_id === id)),
						),
					{ concurrency: input.concurrency ?? 4, discard: true },
				)
				yield* engine.persist
				return true
			})

		const loop = (wave: number): Effect.Effect<void, AuditStoreError> =>
			Effect.gen(function* () {
				const planned = huntable((yield* Ref.get(engine.state)).ledger)
				if (planned.length > 0 && !(yield* launchWave(wave, planned))) {
					return yield* recordGap(wave, BUDGET_DEFER, false)
				}
				// The post-wave critic was reserved before the wave; for quick it is the one final critic.
				const accepted = yield* runCritic(
					engine,
					"post-wave",
					wave,
					quick ? "quick_profile_final_critic" : undefined,
				)
				if (accepted === undefined)
					return yield* engine.fail(`critic_unavailable: post-wave critic after wave ${wave}`)
				if (quick) {
					// A unit whose hunter failed is not left planned in a finished run.
					yield* deferQueued("quick_profile_final_critic")
					return yield* engine.gap(
						"quick profile: one hunter wave and one final critic, partial coverage",
					)
				}
				if (accepted > 0 || huntable((yield* Ref.get(engine.state)).ledger).length > 0) {
					return wave >= maxWaves
						? yield* recordGap(wave, "max_waves_reached", false)
						: yield* loop(wave + 1)
				}
				const clean = yield* runCritic(engine, "final-clean", wave, undefined)
				if (clean === undefined) return yield* engine.fail("critic_unavailable: final-clean critic")
				if (clean === 0) return yield* setClean(true)
				return wave >= maxWaves
					? yield* recordGap(wave, "max_waves_reached", true)
					: yield* loop(wave + 1)
			})

		yield* loop(1)
	})
