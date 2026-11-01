import type {
	SecurityAuditEvent,
	SecurityAuditFinding,
	SecurityAuditRunDetail,
	SecurityAuditTarget,
	SecurityAuditUnit,
} from "@maple/domain/http"
import type { Tone } from "@maple/ui/lib/tone"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import { isLive } from "../kit/format"
import { type EventFilter, eventLineOf, matchesEventFilter } from "../kit/outcome"
import type { Model, UnitFilter } from "./model"

// Pure readings of the run page: the phase strip, the ledger, the gaps and the run's results.

export const runOf = (model: Model): SecurityAuditRunDetail | null =>
	Option.getOrNull(AsyncData.getData(model.run.data))

export const targetOf = (model: Model, run: SecurityAuditRunDetail): SecurityAuditTarget | null =>
	Option.getOrNull(AsyncData.getData(model.targets.data))?.targets.find(
		(target) => target.id === run.targetId,
	) ?? null

export const eventsOf = (model: Model): ReadonlyArray<SecurityAuditEvent> => model.eventLog

/** The log narrowed by the events panel's chip. */
export const filteredEvents = (
	events: ReadonlyArray<SecurityAuditEvent>,
	filter: EventFilter,
): ReadonlyArray<SecurityAuditEvent> =>
	filter === "all" ? events : events.filter((event) => matchesEventFilter(eventLineOf(event), filter))

/** Newest first; the id breaks a tie in the same millisecond, as the API pages them. */
const byNewest = (a: SecurityAuditEvent, b: SecurityAuditEvent): number =>
	b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/** `page` merged into `log`: each event once, newest first. */
export const mergeEvents = (
	log: ReadonlyArray<SecurityAuditEvent>,
	page: ReadonlyArray<SecurityAuditEvent>,
): ReadonlyArray<SecurityAuditEvent> => {
	const ids = new Set(log.map((event) => event.id))
	return [...log, ...page.filter((event) => !ids.has(event.id))].sort(byNewest)
}

// UNITS

export const UNIT_LABEL = {
	covered: "Covered",
	candidate: "Candidate",
	in_progress: "In progress",
	planned: "Planned",
	blocked: "Blocked",
	deferred: "Deferred",
	not_applicable: "Not applicable",
	out_of_scope: "Out of scope",
} satisfies Record<Exclude<UnitFilter, "all">, string>

export const UNIT_TONE = {
	covered: "ok",
	candidate: "warn",
	in_progress: "done",
	planned: "neutral",
	blocked: "crit",
	deferred: "neutral",
	not_applicable: "neutral",
	out_of_scope: "neutral",
} satisfies Record<Exclude<UnitFilter, "all">, Tone>

export const UNIT_FILTERS: ReadonlyArray<UnitFilter> = [
	"all",
	"covered",
	"candidate",
	"in_progress",
	"planned",
	"blocked",
	"deferred",
	"not_applicable",
	"out_of_scope",
]

/** Units the run did not get to: what the next run starts with. */
const GAP_STATUSES: ReadonlyArray<string> = ["deferred", "blocked", "planned", "in_progress"]

export const countOf = (run: SecurityAuditRunDetail, status: string): number => run.unitCounts[status] ?? 0

export const gapCount = (run: SecurityAuditRunDetail): number =>
	GAP_STATUSES.reduce((sum, status) => sum + countOf(run, status), 0)

/** Ledger rows for the chip; gaps lead, then the order the engine planned them. */
export const filteredUnits = (
	units: ReadonlyArray<SecurityAuditUnit>,
	filter: UnitFilter,
): ReadonlyArray<SecurityAuditUnit> =>
	filter === "all" ? units : units.filter((unit) => unit.status === filter)

export const gapUnits = (units: ReadonlyArray<SecurityAuditUnit>): ReadonlyArray<SecurityAuditUnit> =>
	units.filter((unit) => GAP_STATUSES.includes(unit.status))

/** Distinct subsystems the ledger planned: the areas of the repository it reached. */
export const areasOf = (units: ReadonlyArray<SecurityAuditUnit>): number =>
	new Set(units.flatMap((unit) => (unit.subsystem === null ? [] : [unit.subsystem]))).size

// PHASES

export type PhaseState = "done" | "active" | "warn" | "stopped" | "pending" | "skipped"

export type Phase = Readonly<{ name: string; state: PhaseState; detail: string }>

