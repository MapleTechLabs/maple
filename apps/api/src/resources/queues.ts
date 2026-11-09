/** The api Worker's queues, inert until yielded (consumers in `worker/consumers.ts`). */
import { stageNamed } from "@maple/infra/cloudflare"
import * as Cloudflare from "@alchemy.run/cloudflare"

/** Vendor-agnostic VCS webhook deltas: pushes, pull request and CI events. */
export const VcsSyncQueue = Cloudflare.Queues.Queue("vcs-sync", stageNamed("vcs-sync"))

/** Bulk VCS refreshes, on their own queue so a scheduled sync never delays a webhook. */
export const VcsBackfillQueue = Cloudflare.Queues.Queue("vcs-backfill", stageNamed("vcs-backfill"))

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
