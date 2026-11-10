import { Schema } from "effect"
import type { Effect } from "effect"

/** A storage call failed (binding threw, network, quota). A miss is `null`, never this. */
export class StatusStorageError extends Schema.TaggedError<StatusStorageError>()(
	"@maple/status/StorageError",
	{
		message: Schema.String,
		store: Schema.Literals(["kv", "r2", "cache", "rate-limit"]),
		key: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

export interface CachedValue {
	readonly value: string
	readonly storedAt: number
}

/** Everything the status Worker reads or writes: KV, R2, the per-colo cache and a rate limiter. */
export interface StatusStorage {
	readonly kvGet: (key: string) => Effect.Effect<string | null, StatusStorageError>
	readonly kvPut: (key: string, value: string) => Effect.Effect<void, StatusStorageError>
	/** Up to `limit` key names under `prefix`, in key order. */
	readonly kvList: (
		prefix: string,
		limit: number,
	) => Effect.Effect<ReadonlyArray<string>, StatusStorageError>
	readonly r2Get: (key: string) => Effect.Effect<string | null, StatusStorageError>
	readonly cacheGet: (key: string) => Effect.Effect<CachedValue | null, StatusStorageError>
	readonly cachePut: (key: string, entry: CachedValue) => Effect.Effect<void, StatusStorageError>
	/** True when the request may proceed. */
	readonly rateLimit: (key: string) => Effect.Effect<boolean, StatusStorageError>
}

/** What Maple answered a subscription request with; `rejected` carries a message for the visitor. */
export type SubscriptionOutcome =
	| { readonly _tag: "ok" }
	| { readonly _tag: "rejected"; readonly message: string }
	| { readonly _tag: "not-found" }
	| { readonly _tag: "unavailable" }

/** Maple's subscription endpoints. Never fails: an unreachable Maple is `unavailable`. */
export interface StatusSubscriptions {
	/** `componentIds` null: every component. */
	readonly subscribe: (
		pageId: string,
		input: { readonly email: string; readonly componentIds: ReadonlyArray<string> | null },
	) => Effect.Effect<SubscriptionOutcome>
	readonly confirm: (pageId: string, token: string) => Effect.Effect<SubscriptionOutcome>
	readonly unsubscribe: (pageId: string, token: string) => Effect.Effect<SubscriptionOutcome>
}

/** Per-request inputs: storage, the clock and a random source, so handling is deterministic in tests. */
export interface StatusEnv {
	readonly storage: StatusStorage
	readonly subscriptions: StatusSubscriptions
	readonly nowMs: number
	readonly randomId: () => string
	/** Maple's own hosts for this Worker (its domain, workers.dev, local dev), which serve `/s/<slug>`. */
	readonly isSharedHost: (hostname: string) => boolean
}
