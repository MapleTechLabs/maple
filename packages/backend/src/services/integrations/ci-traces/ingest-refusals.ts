import { Context } from "effect"
import type { ExpiringStore } from "@maple/backend/platform/expiring-store"

/**
 * Orgs whose key ingest refused (billing, revoked key), keyed by org, holding the refusal message.
 * Shared per isolate so the hold outlives a batch; unset, each CI trace sink keeps its own.
 */
export class SharedIngestRefusals extends Context.Reference<ExpiringStore<string> | undefined>(
	"@maple/backend/services/integrations/ci-traces/SharedIngestRefusals",
	{ defaultValue: () => undefined },
) {}
