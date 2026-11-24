/**
 * The api Worker's schedules. Dispatched by `Cloudflare.Workers.cron`:
 *   every 12h — VCS sync backstop, enqueues a refresh per installation
 *   hourly    — scrape_target_checks retention (was inline on the
 *               scrape-results write path; a busy target writes ~75k
 *               rows/day, so the 10k cap binds within hours), PlanetScale
 *               event retention, and source maps unused for 90 days
 */
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Effect, Layer } from "effect"
import { DatabasePgLive } from "@maple/backend/platform/DatabasePgLive"
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
				const [
					{ vcsSyncTelemetry },
					{ runScrapeCheckRetention },
					{ runPlanetScaleEventRetention },
					{ runSourceMapRetention },
				] = yield* Effect.all([
					vcsSyncModule,
					Effect.promise(
						() => import("@maple/backend/services/integrations/scrape-check-retention"),
					),
					Effect.promise(
						() => import("@maple/backend/services/integrations/planetscale-event-retention"),
					),
					Effect.promise(() => import("@maple/backend/services/sourcemaps/SourceMapService")),
				])
				// The sweeps ride this one cron, sequentially: they share the tick's
				// one Postgres socket, so running them concurrently would only queue. A failed
				// sweep does not skip the next.
				// The jobs talk to Postgres, and the source map sweep to its bucket from `ports`.
				return yield* runEvent(
					Effect.all(
						[runScrapeCheckRetention, runPlanetScaleEventRetention, runSourceMapRetention],
						{
							mode: "result",
							discard: true,
						},
					),
					DatabasePgLive.pipe(Layer.provideMerge(vcsSyncTelemetry), Layer.provideMerge(ports)),
				)
			}).pipe(settleFire(SCRAPE_RETENTION_CRON)),
		)
	})
