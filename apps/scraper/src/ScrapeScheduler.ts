import { Cause, Clock, Context, Duration, Effect, Fiber, Layer, Ref, Schedule, Semaphore } from "effect"
import { ScrapeResultReport, type InternalScrapeTarget } from "@maple/domain/http"
import { ApiClient, ApiRequestError } from "./ApiClient"
import { convertFamiliesToOtlp } from "./prometheus/otlp"
import { parsePrometheusText } from "./prometheus/parser"
import { OtlpIngest } from "./OtlpIngest"
import { ScraperEnv } from "./Env"

interface SchedulerStats {
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

/**
 * Fiber-map key: discovered sub-targets (PlanetScale branches) share one
 * target id, so each `(id, subTargetKey)` pair runs its own scrape loop.
 */
const targetKey = (target: InternalScrapeTarget): string => `${target.id}:${target.subTargetKey ?? ""}`

/** Restart a target's loop when anything affecting its scrape output changes. */
const targetFingerprint = (target: InternalScrapeTarget): string =>
	JSON.stringify([
		target.url,
		target.subTargetKey,
		target.scrapeIntervalSeconds,
		target.name,
		target.serviceName,
		target.orgId,
		target.ingestKey,
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
			const otlp = yield* OtlpIngest

			const semaphore = yield* Semaphore.make(env.SCRAPER_CONCURRENCY)
			const resultsRef = yield* Ref.make<ReadonlyArray<ScrapeResultReport>>([])
			const fibersRef = yield* Ref.make(new Map<string, TargetEntry>())
			const lastReconcileRef = yield* Ref.make<number | null>(null)

			const enqueueResult = (result: ScrapeResultReport) =>
				Ref.update(resultsRef, (buffered) =>
					buffered.length >= MAX_BUFFERED_RESULTS
						? [...buffered.slice(1), result]
						: [...buffered, result],
				)

			interface ScrapeOutcome {
				readonly error: string | null
				readonly samplesScraped?: number
				readonly samplesPostMetricRelabeling?: number
			}

			const recordOutcome = (
				target: InternalScrapeTarget,
				scrapedAt: number,
				durationMs: number,
				outcome: ScrapeOutcome,
			) =>
				enqueueResult(
					new ScrapeResultReport({
						targetId: target.id,
						scrapedAt,
						error: outcome.error,
						subTargetKey: target.subTargetKey,
						durationMs,
						...(outcome.samplesScraped !== undefined
							? { samplesScraped: outcome.samplesScraped }
							: {}),
						...(outcome.samplesPostMetricRelabeling !== undefined
							? { samplesPostMetricRelabeling: outcome.samplesPostMetricRelabeling }
							: {}),
					}),
				)

			const scrapeOnce = (target: InternalScrapeTarget) =>
				semaphore.withPermits(1)(
					Effect.gen(function* () {
						const scrapeTimeMs = yield* Clock.currentTimeMillis

						const outcome: ScrapeOutcome = yield* Effect.gen(function* () {
							const response = yield* api.scrapeTarget(target.id, target.subTargetKey)
							if (response.status < 200 || response.status >= 300) {
								return yield* Effect.fail(
									new ApiRequestError({
										message: `target returned HTTP ${response.status}`,
										status: response.status,
									}),
								)
							}

							const parsed = parsePrometheusText(response.body)
							const converted = convertFamiliesToOtlp(parsed.families, {
								targetId: target.id,
								targetName: target.name,
								serviceName: target.serviceName ?? target.name,
								instance: hostFromUrl(target.url),
								targetLabels: target.labels,
								scrapeTimeMs,
							})

							// One OTLP export per scrape, through the ingest gateway with
							// the org's public key: this is what bills the data (Autumn
							// byte metering + limit enforcement) and routes it to the
							// org's warehouse (Tinybird or self-managed ClickHouse).
							// Ingest failures count as scrape failures: lastScrapeAt must
							// not advance when the data never landed.
							if (converted.request !== null) {
								yield* otlp.send(target.ingestKey, converted.request)
							}

							yield* Effect.annotateCurrentSpan({
								sumDataPoints: converted.dataPointCounts.sum,
								gaugeDataPoints: converted.dataPointCounts.gauge,
								histogramDataPoints: converted.dataPointCounts.histogram,
								droppedSeries: converted.droppedSeriesCount,
								skippedLines: parsed.skippedLineCount,
							})
							return {
								error: null,
								samplesScraped: parsed.families.reduce(
									(total, family) => total + family.samples.length,
									0,
								),
								samplesPostMetricRelabeling:
									converted.dataPointCounts.sum +
									converted.dataPointCounts.gauge +
									converted.dataPointCounts.histogram,
							} satisfies ScrapeOutcome
						}).pipe(
							Effect.catch((error) => Effect.succeed<ScrapeOutcome>({ error: error.message })),
							Effect.catchDefect((defect) =>
								Effect.succeed<ScrapeOutcome>({ error: Cause.pretty(Cause.die(defect)) }),
							),
						)

						const durationMs = (yield* Clock.currentTimeMillis) - scrapeTimeMs
						yield* recordOutcome(target, scrapeTimeMs, durationMs, outcome)
						if (outcome.error !== null) {
							yield* Effect.logWarning("Scrape failed").pipe(
								Effect.annotateLogs({
									targetId: target.id,
									orgId: target.orgId,
									error: outcome.error,
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
								...(target.subTargetKey ? { subTargetKey: target.subTargetKey } : {}),
							},
						}),
					),
				)

			// Schedule.fixed keeps start-to-start spacing at the configured
			// interval (scrape duration does not drift the cadence).
			const targetLoop = (target: InternalScrapeTarget) =>
				scrapeOnce(target).pipe(
					Effect.repeat(Schedule.fixed(Duration.seconds(target.scrapeIntervalSeconds))),
				)

			const reconcile = Effect.gen(function* () {
				const targets = yield* api.listTargets()
				const current = yield* Ref.get(fibersRef)
				const next = new Map<string, TargetEntry>()

				for (const target of targets) {
					const key = targetKey(target)
					const fingerprint = targetFingerprint(target)
					const existing = current.get(key)
					if (existing && existing.fingerprint === fingerprint) {
						next.set(key, existing)
						continue
					}
					if (existing) yield* Fiber.interrupt(existing.fiber)
					const fiber = yield* Effect.forkChild(targetLoop(target))
					next.set(key, { fingerprint, fiber })
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
								Effect.annotateLogs({
									error: error.message,
									bufferedResults: results.length,
								}),
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
