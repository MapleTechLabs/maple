import { randomUUID } from "node:crypto"
import { Clock, Context, Effect } from "effect"

const DELIVERY_TIMEOUT_MS_DEFAULT = 15_000

export interface AlertRuntimeApi {
	/** Current wall-clock time in epoch ms, sourced from Effect's `Clock` so tests drive it via `TestClock`. */
	readonly now: Effect.Effect<number>
	readonly makeUuid: () => string
	readonly fetch: typeof fetch
	readonly deliveryTimeoutMs: () => number
}

export class AlertRuntime extends Context.Reference<AlertRuntimeApi>("@maple/api/services/AlertRuntime", {
	defaultValue: (): AlertRuntimeApi => ({
		now: Clock.currentTimeMillis,
		makeUuid: () => randomUUID(),
		fetch: globalThis.fetch,
		deliveryTimeoutMs: () => DELIVERY_TIMEOUT_MS_DEFAULT,
	}),
}) {}