/** How far the engine got, from its Phase events (any page): 0 recon to 4 report, 5 finished. */
const reachedOf = (events: ReadonlyArray<SecurityAuditEvent>): Readonly<{ reached: number; wave: number }> =>
	events
		.filter((event) => event.kind === "Phase" && event.phase !== null)
		.reduce(
			(acc, event) => {
				const phase = event.phase ?? ""
				const waveMatch = /^wave-(\d+)$/u.exec(phase)
				const step =
					phase === "reconnaissance" || phase === "ledger-seeded"
						? 0
						: waveMatch !== null
							? 1
							: phase === "candidate-validation"
								? 2
								: phase === "record-verification"
									? 3
									: phase === "finished"
										? 5
										: -1
				return {
					reached: Math.max(acc.reached, step),
					wave: waveMatch === null ? acc.wave : Math.max(acc.wave, Number(waveMatch[1])),
				}
			},
			{ reached: 0, wave: 0 },
		)

const phaseDetail = (events: ReadonlyArray<SecurityAuditEvent>, phase: string): string | null =>
	events.find((event) => event.kind === "Phase" && event.phase === phase)?.detail ?? null

export const phasesOf = (
	run: SecurityAuditRunDetail,
	events: ReadonlyArray<SecurityAuditEvent>,
): ReadonlyArray<Phase> => {
	const { reached, wave } = reachedOf(events)
	const live = isLive(run)
	const gaps = gapCount(run)
	const closed = run.unitTotal - gaps
	const isQuick = run.profile === "quick"
	// A finished run with units left over did not hunt everything, whether it ran out or was cancelled.
	const huntState = (finished: boolean): PhaseState => (finished && gaps > 0 ? "warn" : "done")
	const stateAt = (index: number): PhaseState => {
		const skipped = index === 3 && isQuick
		if (reached === 5) return index === 1 ? huntState(!live) : skipped ? "skipped" : "done"
		if (index < reached) return index === 1 ? huntState(!live) : skipped ? "skipped" : "done"
		if (index === reached) return live ? "active" : "stopped"
		return skipped ? "skipped" : "pending"
	}
	return [
		{
			name: "Recon",
			state: stateAt(0),
			detail:
				phaseDetail(events, "ledger-seeded") ??
				(run.unitTotal > 0 ? `${run.unitTotal} units mapped` : "Mapping the code"),
		},
		{
			name:
				wave > 0
					? `Hunting · ${reached === 5 || reached > 1 ? `${wave} ${wave === 1 ? "wave" : "waves"}` : `wave ${wave}`}`
					: "Hunting",
			state: stateAt(1),
			detail: run.unitTotal > 0 ? `${closed} of ${run.unitTotal} units closed` : "Waits for the ledger",
		},
		{
			name: "Validation",
			state: stateAt(2),
			detail:
				phaseDetail(events, "candidate-validation") ??
				`${countOf(run, "candidate")} candidates waiting`,
		},
		{
			name: "Verification",
			state: stateAt(3),
			detail: isQuick
				? "Skipped by quick: validation already re-checked"
				: (phaseDetail(events, "record-verification") ?? "Fresh verifier per record"),
		},
		{
			name: "Report",
			state: stateAt(4),
			detail: run.reports === null ? "Built from verified records only" : "3 documents",
		},
	]
}

// RESULTS

/** What this run reported, from its own snapshot. */
export const resultsOf = (model: Model): ReadonlyArray<SecurityAuditFinding> =>
	Option.match(AsyncData.getData(model.findings.data), {
		onNone: () => [],
		onSome: (response) => response.findings,
	})

export const openFindingOf = (model: Model): SecurityAuditFinding | null =>
	resultsOf(model).find((finding) => finding.fingerprint === model.openFingerprint) ?? null

/** How the run ran stays open while it is live; a finished run leads with what it found. */
export const isDetailsOpenByDefault = (model: Model): boolean => {
	const run = runOf(model)
	return run === null || isLive(run)
}

export const isDetailsOpen = (model: Model): boolean => model.isDetailsOpen ?? isDetailsOpenByDefault(model)

export type Verdicts = Readonly<{ confirmed: number; needsValidation: number; rejected: number }>

export const verdictsOf = (findings: ReadonlyArray<SecurityAuditFinding>): Verdicts => ({
	confirmed: findings.filter((finding) => finding.verdict === "confirmed").length,
	needsValidation: findings.filter((finding) => finding.verdict === "needs_validation").length,
	rejected: findings.filter((finding) => finding.verdict === "rejected").length,
})
