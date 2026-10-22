import type { ProductEvent } from "../lib/analytics"
import { Effect } from "effect"
import type { SessionIdentity } from "../platform/session-identity"

export type { ProductEvent }

// The SDK's client entry, `import()`ed on first use so it stays out of startup. It shares the
// capture engine (on `globalThis`) with the session `platform/telemetry.ts` starts.
const sdk = Effect.tryPromise(() => import("@maple-dev/effect-sdk/client"))

/**
 * `trackProduct` (apps/web/src/lib/analytics.ts): a `custom` session event on the session the
 * Foldkit telemetry started. Never fails: the engine queues events until that session's sink runs.
 */
export const trackProduct = (event: ProductEvent, props?: Readonly<Record<string, unknown>>) =>
	Effect.flatMap(sdk, ({ track }) =>
		Effect.sync(() => track(event, props === undefined ? undefined : { ...props })),
	).pipe(Effect.ignore)

/** `identify()` from `ClerkAuthBridge`: later session rows and events carry the user and org. */
export const identifySession = (identity: SessionIdentity | null) =>
	Effect.flatMap(sdk, ({ identify }) => Effect.sync(() => identify(identity ?? undefined))).pipe(
		Effect.ignore,
	)
