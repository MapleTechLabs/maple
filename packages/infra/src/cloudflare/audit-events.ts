/**
 * The org audit log's queue. api consumes it; api and maple-ai both produce to it, so an
 * audit entry deferred past a response is one bounded send and the queue owns durability.
 */
import { stageNamed } from "./stack.ts"
import * as Cloudflare from "@alchemy.run/cloudflare"

/** Org audit-log entries on their way to the warehouse. */
export const AuditEventsQueue = Cloudflare.Queues.Queue("audit-events", stageNamed("audit-events"))

/** Audit entries that exhausted retries. No consumer on purpose: kept for inspection. */
export const AuditEventsDlq = Cloudflare.Queues.Queue("audit-events-dlq", stageNamed("audit-events-dlq"))
