import { Array as Arr, Option, Schema, String as Str } from "effect"
import { SloLatencyThresholdMs } from "@maple/primitives"

// Service level objectives: what counts as a good event (the SLI), the target share of good
// events, and the rolling window the error budget is measured over.

/**
 * The SLI, over a service's entry-point spans (the spans the service overview counts).
 * `availability`: good = not `Error`. `latency`: good = faster than `thresholdMs`.
 */
export const SloSli = Schema.Union([
	Schema.TaggedStruct("availability", {}),
	Schema.TaggedStruct("latency", { thresholdMs: SloLatencyThresholdMs }),
])
export type SloSli = Schema.Schema.Type<typeof SloSli>

/** Target share of good events, in percent: 99.9 leaves a 0.1% error budget. */
export const SloTargetPercent = Schema.Number.check(Schema.isBetween({ minimum: 50, maximum: 99.999 }))
export type SloTargetPercent = Schema.Schema.Type<typeof SloTargetPercent>

/** Share of events the target allows to be bad, as a ratio: 99.9% gives 0.001. */
export const errorBudgetRatio = (targetPercent: number): number => 1 - targetPercent / 100

/** Sampling-weighted event counts over some window. */
export interface SloCounts {
	readonly total: number
	readonly good: number
	/**
	 * Spans actually recorded, before sampling weights: how much was really seen. Absent reads
	 * as unsampled, where it equals `total`.
	 */
	readonly samples?: number
}

/** The requests really seen in a window, and how many of them were bad. */
const evidenceOf = (counts: SloCounts) => {
	const samples = counts.samples ?? counts.total
	return { samples, bad: Math.round(badRatio(counts) * samples) }
}

/** Enough was seen to judge: one failed request, however sampling weighs it, proves nothing. */
const isEnoughEvidence = (counts: SloCounts): boolean => {
	const evidence = evidenceOf(counts)
	return evidence.samples >= SLO_MIN_TIER_EVENTS && evidence.bad >= SLO_MIN_TIER_BAD_EVENTS
}

const badRatio = (counts: SloCounts): number =>
	counts.total > 0 ? Math.max(0, counts.total - counts.good) / counts.total : 0

/** Share of good events, or `null` when the window saw none. */
export const sliRatio = (counts: SloCounts): number | null =>
	counts.total > 0 ? counts.good / counts.total : null

/**
 * How fast the window spends the budget: 1 spends exactly the budget over the SLO window,
 * 14.4 spends 2% of a 30-day budget in an hour. 0 when the window saw no events.
 */
export const burnRate = (counts: SloCounts, targetPercent: number): number =>
	badRatio(counts) / errorBudgetRatio(targetPercent)

/** Share of the window's error budget still unspent: 1 untouched, 0 spent, negative overspent. */
export const budgetRemaining = (counts: SloCounts, targetPercent: number): number =>
	1 - burnRate(counts, targetPercent)

/**
 * The multiwindow, multi-burn-rate alert tiers (Google SRE workbook, chapter 5): a tier fires
 * when both its long and short windows burn at least its factor times the sustainable rate. The
 * short window makes the alert resolve soon after the burn stops. The last tier catches a slow
 * burn the fast ones never see: 3x for a day spends a tenth of a 30-day budget.
 */
export const SLO_BURN_TIERS = [
	{ severity: "critical", factor: 14.4, longWindowMinutes: 60, shortWindowMinutes: 5 },
	{ severity: "warning", factor: 6, longWindowMinutes: 360, shortWindowMinutes: 30 },
	{ severity: "warning", factor: 3, longWindowMinutes: 1440, shortWindowMinutes: 120 },
] as const
export type SloBurnTier = (typeof SLO_BURN_TIERS)[number]
export type SloSeverity = SloBurnTier["severity"]

/** Every window a tier reads, ascending. */
export const SLO_BURN_WINDOWS_MINUTES = [5, 30, 60, 120, 360, 1440] as const
export type SloBurnWindowMinutes = (typeof SLO_BURN_WINDOWS_MINUTES)[number]

/**
 * Fewest recorded events, and fewest bad ones, a tier's long window must hold before the tier
 * can fire. On a quiet service one failed request is a burn of hundreds, which says nothing.
 */
export const SLO_MIN_TIER_EVENTS = 10
export const SLO_MIN_TIER_BAD_EVENTS = 2

/** The share of the highest burn a target can reach that a tier's factor is capped at. */
const REACHABLE_BURN_SHARE = 0.8

/**
 * The burn a tier fires at for this target. A total outage burns 1 / budget, which a low target
 * never gets to 14.4 (90% tops out at 10), so the factor is capped under that ceiling.
 */
export const tierFactor = (tier: SloBurnTier, targetPercent: number): number =>
	// Two decimals: it is shown to people, and `0.8 / 0.1` is not quite 8.
	Math.min(tier.factor, Math.round((REACHABLE_BURN_SHARE / errorBudgetRatio(targetPercent)) * 100) / 100)

/** The longest burn window: the span one burn-rate read covers. */
export const SLO_BURN_LOOKBACK_MINUTES = Math.max(...SLO_BURN_WINDOWS_MINUTES)

