import { Cause, Clock, Context, Duration, Effect, Fiber, Layer, Ref, Schedule, Semaphore } from "effect"
import { ScrapeResultReport, type InternalScrapeTarget } from "@maple/domain/http"
import { ApiClient, ApiRequestError } from "./ApiClient"
import { convertFamiliesToRows } from "./prometheus/convert"
import { parsePrometheusText } from "./prometheus/parser"
import { ScraperEnv } from "./Env"
import { TinybirdIngest } from "./TinybirdIngest"

export interface SchedulerStats {
	readonly activeTargets: number
	readonly lastReconcileAt: number | null
	readonly pendingResults: number
}

export interface ScrapeSchedulerShape {
	/**
	 * Run the scraper forever: reconcile the target list on an interval,
	 * keep one scrape-loop fiber per target, flush scrape results back to the
	 * API periodically. Only exits on interruption.
	 */
	readonly run: Effect.Effect<never, ApiRequestError>
	readonly stats: Effect.Effect<SchedulerStats>
}

const RESULTS_FLUSH_INTERVAL = Duration.seconds(10)
/** Cap the result buffer so an unreachable API cannot grow memory unboundedly. */
const MAX_BUFFERED_RESULTS = 10_000

const hostFromUrl = (url: string): string => {
	try {
		return new URL(url).host
	} catch {
		return url
	}
}

/** Restart a target's loop when anything affecting its scrape output changes. */
const targetFingerprint = (target: InternalScrapeTarget): string =>
	JSON.stringify([
		target.url,
		target.scrapeIntervalSeconds,
		target.name,
		target.serviceName,
		target.orgId,
		Object.entries(target.labels).sort(([a], [b]) => (a < b ? -1 : 1)),
	])

interface TargetEntry {
	readonly fingerprint: string
	readonly fiber: Fiber.Fiber<unknown, unknown>
}

