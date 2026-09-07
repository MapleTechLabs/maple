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
 *
 * One cron fire: the tick over its own light layer graph, one Postgres socket
 * for the tick. The bridge builds the telemetry into the fire's scope.
 */
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer } from "effect"
import type { ApiPortsLayer } from "./bindings"
import { provideEvent, settleFire } from "./events"
import { pgScopeModule, slackReconcileModule, vcsSyncModule } from "./modules"

const VCS_SYNC_CRON = "0 */12 * * *"
const SCRAPE_RETENTION_CRON = "0 * * * *"
const SLACK_RECONCILE_CRON = "0 */6 * * *"

/** Attaches the three schedules at plan time and their listeners at runtime. Needs `CronEventSourceLive`. */
export const registerCrons = (ports: ApiPortsLayer) =>
	Effect.gen(function* () {
		const pgScope = yield* Effect.cached(pgScopeModule)
		const vcsSync = yield* Effect.cached(vcsSyncModule)
		const slackReconcile = yield* Effect.cached(slackReconcileModule)

		yield* Cloudflare.Workers.cron(VCS_SYNC_CRON, () =>
			Effect.gen(function* () {
				const [
					{ buildVcsScheduledLayer, runScheduledSync, vcsSyncTelemetry },
					{ withPgConnectionScope },
				] = yield* Effect.all([vcsSync, pgScope])
				return yield* withPgConnectionScope(runScheduledSync).pipe(
					provideEvent(
						buildVcsScheduledLayer().pipe(
							Layer.provideMerge(vcsSyncTelemetry),
							Layer.provideMerge(ports),
						),
					),
					settleFire(VCS_SYNC_CRON),
				)
			}),
		)
		yield* Cloudflare.Workers.cron(SCRAPE_RETENTION_CRON, () =>
			Effect.gen(function* () {
				const [
					{ buildScrapeRetentionLayer, vcsSyncTelemetry },
					{ withPgConnectionScope },
					{ runScrapeCheckRetention },
					{ runPlanetScaleEventRetention },
				] = yield* Effect.all([
					vcsSync,
					pgScope,
					Effect.promise(() => import("../services/integrations/scrape-check-retention")),
					Effect.promise(() => import("../services/integrations/planetscale-event-retention")),
				])
				// Both sweeps ride this one cron: each new cron string costs a branch
				// here, and neither needs its own beat. Sequential, not concurrent —
				// they share one Postgres socket for the whole tick, so running them
				// concurrently would only queue on it.
				return yield* withPgConnectionScope(
					Effect.andThen(runScrapeCheckRetention, runPlanetScaleEventRetention),
				).pipe(
					provideEvent(
						buildScrapeRetentionLayer().pipe(
							Layer.provideMerge(vcsSyncTelemetry),
							Layer.provideMerge(ports),
						),
					),
					settleFire(SCRAPE_RETENTION_CRON),
				)
			}),
		)
		yield* Cloudflare.Workers.cron(SLACK_RECONCILE_CRON, () =>
			Effect.gen(function* () {
				const [
					{ buildSlackReconcileLayer, runSlackReconciliation, slackReconcileTelemetry },
					{ withPgConnectionScope },
				] = yield* Effect.all([slackReconcile, pgScope])
				return yield* withPgConnectionScope(runSlackReconciliation).pipe(
					provideEvent(
						buildSlackReconcileLayer().pipe(
							Layer.provideMerge(slackReconcileTelemetry),
							Layer.provideMerge(ports),
						),
					),
					settleFire(SLACK_RECONCILE_CRON),
				)
			}),
		)
	})
