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

/** Per-request inputs: storage, the clock and a random source, so handling is deterministic in tests. */
export interface StatusEnv {
	readonly storage: StatusStorage
	readonly nowMs: number
	readonly randomId: () => string
}
