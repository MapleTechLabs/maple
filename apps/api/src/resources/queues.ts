/**
 * The api Worker's queues, declared once at module scope and inert until a
 * Worker yields them: the init consumes them (`worker/consumers.ts`) and the
 * props bind them for the producers. Under `alchemy dev` both halves are
 * emulated in-process from these same declarations.
 */
import { stageNamed } from "@maple/infra/cloudflare"
import * as Cloudflare from "alchemy/Cloudflare"

/** Vendor-agnostic VCS sync jobs (commit backfill + webhook deltas). */
export const VcsSyncQueue = Cloudflare.Queues.Queue("vcs-sync", stageNamed("vcs-sync"))

/** PlanetScale webhook deliveries, decoupled from the receiving request. */
export const PlanetScaleWebhookQueue = Cloudflare.Queues.Queue(
	"planetscale-webhooks",
	stageNamed("planetscale-webhooks"),
)

/** Org audit-log entries on their way to the warehouse. */
export const AuditEventsQueue = Cloudflare.Queues.Queue("audit-events", stageNamed("audit-events"))

/**
 * Parking lot for audit entries that exhausted their retries. Deliberately
 * has no consumer: an entry landing here is a lost audit record, and the
 * point is that it survives for inspection instead of being dropped.
 */
export const AuditEventsDlq = Cloudflare.Queues.Queue("audit-events-dlq", stageNamed("audit-events-dlq"))
