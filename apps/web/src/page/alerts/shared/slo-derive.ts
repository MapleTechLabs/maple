import type { AlertIncidentRow } from "@maple/web-data/collections/alerts"
import type { V2Slo, V2SloSli, V2SloStatus } from "@maple/domain/http/v2"
import {
	SLO_BURN_TIERS,
	type SloBurnTier,
	type SloTierState,
	tierState,
	windowLabel,
} from "@maple/domain/slo"
import type { Tone } from "@maple/ui/lib/tone"
import { Array as Arr, Option } from "effect"

// What the SLO pages say about an SLO and its status: the SLI and target in words, the
// budget and burn figures, and which burn-rate tier would fire.

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

/** Budget left as a whole percent; overspent reads negative. */
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

/** A spent budget: none left, or overspent. */
export const isBudgetSpent = (budget: number): boolean => budget <= 0

/** Spent is red, under a quarter left amber, anything else neutral. */
export const budgetTone = (budget: number): Tone =>
	isBudgetSpent(budget) ? "crit" : budget < 0.25 ? "warn" : "ok"

export const sliTone = (slo: Pick<Slo, "target_percent">, sli: number | null): Tone =>
	sli === null ? "neutral" : sli * 100 >= slo.target_percent ? "ok" : "crit"

/** The tier colours follow the alert pages: critical red, warning amber. */
export const TIER_TONE = { critical: "crit", warning: "warn" } as const satisfies Record<
	SloTier["severity"],
	Tone
>

export const burnTone = (rate: number): Tone =>
	rate >= (SLO_BURN_TIERS[0]?.factor ?? Infinity)
		? "crit"
		: rate >= (SLO_BURN_TIERS[1]?.factor ?? Infinity)
			? "warn"
			: "neutral"

const domainWindows = (status: SloStatus) =>
	Arr.map(status.burn_windows, (window) => ({
		windowMinutes: window.window_minutes,
		burnRate: window.burn_rate,
		total: window.total_events,
		good: window.good_events,
	}))

export type TierReading = Readonly<{ tier: SloTier; state: SloTierState }>

/** Each tier as the evaluator reads it: breaching, holding (no events in its short window), or clear. */
export const tierStates = (status: SloStatus): ReadonlyArray<TierReading> => {
	const windows = domainWindows(status)
	return Arr.map(SLO_BURN_TIERS, (tier) => ({ tier, state: tierState(tier, windows) }))
}

/** The most severe tier whose windows burn at its factor: critical before warning. */
export const firingTier = (status: SloStatus): Option.Option<SloTier> =>
	Option.map(
		Arr.findFirst(tierStates(status), (reading) => reading.state === "breach"),
		(reading) => reading.tier,
	)

/** The most severe tier holding its state, when none breaches: an open incident stays open. */
export const holdingTier = (status: SloStatus): Option.Option<SloTier> =>
	Option.isSome(firingTier(status))
		? Option.none()
		: Option.map(
				Arr.findFirst(tierStates(status), (reading) => reading.state === "hold"),
				(reading) => reading.tier,
			)

/** "Holding: no events in 5m, an open incident stays open." */
export const holdingLine = (tier: SloTier): string =>
	`Holding: no events in ${windowLabel(tier.shortWindowMinutes)}, an open incident stays open`

/** The fastest of the four windows' burn rates, 0 without windows. */
export const fastestBurn = (status: SloStatus): number =>
	Arr.reduce(status.burn_windows, 0, (fastest, window) => Math.max(fastest, window.burn_rate))

/** A burn window's rate, 0 when the status does not carry it. */
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

/** The open incident on the SLO's rule, if any. */
export const openIncident = (
	slo: Pick<Slo, "alert_rule_id">,
	incidents: ReadonlyArray<AlertIncidentRow>,
): Option.Option<AlertIncidentRow> =>
	Arr.findFirst(sloIncidents(slo, incidents), (row) => row.status === "open")

/** "checkout · production, staging", or the service alone when every environment counts. */
export const scopeLine = (slo: Pick<Slo, "service_name" | "environments">): string =>
	slo.environments.length === 0
		? slo.service_name
		: `${slo.service_name} · ${Arr.join(slo.environments, ", ")}`
