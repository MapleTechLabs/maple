import { Effect } from "effect"

// `trackProduct` (apps/web/src/lib/analytics.ts): a product event on the active session. The SDK
// is `import()`ed here so the capture engine stays out of the startup bundle.

export type AlertProductEvent = "alert_rule_created"

/** Records `event` with `props`; never fails (the SDK queues until a session starts). */
export const trackProduct = (event: AlertProductEvent, props: Readonly<Record<string, string>>) =>
	Effect.promise(() => import("@maple/web/lib/analytics")).pipe(
		Effect.flatMap(({ trackProduct: track }) => Effect.sync(() => track(event, { ...props }))),
		Effect.ignore,
	)
