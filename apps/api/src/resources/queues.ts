/** The api Worker's queues, inert until yielded (consumers in `worker/consumers.ts`). */
import { stageNamed } from "@maple/infra/cloudflare"
import * as Cloudflare from "@alchemy.run/cloudflare"

/** Vendor-agnostic VCS sync jobs (commit backfill + webhook deltas). */
export const VcsSyncQueue = Cloudflare.Queues.Queue("vcs-sync", stageNamed("vcs-sync"))

/** PlanetScale webhook deliveries, decoupled from the receiving request. */
export const PlanetScaleWebhookQueue = Cloudflare.Queues.Queue(
	"planetscale-webhooks",
	stageNamed("planetscale-webhooks"),
)

/** Cancelled plans the Autumn webhook read, reviewed off its request. */
export const CancellationReviewsQueue = Cloudflare.Queues.Queue(
	"cancellation-reviews",
	stageNamed("cancellation-reviews"),
)

/** Org audit-log entries on their way to the warehouse. */
export const AuditEventsQueue = Cloudflare.Queues.Queue("audit-events", stageNamed("audit-events"))

/** Audit entries that exhausted retries. No consumer on purpose: kept for inspection. */
export const AuditEventsDlq = Cloudflare.Queues.Queue("audit-events-dlq", stageNamed("audit-events-dlq"))
