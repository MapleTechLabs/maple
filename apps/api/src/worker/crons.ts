/**
 * The api Worker's schedules. Dispatched by `Cloudflare.Workers.cron`:
 *   every 12h — VCS sync backstop, enqueues a refresh per installation
 *   hourly    — scrape_target_checks retention (was inline on the
 *               scrape-results write path; a busy target writes ~75k
 *               rows/day, so the 10k cap binds within hours)
 */
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer } from "effect"
import { layerPg } from "@maple/backend/platform/DatabasePgLive"
import type { ApiPortsLayer } from "./bindings"
import { runEvent, settleFire } from "./events"
import { vcsSyncModule } from "./modules"

const VCS_SYNC_CRON = "0 */12 * * *"
const SCRAPE_RETENTION_CRON = "0 * * * *"

/** Attaches the two schedules at plan time and their listeners at runtime. Needs `CronEventSourceLive`. */
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
				const [{ vcsSyncTelemetry }, { runScrapeCheckRetention }, { runPlanetScaleEventRetention }] =
					yield* Effect.all([
						vcsSyncModule,
						Effect.promise(
							() => import("@maple/backend/services/integrations/scrape-check-retention"),
						),
						Effect.promise(
							() => import("@maple/backend/services/integrations/planetscale-event-retention"),
						),
					])
				// Both sweeps ride this one cron, sequentially: they share the tick's
				// one Postgres socket, so running them concurrently would only queue.
				// The jobs talk only to Postgres, so the layer is the database alone.
				return yield* runEvent(
					Effect.andThen(runScrapeCheckRetention, runPlanetScaleEventRetention),
					layerPg.pipe(Layer.provideMerge(vcsSyncTelemetry), Layer.provideMerge(ports)),
				)
			}).pipe(settleFire(SCRAPE_RETENTION_CRON)),
		)
	})
