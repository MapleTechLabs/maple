import { randomUUID } from "node:crypto"
import { Clock, Context, Effect } from "effect"

const DELIVERY_TIMEOUT_MS_DEFAULT = 15_000
const SCHEDULER_TICK_BUDGET_MS_DEFAULT = 25_000
const SCHEDULER_EVAL_TIMEOUT_MS_DEFAULT = 15_000
const SCHEDULER_SPREAD_MS_DEFAULT = 15_000

export interface AlertRuntimeApi {
	/** Current wall-clock time in epoch ms, sourced from Effect's `Clock` so tests drive it via `TestClock`. */
	readonly now: Effect.Effect<number>
	readonly makeUuid: () => string
	readonly deliveryTimeoutMs: () => number
	/** How long after its start a scheduler tick may still start evaluations. Clamped below the claim TTL. */
	readonly schedulerTickBudgetMs: () => number
	/** Ceiling on one rule's warehouse evaluation inside a scheduler tick. */
	readonly schedulerEvalTimeoutMs: () => number
	/** How long after its start a scheduler tick spaces out rule evaluations, so they do not hit the warehouse at once. */
	readonly schedulerSpreadMs: () => number
}

export class AlertRuntime extends Context.Reference<AlertRuntimeApi>("@maple/backend/services/AlertRuntime", {
	defaultValue: (): AlertRuntimeApi => ({
		now: Clock.currentTimeMillis,
		makeUuid: () => randomUUID(),
		deliveryTimeoutMs: () => DELIVERY_TIMEOUT_MS_DEFAULT,
		schedulerTickBudgetMs: () => SCHEDULER_TICK_BUDGET_MS_DEFAULT,
		schedulerEvalTimeoutMs: () => SCHEDULER_EVAL_TIMEOUT_MS_DEFAULT,
		schedulerSpreadMs: () => SCHEDULER_SPREAD_MS_DEFAULT,
	}),
}) {}
