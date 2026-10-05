import {
	Clock,
	Context,
	Duration,
	Effect,
	FiberMap,
	Layer,
	Metric,
	Option,
	Ref,
	Result,
	Schedule,
	Semaphore,
} from "effect"
import { ScrapeResultReport, type InternalScrapeTarget } from "@maple/domain/http"
import { ScraperEnv } from "./Env"
import { activeTargets, scrapeDurationMs, scrapesTotal } from "./Metrics"
import { backoffLogMessage, nextScrapeDelayMs, shouldBackOff, startJitterMs } from "./policy"
import { ResultReporter } from "./ResultReporter"
import type { ScrapeError } from "./ScrapeError"
import { Scraper, type ScrapeSuccess } from "./Scraper"
import { TargetRegistry } from "./TargetRegistry"

export interface SchedulerStats {
	/** `degraded` once the target list has not refreshed for {@link STALE_RECONCILES} intervals. */
	readonly status: "ok" | "degraded"
	readonly activeTargets: number
	readonly lastReconcileAt: number | null
	readonly pendingResults: number
}

export interface ScrapeSchedulerApi {
	/** Reconcile targets on an interval and run one loop per target. Exits only on interruption. */
	readonly run: Effect.Effect<never>
	readonly stats: Effect.Effect<SchedulerStats>
}

const STALE_RECONCILES = 3

/** Start offset for a new loop. A reference so tests can pin cadence to t=0. */
export const StartJitter = Context.Reference<(key: string, baseMs: number) => number>(
	"@maple/scraper/StartJitter",
	{ defaultValue: () => startJitterMs },
)

const toReport = (
	target: InternalScrapeTarget,
	scrapedAt: number,
	durationMs: number,
	result: Result.Result<ScrapeSuccess, ScrapeError>,
) =>
	new ScrapeResultReport({
		targetId: target.id,
		subTargetKey: target.subTargetKey,
		scrapedAt,
		durationMs,
		...(Result.isSuccess(result)
			? {
					error: null,
					samplesScraped: result.success.samplesScraped,
					samplesPostMetricRelabeling: result.success.samplesExported,
				}
			: { error: result.failure.message }),
	})

