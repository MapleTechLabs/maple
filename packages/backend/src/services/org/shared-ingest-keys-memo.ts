import { Context } from "effect"
import type { OrgIngestKeyRow } from "@maple/db/tables"
import type { ExpiringStore } from "@maple/backend/platform/expiring-store"

/**
 * The org ingest-key row memo shared by every `OrgIngestKeysService` built under it, keyed by org.
 * Unset, each service keeps its own, scoped to the database it was built over.
 */
export class SharedIngestKeysMemo extends Context.Reference<ExpiringStore<OrgIngestKeyRow> | undefined>(
	"@maple/backend/services/org/SharedIngestKeysMemo",
	{ defaultValue: () => undefined },
) {}
