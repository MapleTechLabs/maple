import type { ProductEvent } from "@maple/web/lib/analytics"
import { Effect } from "effect"

export type { ProductEvent }

/**
 * `trackProduct` (apps/web/src/lib/analytics.ts), imported on first use so the SDK stays out of
 * startup. It never fails: the SDK queues events until its session starts.
 */
export const trackProduct = (event: ProductEvent, props?: Readonly<Record<string, unknown>>): Effect.Effect<void> =>
	Effect.tryPromise(() => import("@maple/web/lib/analytics")).pipe(
		Effect.flatMap((analytics) => Effect.sync(() => analytics.trackProduct(event, props))),
		Effect.ignore,
	)