export class ScrapeScheduler extends Context.Service<ScrapeScheduler, ScrapeSchedulerApi>()(
	"@maple/scraper/ScrapeScheduler",
	{
		make: Effect.gen(function* () {
			const env = yield* ScraperEnv
			const registry = yield* TargetRegistry
			const scraper = yield* Scraper
			const reporter = yield* ResultReporter
			const startJitter = yield* StartJitter

			const semaphore = yield* Semaphore.make(env.SCRAPER_CONCURRENCY)
			const startedAt = yield* Clock.currentTimeMillis
			const activeLoops = yield* Ref.make(0)

			const scrapeOnce = (target: InternalScrapeTarget) =>
				semaphore.withPermits(1)(
					Effect.gen(function* () {
						const scrapedAt = yield* Clock.currentTimeMillis
						const result = yield* Effect.result(scraper.scrape(target))
						const durationMs = (yield* Clock.currentTimeMillis) - scrapedAt
						yield* Metric.update(scrapeDurationMs, durationMs)
						yield* Metric.update(scrapesTotal, Result.isSuccess(result) ? "ok" : "error")
						yield* reporter.record(toReport(target, scrapedAt, durationMs, result))
						if (Result.isFailure(result)) {
							yield* Effect.logWarning("Scrape failed").pipe(
								Effect.annotateLogs({
									targetId: target.id,
									targetName: target.name,
									orgId: target.orgId,
									...(target.subTargetKey
										? { subTargetKey: target.subTargetKey }
										: undefined),
									reason: result.failure.reason,
									error: result.failure.message,
								}),
							)
						}
						return Result.isFailure(result) ? result.failure : null
					}),
				)

			// Cadence is start-to-start on the happy path; a backoff runs its full
			// delay from scrape end so Retry-After is honored. Ends once the target is gone.
			const scrapeLoop = (key: string, consecutiveBackoffs: number): Effect.Effect<void> =>
				Effect.gen(function* () {
					const latest = yield* registry.get(key)
					if (Option.isNone(latest)) return
					const target = latest.value
					const baseMs = target.scrapeIntervalSeconds * 1000

					const loopStart = yield* Clock.currentTimeMillis
					const failure = yield* scrapeOnce(target)
					const elapsedMs = (yield* Clock.currentTimeMillis) - loopStart
					const delayMs = nextScrapeDelayMs({ baseMs, failure, consecutiveBackoffs })

					if (failure === null || !shouldBackOff(failure)) {
						yield* Effect.sleep(Duration.millis(Math.max(0, delayMs - elapsedMs)))
						return yield* scrapeLoop(key, 0)
					}
					yield* Effect.logWarning(backoffLogMessage(failure.reason)).pipe(
						Effect.annotateLogs({
							targetId: target.id,
							orgId: target.orgId,
							...(target.subTargetKey ? { subTargetKey: target.subTargetKey } : undefined),
							reason: failure.reason,
							delayMs,
							retryAfterMs: failure.retryAfterMs,
							consecutiveBackoffs: consecutiveBackoffs + 1,
						}),
					)
					yield* Effect.sleep(Duration.millis(delayMs))
					return yield* scrapeLoop(key, consecutiveBackoffs + 1)
				})

			const targetLoop = (key: string, initial: InternalScrapeTarget) =>
				Effect.sleep(Duration.millis(startJitter(key, initial.scrapeIntervalSeconds * 1000))).pipe(
					Effect.andThen(scrapeLoop(key, 0)),
				)

			// Loops are keyed by target alone and read their config each scrape, so
			// reconcile only starts loops for new keys and stops loops for gone ones.
			const reconcile = (loops: FiberMap.FiberMap<string>) =>
				Effect.gen(function* () {
					const desired = yield* registry.refresh
					yield* Effect.forEach(
						Array.from(loops, ([key]) => key),
						(key) => (desired.has(key) ? Effect.void : FiberMap.remove(loops, key)),
						{ discard: true },
					)
					// A plain child fork (not FiberMap.run's detached one) so loops inherit
					// the run fiber's clock; the map interrupts on removal.
					yield* Effect.forEach(
						desired,
						([key, target]) =>
							Effect.flatMap(FiberMap.has(loops, key), (running) =>
								running
									? Effect.void
									: Effect.flatMap(Effect.forkChild(targetLoop(key, target)), (fiber) =>
											FiberMap.set(loops, key, fiber),
										),
							),
						{ discard: true },
					)
					const running = yield* FiberMap.size(loops)
					yield* Ref.set(activeLoops, running)
					yield* Metric.update(activeTargets, running)
					yield* Effect.annotateCurrentSpan("maple.scraper.active_targets", running)
				}).pipe(
					Effect.withSpan("scraper.reconcile"),
					// A failed list fetch keeps every current loop running untouched.
					Effect.catch((error) =>
						Effect.logWarning("Failed to refresh scrape target list").pipe(
							Effect.annotateLogs({ error: error.message }),
						),
					),
				)

			const run = Effect.scoped(
				Effect.gen(function* () {
					const loops = yield* FiberMap.make<string>()
					yield* Effect.forkChild(reporter.run)
					yield* reconcile(loops).pipe(
						Effect.repeat(
							Schedule.spaced(Duration.seconds(env.SCRAPER_RECONCILE_INTERVAL_SECONDS)),
						),
					)
					return yield* Effect.never
				}),
			)

			const stats = Effect.gen(function* () {
				const lastReconcileAt = yield* registry.lastRefreshAt
				const now = yield* Clock.currentTimeMillis
				const staleAfterMs = STALE_RECONCILES * env.SCRAPER_RECONCILE_INTERVAL_SECONDS * 1000
				return {
					status: now - (lastReconcileAt ?? startedAt) > staleAfterMs ? "degraded" : "ok",
					activeTargets: yield* Ref.get(activeLoops),
					lastReconcileAt,
					pendingResults: yield* reporter.pending,
				} satisfies SchedulerStats
			})

			return { run, stats } satisfies ScrapeSchedulerApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
