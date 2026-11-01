import type { OrgIngestKeyRow } from "@maple/db/tables"
import { Effect, Layer } from "effect"
import { makeExpiringStore } from "@maple/backend/platform/expiring-store"
import { SharedIngestKeysMemo } from "@maple/backend/services/org/shared-ingest-keys-memo"
import { SharedIngestRefusals } from "@maple/backend/services/integrations/ci-traces/ingest-refusals"
import { type InstallationToken, SharedInstallationTokens } from "./installation-tokens"

/**
 * The VCS sync consumer's caches, made once per isolate and provided to every batch: GitHub
 * installation tokens, org ingest keys and ingest refusal holds then survive from one batch to the next.
 */
export const makeVcsSyncIsolateCaches = Effect.gen(function* () {
	const tokens = yield* makeExpiringStore<InstallationToken>()
	const ingestKeys = yield* makeExpiringStore<OrgIngestKeyRow>()
	const refusals = yield* makeExpiringStore<string>()
	return Layer.mergeAll(
		Layer.succeed(SharedInstallationTokens, tokens),
		Layer.succeed(SharedIngestKeysMemo, ingestKeys),
		Layer.succeed(SharedIngestRefusals, refusals),
	)
})

export type VcsSyncIsolateCaches = Effect.Success<typeof makeVcsSyncIsolateCaches>
