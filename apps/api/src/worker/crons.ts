/**
 * The api Worker's schedules. Dispatched by `Cloudflare.Workers.cron`:
 *   every 12h — VCS sync backstop, enqueues a refresh per installation
 *   hourly    — scrape_target_checks retention (was inline on the
 *               scrape-results write path; a busy target writes ~75k
 *               rows/day, so the 10k cap binds within hours)
 *   every 6h  — Slack workspace reconciliation: backstop for
 *               SlackEventsRouter (app_uninstalled/tokens_revoked), which
 *               catches deliveries Slack never sent/retried through, or
 *               installs that predate the webhook
 */
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer } from "effect"
import type { ApiPortsLayer } from "./bindings"
import { runEvent, settleFire } from "./events"
import { slackReconcileModule, vcsSyncModule } from "./modules"

const VCS_SYNC_CRON = "0 */12 * * *"
const SCRAPE_RETENTION_CRON = "0 * * * *"
const SLACK_RECONCILE_CRON = "0 */6 * * *"

/** Attaches the three schedules at plan time and their listeners at runtime. Needs `CronEventSourceLive`. */
export const registerCrons = (ports: ApiPortsLayer) =>
	Effect.gen(function* () {
		yield* Cloudflare.Workers.cron(VCS_SYNC_CRON, () =>
			Effect.flatMap(vcsSyncModule, ({ VcsScheduledLive, runScheduledSync, vcsSyncTelemetry }) =>
				runEvent(
					runScheduledSync,
					VcsScheduledLive.pipe(Layer.provideMerge(vcsSyncTelemetry), Layer.provideMerge(ports)),
				),
			).pipe(settleFire(VCS_SYNC_CRON)),
		)
		yield* Cloudflare.Workers.cron(SCRAPE_RETENTION_CRON, () =>
			Effect.gen(function* () {
				const [
					{ ScrapeRetentionLive, vcsSyncTelemetry },
					{ runScrapeCheckRetention },
					{ runPlanetScaleEventRetention },
				] = yield* Effect.all([
					vcsSyncModule,
					Effect.promise(() => import("../services/integrations/scrape-check-retention")),
					Effect.promise(() => import("../services/integrations/planetscale-event-retention")),
				])
				// Both sweeps ride this one cron, sequentially: they share the tick's
				// one Postgres socket, so running them concurrently would only queue.
				return yield* runEvent(
					Effect.andThen(runScrapeCheckRetention, runPlanetScaleEventRetention),
					ScrapeRetentionLive.pipe(Layer.provideMerge(vcsSyncTelemetry), Layer.provideMerge(ports)),
				)
			}).pipe(settleFire(SCRAPE_RETENTION_CRON)),
		)
		yield* Cloudflare.Workers.cron(SLACK_RECONCILE_CRON, () =>
			Effect.flatMap(
				slackReconcileModule,
				({ SlackReconcileLive, runSlackReconciliation, slackReconcileTelemetry }) =>
					runEvent(
						runSlackReconciliation,
						SlackReconcileLive.pipe(
							Layer.provideMerge(slackReconcileTelemetry),
							Layer.provideMerge(ports),
						),
					),
			).pipe(settleFire(SLACK_RECONCILE_CRON)),
		)
	})