export class ScrapeScheduler extends Context.Service<ScrapeScheduler, ScrapeSchedulerShape>()(
	"@maple/scraper/ScrapeScheduler",
	{
		make: Effect.gen(function* () {
			const env = yield* ScraperEnv
			const api = yield* ApiClient
			const tinybird = yield* TinybirdIngest

			const semaphore = yield* Semaphore.make(env.SCRAPER_CONCURRENCY)
			const resultsRef = yield* Ref.make<ReadonlyArray<ScrapeResultReport>>([])
			const fibersRef = yield* Ref.make(new Map<string, TargetEntry>())
			const lastReconcileRef = yield* Ref.make<number | null>(null)

			const enqueueResult = (result: ScrapeResultReport) =>
				Ref.update(resultsRef, (buffered) =>
					buffered.length >= MAX_BUFFERED_RESULTS ? [...buffered.slice(1), result] : [...buffered, result],
				)

			const recordOutcome = (target: InternalScrapeTarget, scrapedAt: number, error: string | null) =>
				enqueueResult(new ScrapeResultReport({ targetId: target.id, scrapedAt, error }))

			const scrapeOnce = (target: InternalScrapeTarget) =>
				semaphore.withPermits(1)(
					Effect.gen(function* () {
						const scrapeTimeMs = yield* Clock.currentTimeMillis

						const outcome = yield* Effect.gen(function* () {
							const response = yield* api.scrapeTarget(target.id)
							if (response.status < 200 || response.status >= 300) {
								return yield* Effect.fail(
									new ApiRequestError({
										message: `target returned HTTP ${response.status}`,
										status: response.status,
									}),
								)
							}

							const parsed = parsePrometheusText(response.body)
							const rows = convertFamiliesToRows(parsed.families, {
								orgId: target.orgId,
								targetId: target.id,
								targetName: target.name,
								serviceName: target.serviceName ?? target.name,
								instance: hostFromUrl(target.url),
								targetLabels: target.labels,
								scrapeTimeMs,
							})

							// Ingest failures count as scrape failures: lastScrapeAt must
							// not advance when the data never landed.
							yield* tinybird.ingest("metrics_sum", rows.sum)
							yield* tinybird.ingest("metrics_gauge", rows.gauge)
							yield* tinybird.ingest("metrics_histogram", rows.histogram)

							yield* Effect.annotateCurrentSpan({
								sumRows: rows.sum.length,
								gaugeRows: rows.gauge.length,
								histogramRows: rows.histogram.length,
								droppedSeries: rows.droppedSeriesCount,
								skippedLines: parsed.skippedLineCount,
							})
							return null
						}).pipe(
							Effect.catch((error) => Effect.succeed(error.message)),
							Effect.catchDefect((defect) => Effect.succeed(Cause.pretty(Cause.die(defect)))),
						)

						yield* recordOutcome(target, scrapeTimeMs, outcome)
						if (outcome !== null) {
							yield* Effect.logWarning("Scrape failed").pipe(
								Effect.annotateLogs({
									targetId: target.id,
									orgId: target.orgId,
									error: outcome,
								}),
							)
						}
					}).pipe(
						Effect.withSpan("scraper.scrape_target", {
							attributes: {
								orgId: target.orgId,
								targetId: target.id,
								targetName: target.name,
								intervalSeconds: target.scrapeIntervalSeconds,
							},
						}),
					),
				)

			// Schedule.fixed keeps start-to-start spacing at the configured
			// interval (scrape duration does not drift the cadence).
			const targetLoop = (target: InternalScrapeTarget) =>
				scrapeOnce(target).pipe(Effect.repeat(Schedule.fixed(Duration.seconds(target.scrapeIntervalSeconds))))

			const reconcile = Effect.gen(function* () {
				const targets = yield* api.listTargets()
				const current = yield* Ref.get(fibersRef)
				const next = new Map<string, TargetEntry>()

				for (const target of targets) {
					const fingerprint = targetFingerprint(target)
					const existing = current.get(target.id)
					if (existing && existing.fingerprint === fingerprint) {
						next.set(target.id, existing)
						continue
					}
					if (existing) yield* Fiber.interrupt(existing.fiber)
					const fiber = yield* Effect.forkChild(targetLoop(target))
					next.set(target.id, { fingerprint, fiber })
				}

				for (const [id, entry] of current) {
					if (!next.has(id)) yield* Fiber.interrupt(entry.fiber)
				}

				yield* Ref.set(fibersRef, next)
				yield* Ref.set(lastReconcileRef, yield* Clock.currentTimeMillis)
				yield* Effect.annotateCurrentSpan({ activeTargets: next.size })
			}).pipe(
				Effect.withSpan("scraper.reconcile"),
				// A failed list fetch keeps the current fibers running untouched.
				Effect.catch((error) =>
					Effect.logWarning("Failed to refresh scrape target list").pipe(
						Effect.annotateLogs({ error: error.message }),
					),
				),
			)

			const flushResults = Effect.gen(function* () {
				const results = yield* Ref.getAndSet(resultsRef, [])
				if (results.length === 0) return
				yield* api.reportResults(results).pipe(
					Effect.catch((error) =>
						Effect.gen(function* () {
							// Put the batch back (in front) and retry on the next flush.
							yield* Ref.update(resultsRef, (buffered) =>
								[...results, ...buffered].slice(-MAX_BUFFERED_RESULTS),
							)
							yield* Effect.logWarning("Failed to report scrape results").pipe(
								Effect.annotateLogs({ error: error.message, bufferedResults: results.length }),
							)
						}),
					),
				)
			}).pipe(Effect.withSpan("scraper.flush_results"))

			const run = Effect.gen(function* () {
				yield* Effect.forkChild(
					flushResults.pipe(Effect.repeat(Schedule.spaced(RESULTS_FLUSH_INTERVAL))),
				)
				return yield* reconcile.pipe(
					Effect.repeat(Schedule.spaced(Duration.seconds(env.SCRAPER_RECONCILE_INTERVAL_SECONDS))),
					Effect.flatMap(() => Effect.never),
				)
			}) as Effect.Effect<never, ApiRequestError>

			const stats = Effect.gen(function* () {
				const fibers = yield* Ref.get(fibersRef)
				const lastReconcileAt = yield* Ref.get(lastReconcileRef)
				const pending = yield* Ref.get(resultsRef)
				return {
					activeTargets: fibers.size,
					lastReconcileAt,
					pendingResults: pending.length,
				} satisfies SchedulerStats
			})

			return { run, stats } satisfies ScrapeSchedulerShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
