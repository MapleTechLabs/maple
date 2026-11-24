import type { AlertIncidentRow } from "@maple/web-data/collections/alerts"
import type { V2Slo, V2SloSli, V2SloStatus } from "@maple/domain/http/v2"
import {
	budgetSpent,
	errorBudgetRatio,
	isSloBudgetIncident,
	SLO_BUDGET_RECOVERY,
	SLO_BURN_TIERS,
	type SloBurnTier,
	type SloSeverity,
	type SloTierState,
	tierFactor,
	tierState,
	windowLabel,
} from "@maple/domain/slo"
import type { Tone } from "@maple/ui/lib/tone"
import { Array as Arr, Option } from "effect"

export type Slo = V2Slo
export type SloStatus = V2SloStatus
export type SloTier = SloBurnTier

/** `1000` as "1 s", `250` as "250 ms": a latency threshold the way the form's ladder names it. */
export const formatThreshold = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${ms / 1000} s`)

/** "Availability", or "Latency < 500 ms". */
export const sliLabel = (sli: V2SloSli): string =>
	sli.type === "availability" ? "Availability" : `Latency < ${formatThreshold(sli.threshold_ms)}`

/** What a good event is, for the detail page's subline. */
export const sliDescription = (sli: V2SloSli): string =>
	sli.type === "availability"
		? "Entry-point spans that are not errors"
		: `Entry-point spans faster than ${formatThreshold(sli.threshold_ms)}`

/** A percentage with up to `digits` decimals and no trailing zeros: 99.9%, 99.95%, 100%. */
export const formatPercent = (percent: number, digits = 3): string =>
	`${Number(percent.toFixed(digits)).toString()}%`

export const formatTarget = (slo: Pick<Slo, "target_percent">): string => formatPercent(slo.target_percent)

export const formatWindow = (days: number): string => `${days} days`

/** The SLI as a share, or a dash before any event. */
export const formatSli = (sli: number | null): string => (sli === null ? "–" : formatPercent(sli * 100))

export const formatBudget = (budget: number): string => `${Math.round(budget * 100)}%`

/** "2.3x", the rate at which the window spends the budget. */
export const formatBurn = (rate: number): string => `${rate < 10 ? rate.toFixed(1) : Math.round(rate)}x`

/** "12.4k" events: counts are sampling-weighted, so they are rounded. */
export const formatEvents = (count: number): string =>
	count >= 1_000_000
		? `${Number((count / 1_000_000).toFixed(1))}M`
		: count >= 1000
			? `${Number((count / 1000).toFixed(1))}k`
			: String(Math.round(count))

/** "1 event", "12.4k events": the count with its noun, singular only when it reads 1. */
export const formatEventCount = (count: number): string => {
	const shown = formatEvents(count)
	return `${shown} ${shown === "1" ? "event" : "events"}`
}

export const isBudgetSpent = (budget: number): boolean => budget <= 0

/** How far past the budget a spent SLO is: "fully spent" at exactly 0, else the overspend. */
export const overspentText = (budget: number): string =>
	budget < 0 ? `${formatBudget(-budget)} over budget` : "fully spent"

export const budgetTone = (budget: number): Tone =>
	isBudgetSpent(budget) ? "crit" : budget < 0.25 ? "warn" : "ok"

export const sliTone = (slo: Pick<Slo, "target_percent">, sli: number | null): Tone =>
	sli === null ? "neutral" : sli * 100 >= slo.target_percent ? "ok" : "crit"

/** What a tier reading needs of the SLO: the target sets the burn each tier fires at. */
export type SloTarget = Pick<Slo, "target_percent">

/** The burn a tier fires at for this SLO: its factor, capped under what the target can reach. */
export const factorOf = (slo: SloTarget, tier: SloTier): number => tierFactor(tier, slo.target_percent)

/** Whether the target is too low for the tier's own factor, so it fires at a lower one. */
export const isCapped = (slo: SloTarget, tier: SloTier): boolean => factorOf(slo, tier) < tier.factor

/** The highest burn the target can reach: a total outage burns 1 / budget. */
export const maxBurn = (slo: SloTarget): number => 1 / errorBudgetRatio(slo.target_percent)

/** "14.4x", "8x": a tier's factor, without a trailing zero. */
export const formatFactor = (factor: number): string => `${Number(factor.toFixed(1))}x`

/** "A target of 90% can burn at most 10x": why a low target's tiers fire under their own factors. */
export const maxBurnLine = (slo: SloTarget): string =>
	`A target of ${formatTarget(slo)} can burn at most ${formatFactor(maxBurn(slo))}`

/** The lowest burn at which a tier of `severity` fires for this SLO. */
const lowestFactor = (slo: SloTarget, severity: SloSeverity): number =>
	Math.min(
		...Arr.map(
			Arr.filter(SLO_BURN_TIERS, (tier) => tier.severity === severity),
			(tier) => factorOf(slo, tier),
		),
	)

/** Red at the SLO's critical factor, amber at its lowest warning factor. */
export const burnTone = (slo: SloTarget, rate: number): Tone =>
	rate >= lowestFactor(slo, "critical") ? "crit" : rate >= lowestFactor(slo, "warning") ? "warn" : "neutral"

/** The window counted no events at all: there is no SLI and no budget to read. */
export const hasNoData = (status: Pick<SloStatus, "sli">): boolean => status.sli === null

/** Why an SLO counts nothing, for a hint beside "No data". */
export const NO_DATA_HINT =
	"No traffic matches this SLO's service and environments. Environments are free text: prod does not match production."

/** Budget left, or `null` when the window counted nothing to measure it against. */
export const budgetLeft = (status: Pick<SloStatus, "sli" | "budget_remaining">): number | null =>
	hasNoData(status) ? null : status.budget_remaining

/** Whether the budget is spent on enough events to judge, as the evaluator reads it. */
export const isSpent = (
	slo: SloTarget,
	status: Pick<SloStatus, "total_events" | "good_events" | "sample_count">,
): boolean =>
	budgetSpent(
		{ total: status.total_events, good: status.good_events, samples: status.sample_count },
		slo.target_percent,
	)

/** The budget's tone as the evaluator reads it: overspent on a handful of events is no verdict. */
export const budgetToneOf = (
	slo: SloTarget,
	status: Pick<SloStatus, "budget_remaining" | "total_events" | "good_events" | "sample_count">,
): Tone =>
	isBudgetSpent(status.budget_remaining) && !isSpent(slo, status)
		? "neutral"
		: budgetTone(status.budget_remaining)

/**
 * The spent-budget notice, in the evaluator's three states: spent, back by less than the margin
 * its incident waits for, and back past it.
 */
export const budgetNotice = (
	slo: Pick<Slo, "target_percent" | "window_days">,
	status: Pick<SloStatus, "budget_remaining">,
): Readonly<{ title: string; description: string }> =>
	isBudgetSpent(status.budget_remaining)
		? {
				title: "Error budget spent",
				description: `The last ${formatWindow(slo.window_days)} used every bad event ${formatTarget(slo)} allows: ${overspentText(status.budget_remaining)}. It recovers as bad hours leave the window.`,
			}
		: status.budget_remaining < SLO_BUDGET_RECOVERY
			? {
					title: "Error budget barely back",
					description: `Less than ${formatBudget(SLO_BUDGET_RECOVERY)} of the budget is left. The incident stays open until ${formatBudget(SLO_BUDGET_RECOVERY)} is back, so it does not close and reopen around zero.`,
				}
			: {
					title: "Error budget is back",
					description: "Budget is left again. The incident resolves on the next budget check.",
				}

const domainWindows = (status: SloStatus) =>
	Arr.map(status.burn_windows, (window) => ({
		windowMinutes: window.window_minutes,
		burnRate: window.burn_rate,
		total: window.total_events,
		good: window.good_events,
		samples: window.sample_count,
	}))

export type TierReading = Readonly<{ tier: SloTier; state: SloTierState }>

/** Each tier as the evaluator reads it: breaching, holding (nothing or too little to judge), or clear. */
export const tierStates = (slo: SloTarget, status: SloStatus): ReadonlyArray<TierReading> => {
	const windows = domainWindows(status)
	return Arr.map(SLO_BURN_TIERS, (tier) => ({
		tier,
		state: tierState(tier, windows, slo.target_percent),
	}))
}

/** The most severe tier whose windows burn at its factor: critical before warning. */
export const firingTier = (slo: SloTarget, status: SloStatus): Option.Option<SloTier> =>
	Option.map(
		Arr.findFirst(tierStates(slo, status), (reading) => reading.state === "breach"),
		(reading) => reading.tier,
	)

/** The most severe tier holding its state, when none breaches: an open incident stays open. */
export const holdingTier = (slo: SloTarget, status: SloStatus): Option.Option<SloTier> =>
	Option.isSome(firingTier(slo, status))
		? Option.none()
		: Option.map(
				Arr.findFirst(tierStates(slo, status), (reading) => reading.state === "hold"),
				(reading) => reading.tier,
			)

/** Why a tier holds: its short window is empty, or it burns on too few events or failures to judge. */
export type HoldReason = "no-events" | "few-events"

export const holdReason = (status: SloStatus, tier: SloTier): HoldReason =>
	Option.match(
		Arr.findFirst(status.burn_windows, (window) => window.window_minutes === tier.shortWindowMinutes),
		{
			onNone: () => "no-events",
			onSome: (window) => (window.total_events > 0 ? "few-events" : "no-events"),
		},
	)

/** "Holding: no events in 5m, an open incident stays open", or too little in the long window. */
export const holdingLine = (tier: SloTier, reason: HoldReason): string =>
	reason === "no-events"
		? `Holding: no events in ${windowLabel(tier.shortWindowMinutes)}, an open incident stays open`
		: `Holding: too few events or failures in ${windowLabel(tier.longWindowMinutes)} to judge, an open incident stays open`

export const fastestBurn = (status: SloStatus): number =>
	Arr.reduce(status.burn_windows, 0, (fastest, window) => Math.max(fastest, window.burn_rate))

export const burnOf = (status: SloStatus, minutes: number): number =>
	Option.match(
		Arr.findFirst(status.burn_windows, (window) => window.window_minutes === minutes),
		{ onNone: () => 0, onSome: (window) => window.burn_rate },
	)

/** The SLO's burn-rate rule incidents, newest first as synced. */
export const sloIncidents = (
	slo: Pick<Slo, "alert_rule_id">,
	incidents: ReadonlyArray<AlertIncidentRow>,
): ReadonlyArray<AlertIncidentRow> =>
	slo.alert_rule_id === null ? [] : Arr.filter(incidents, (row) => row.rule_id === slo.alert_rule_id)

/** An incident row about the budget being spent, not about how fast it burns. */
export const isBudgetIncidentRow = (row: Pick<AlertIncidentRow, "signal_type" | "group_key">): boolean =>
	isSloBudgetIncident({ signalType: row.signal_type, groupKey: row.group_key })

/** The open incident a burning tier opened, never the spent-budget one. */
export const openBurnIncident = (
	slo: Pick<Slo, "alert_rule_id">,
	incidents: ReadonlyArray<AlertIncidentRow>,
): Option.Option<AlertIncidentRow> =>
	Arr.findFirst(sloIncidents(slo, incidents), (row) => row.status === "open" && !isBudgetIncidentRow(row))

/** The open incident about the spent budget: it stays open beside any burn incident. */
export const openBudgetIncident = (
	slo: Pick<Slo, "alert_rule_id">,
	incidents: ReadonlyArray<AlertIncidentRow>,
): Option.Option<AlertIncidentRow> =>
	Arr.findFirst(sloIncidents(slo, incidents), (row) => row.status === "open" && isBudgetIncidentRow(row))

/** Burning: a tier fires, or a tier holds while the SLO's burn incident stays open. */
export const isBurning = (
	row: Readonly<{ slo: Pick<Slo, "alert_rule_id" | "target_percent">; status: SloStatus | null }>,
	incidents: ReadonlyArray<AlertIncidentRow>,
): boolean =>
	row.status !== null &&
	(Option.isSome(firingTier(row.slo, row.status)) ||
		(Option.isSome(holdingTier(row.slo, row.status)) &&
			Option.isSome(openBurnIncident(row.slo, incidents))))

/** "checkout · production, staging", or the service alone when every environment counts. */
export const scopeLine = (slo: Pick<Slo, "service_name" | "environments">): string =>
	slo.environments.length === 0
		? slo.service_name
		: `${slo.service_name} · ${Arr.join(slo.environments, ", ")}`
