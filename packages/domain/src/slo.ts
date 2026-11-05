import { Schema } from "effect"
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
