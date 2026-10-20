import type { OrgIngestKeyRow } from "@maple/db/tables"
import { Effect, Layer } from "effect"
import { makeExpiringStore } from "@maple/backend/platform/expiring-store"
import { SharedIngestKeysMemo } from "@maple/backend/services/org/shared-ingest-keys-memo"
import { type InstallationToken, SharedInstallationTokens } from "./installation-tokens"

/**
 * The VCS sync consumer's caches, made once per isolate and provided to every batch: GitHub
 * installation tokens and org ingest keys then survive from one batch to the next.
 */
export const makeVcsSyncIsolateCaches = Effect.gen(function* () {
	const tokens = yield* makeExpiringStore<InstallationToken>()
	const ingestKeys = yield* makeExpiringStore<OrgIngestKeyRow>()
	return Layer.mergeAll(
		Layer.succeed(SharedInstallationTokens, tokens),
		Layer.succeed(SharedIngestKeysMemo, ingestKeys),
	)
})

export type VcsSyncIsolateCaches = Effect.Success<typeof makeVcsSyncIsolateCaches>
