import { Array as Arr, Option, Schema } from "effect"
import { SloLatencyThresholdMs } from "./primitives"

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
 * when both its long and short windows burn at least `factor` times the sustainable rate. The
 * short window makes the alert resolve soon after the burn stops.
 */
export const SLO_BURN_TIERS = [
	{ severity: "critical", factor: 14.4, longWindowMinutes: 60, shortWindowMinutes: 5 },
	{ severity: "warning", factor: 6, longWindowMinutes: 360, shortWindowMinutes: 30 },
] as const
export type SloBurnTier = (typeof SLO_BURN_TIERS)[number]

/** Every window a tier reads, ascending. */
export const SLO_BURN_WINDOWS_MINUTES = [5, 30, 60, 360] as const
export type SloBurnWindowMinutes = (typeof SLO_BURN_WINDOWS_MINUTES)[number]

/** The longest burn window: the span one burn-rate read covers. */
export const SLO_BURN_LOOKBACK_MINUTES = Math.max(...SLO_BURN_WINDOWS_MINUTES)

export interface SloBurnWindow extends SloCounts {
	readonly windowMinutes: SloBurnWindowMinutes
	readonly burnRate: number
}

/** Whether a tier fires on the given window burns. */
export const tierBreached = (tier: SloBurnTier, windows: ReadonlyArray<SloBurnWindow>): boolean => {
	const rateOf = (minutes: number) =>
		Arr.findFirst(windows, (window) => window.windowMinutes === minutes).pipe(
			Option.match({ onNone: () => 0, onSome: (window) => window.burnRate }),
		)
	return rateOf(tier.longWindowMinutes) >= tier.factor && rateOf(tier.shortWindowMinutes) >= tier.factor
}

/** A bucket of events starting at `startMs`. */
export interface SloBucket extends SloCounts {
	readonly startMs: number
}

const sumCounts = (buckets: ReadonlyArray<SloCounts>): SloCounts =>
	Arr.reduce(buckets, { total: 0, good: 0 }, (acc, bucket) => ({
		total: acc.total + bucket.total,
		good: acc.good + bucket.good,
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
 * The budget chart from buckets covering two SLO windows: one point per bucket of the last
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
	const slotCount = 2 * slotsPerWindow
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
		const slot = slotsPerWindow + index
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
