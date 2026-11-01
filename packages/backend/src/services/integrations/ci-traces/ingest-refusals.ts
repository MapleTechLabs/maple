import { Context } from "effect"
import type { ExpiringStore } from "@maple/backend/platform/expiring-store"

/** The public key ingest refused and why. A different current key ends the hold. */
export interface IngestRefusal {
	readonly publicKey: string
	readonly message: string
}

/**
 * Orgs whose key ingest refused (billing, revoked key), keyed by org.
 * Shared per isolate so the hold outlives a batch; unset, each CI trace sink keeps its own.
 */
export class SharedIngestRefusals extends Context.Reference<ExpiringStore<IngestRefusal> | undefined>(
	"@maple/backend/services/integrations/ci-traces/SharedIngestRefusals",
	{ defaultValue: () => undefined },
) {}