export interface SloBurnWindow extends SloCounts {
	readonly windowMinutes: SloBurnWindowMinutes
	readonly burnRate: number
}

/** The window of the given length, if read. */
export const burnWindowOf = (
	windows: ReadonlyArray<SloBurnWindow>,
	minutes: number,
): Option.Option<SloBurnWindow> => Arr.findFirst(windows, (window) => window.windowMinutes === minutes)

const burnOf = (windows: ReadonlyArray<SloBurnWindow>, minutes: number): number =>
	Option.match(burnWindowOf(windows, minutes), { onNone: () => 0, onSome: (window) => window.burnRate })

const burnsAtFactor = (
	tier: SloBurnTier,
	windows: ReadonlyArray<SloBurnWindow>,
	targetPercent: number,
): boolean => {
	const factor = tierFactor(tier, targetPercent)
	return (
		burnOf(windows, tier.longWindowMinutes) >= factor &&
		burnOf(windows, tier.shortWindowMinutes) >= factor
	)
}

const hasEnoughEvents = (tier: SloBurnTier, windows: ReadonlyArray<SloBurnWindow>): boolean =>
	Option.match(burnWindowOf(windows, tier.longWindowMinutes), {
		onNone: () => false,
		onSome: isEnoughEvidence,
	})

/** Whether a tier fires on the given window burns. */
export const tierBreached = (
	tier: SloBurnTier,
	windows: ReadonlyArray<SloBurnWindow>,
	targetPercent: number,
): boolean => tierState(tier, windows, targetPercent) === "breach"

/**
 * Whether a tier can be judged: its short window saw events. An empty short window is an
 * outage or an ingest gap as often as a quiet service, so it neither fires nor resolves.
 */
export const tierObserved = (tier: SloBurnTier, windows: ReadonlyArray<SloBurnWindow>): boolean =>
	Option.match(burnWindowOf(windows, tier.shortWindowMinutes), {
		onNone: () => false,
		onSome: (window) => window.total > 0,
	})

/**
 * How a tier reads now: firing, holding its state, or clear. It holds with no events in its
 * short window, and when it burns on too few events to judge: that opens nothing, and closes nothing.
 */
export type SloTierState = "breach" | "hold" | "clear"

export const tierState = (
	tier: SloBurnTier,
	windows: ReadonlyArray<SloBurnWindow>,
	targetPercent: number,
): SloTierState => {
	if (!tierObserved(tier, windows)) return "hold"
	if (!burnsAtFactor(tier, windows, targetPercent)) return "clear"
	return hasEnoughEvents(tier, windows) ? "breach" : "hold"
}

/** A severity fires when any of its tiers does, and holds when one holds and none fires. */
export const severityState = (
	severity: SloSeverity,
	windows: ReadonlyArray<SloBurnWindow>,
	targetPercent: number,
): SloTierState => {
	const states = Arr.map(
		Arr.filter(SLO_BURN_TIERS, (tier) => tier.severity === severity),
		(tier) => tierState(tier, windows, targetPercent),
	)
	const any = (state: SloTierState) => Arr.some(states, (seen) => seen === state)
	return any("breach") ? "breach" : any("hold") ? "hold" : "clear"
}

/** The tier of `severity` that fires now, the fastest first. */
export const firingTier = (
	severity: SloSeverity,
	windows: ReadonlyArray<SloBurnWindow>,
	targetPercent: number,
): Option.Option<SloBurnTier> =>
	Arr.findFirst(
		SLO_BURN_TIERS,
		(tier) => tier.severity === severity && tierState(tier, windows, targetPercent) === "breach",
	)

/**
 * Whether the window's error budget is spent. Too few events to judge reads as not spent: one
 * failure in a handful of requests overspends any budget.
 */
export const budgetSpent = (counts: SloCounts, targetPercent: number): boolean =>
	isEnoughEvidence(counts) && budgetRemaining(counts, targetPercent) <= BUDGET_SPENT_EPSILON

/**
 * Float slack around zero: ten failures in 100,000 at 99.99% spend the budget exactly, and the
 * division leaves a remainder of 1e-15 that must not read as budget left.
 */
const BUDGET_SPENT_EPSILON = 1e-9

/** Budget a spent SLO must win back before its warning clears, so it does not flap at zero. */
export const SLO_BUDGET_RECOVERY = 0.02

/**
 * How the budget reads: spent, holding, or clear. It holds while less than the recovery margin is
 * back, with or without enough events to judge: a window whose failures aged out down to one that
 * still overspends has not recovered, so an open warning stays open and nothing new opens.
 */
export const budgetState = (counts: SloCounts, targetPercent: number): SloTierState =>
	budgetSpent(counts, targetPercent)
		? "breach"
		: counts.total > 0 && budgetRemaining(counts, targetPercent) < SLO_BUDGET_RECOVERY
			? "hold"
			: "clear"

