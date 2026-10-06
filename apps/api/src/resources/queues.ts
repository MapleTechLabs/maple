/** The api Worker's queues, inert until yielded (consumers in `worker/consumers.ts`). */
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

/** Audit entries that exhausted retries. No consumer on purpose: kept for inspection. */
export const AuditEventsDlq = Cloudflare.Queues.Queue("audit-events-dlq", stageNamed("audit-events-dlq"))