/** `5m`, `30m`, `1h`, `6h`, `24h`. */
export const windowLabel = (minutes: number): string => (minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`)

/** The longest short window: with none of them holding events, nothing can be judged at all. */
export const SLO_LIVENESS_WINDOW_MINUTES = Math.max(
	...Arr.map(SLO_BURN_TIERS, (tier) => tier.shortWindowMinutes),
)

/** The hidden burn-rate rule's name: it titles incidents and notifications. */
export const SLO_RULE_NAME_PREFIX = "SLO burn: "
export const sloRuleName = (sloName: string): string => `${SLO_RULE_NAME_PREFIX}${sloName}`
/** The SLO name inside a burn-rate rule's name, or `null` for any other rule name. */
export const sloNameFromRuleName = (ruleName: string): string | null =>
	Str.startsWith(SLO_RULE_NAME_PREFIX)(ruleName) ? Str.slice(SLO_RULE_NAME_PREFIX.length)(ruleName) : null

/** A bucket of events starting at `startMs`. */
export interface SloBucket extends SloCounts {
	readonly startMs: number
}

const sumCounts = (buckets: ReadonlyArray<SloCounts>) =>
	Arr.reduce(buckets, { total: 0, good: 0, samples: 0 }, (acc, bucket) => ({
		total: acc.total + bucket.total,
		good: acc.good + bucket.good,
		samples: acc.samples + (bucket.samples ?? bucket.total),
	}))

/** Each burn window ending at `endMs`, summed from minute buckets. */
export const burnWindows = (
	buckets: ReadonlyArray<SloBucket>,
	endMs: number,
	targetPercent: number,
): ReadonlyArray<SloBurnWindow> =>
	Arr.map(SLO_BURN_WINDOWS_MINUTES, (windowMinutes) => {
		const startMs = endMs - windowMinutes * 60_000
		const counts = sumCounts(
			Arr.filter(buckets, (bucket) => bucket.startMs >= startMs && bucket.startMs < endMs),
		)
		return { windowMinutes, ...counts, burnRate: burnRate(counts, targetPercent) }
	})

/** One point of the budget chart: the trailing SLO window as of `atMs`. */
export interface SloHistoryPoint {
	readonly atMs: number
	/** Good share of the bucket ending at `atMs`, `null` when it saw no events. */
	readonly sli: number | null
	/** Budget left over the SLO window ending at `atMs`. */
	readonly budgetRemaining: number
	/** Burn rate of the bucket ending at `atMs`. */
	readonly burnRate: number
}

/**
 * The budget chart from buckets covering two SLO windows less one bucket: one point per bucket of the last
 * window, each reading the SLO window that ends with it. Buckets are `bucketMs` wide and
 * aligned to it; the last point is `endMs`, inside the newest (partial) bucket.
 */
export const budgetHistory = (input: {
	readonly buckets: ReadonlyArray<SloBucket>
	readonly bucketMs: number
	readonly windowMs: number
	readonly endMs: number
	readonly targetPercent: number
}): ReadonlyArray<SloHistoryPoint> => {
	const slotsPerWindow = Math.round(input.windowMs / input.bucketMs)
	// The oldest point's window starts one bucket after the first slot's start.
	const slotCount = 2 * slotsPerWindow - 1
	const alignedEnd = Math.ceil(input.endMs / input.bucketMs) * input.bucketMs
	const origin = alignedEnd - slotCount * input.bucketMs
	const slots = Arr.makeBy(slotCount, () => ({ total: 0, good: 0 }))
	for (const bucket of input.buckets) {
		const slot = slots[Math.floor((bucket.startMs - origin) / input.bucketMs)]
		if (slot === undefined) continue
		slot.total += bucket.total
		slot.good += bucket.good
	}
	// prefix[j] sums slots [0, j).
	const prefix = Arr.scan(slots, { total: 0, good: 0 }, (acc, slot) => ({
		total: acc.total + slot.total,
		good: acc.good + slot.good,
	}))
	const between = (from: number, to: number): SloCounts => {
		const end = prefix[to] ?? { total: 0, good: 0 }
		const start = prefix[from] ?? { total: 0, good: 0 }
		return { total: end.total - start.total, good: end.good - start.good }
	}
	return Arr.makeBy(slotsPerWindow, (index) => {
		const slot = slotsPerWindow - 1 + index
		const last = between(slot, slot + 1)
		return {
			atMs: Math.min(origin + (slot + 1) * input.bucketMs, input.endMs),
			sli: sliRatio(last),
			budgetRemaining: budgetRemaining(
				between(slot + 1 - slotsPerWindow, slot + 1),
				input.targetPercent,
			),
			burnRate: burnRate(last, input.targetPercent),
		}
	})
}

/**
 * The alert group an SLO's spent error budget is observed under, beside its burn. Spelled like
 * `__total__`. A spent budget stays spent for days, so it is its own incident: a burn page still
 * resolves when the burn stops.
 */
export const SLO_BUDGET_GROUP_KEY = "__slo_budget__"

/** An SLO incident about the budget being spent rather than about how fast it burns. */
export const isSloBudgetIncident = (incident: {
	readonly signalType: string
	readonly groupKey?: string | null
}): boolean => incident.signalType === "slo_burn_rate" && incident.groupKey === SLO_BUDGET_GROUP_KEY
