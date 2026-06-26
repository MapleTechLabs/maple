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
/** Upper bound on rate-limit backoff so a target keeps probing for recovery. */
const MAX_BACKOFF_MS = Duration.toMillis(Duration.minutes(5))

export interface ScrapeOutcome {
	readonly error: string | null
	readonly samplesScraped?: number
	readonly samplesPostMetricRelabeling?: number
	/** Upstream signalled a rate limit (HTTP 429/503) — back off before retrying. */
	readonly rateLimited: boolean
	/** Upstream `Retry-After` translated to ms, when present. */
	readonly retryAfterMs: number | null
}

/**
 * The target period before a target's next scrape. The happy path returns the
 * configured interval; the caller ({@link ScrapeScheduler}'s target loop)
 * subtracts the scrape's own elapsed time so the happy-path cadence stays
 * start-to-start. A rate-limited scrape escalates exponentially — honoring
 * `Retry-After` when it is longer — capped at {@link MAX_BACKOFF_MS} so the
 * target keeps probing for recovery; that delay runs from scrape end.
 */
export const nextScrapeDelayMs = ({
	baseMs,
	outcome,
	consecutiveRateLimits,
}: {
	readonly baseMs: number
	readonly outcome: ScrapeOutcome
	readonly consecutiveRateLimits: number
}): number => {
	if (!outcome.rateLimited) return baseMs
	// exponential is always >= baseMs (consecutiveRateLimits >= 0), so baseMs
	// never needs to be a floor here.
	const exponential = baseMs * 2 ** consecutiveRateLimits
	const retryAfter = outcome.retryAfterMs ?? 0
	return Math.min(MAX_BACKOFF_MS, Math.max(exponential, retryAfter))
}

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
								// A non-2xx is a recorded failure, not an Effect error: only
								// 429/503 trigger backoff, and we need the Retry-After hint.
								return {
									error: `target returned HTTP ${response.status}`,
									rateLimited: response.status === 429 || response.status === 503,
									retryAfterMs:
										response.retryAfterSeconds !== null
											? response.retryAfterSeconds * 1000
											: null,
								} satisfies ScrapeOutcome
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
								rateLimited: false,
								retryAfterMs: null,
							} satisfies ScrapeOutcome
						}).pipe(
							Effect.catch((error) =>
								Effect.succeed<ScrapeOutcome>({
									error: error.message,
									rateLimited: false,
									retryAfterMs: null,
								}),
							),
							Effect.catchDefect((defect) =>
								Effect.succeed<ScrapeOutcome>({
									error: Cause.pretty(Cause.die(defect)),
									rateLimited: false,
									retryAfterMs: null,
								}),
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
						return outcome
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

			// Scrape, then sleep before the next pass. The happy path holds the
			// configured interval; a 429/503 escalates the delay (see
			// nextScrapeDelayMs) so the target backs off and self-recovers instead
			// of hammering a rate-limited upstream every interval.
			const targetLoop = (target: InternalScrapeTarget) => {
				const baseMs = target.scrapeIntervalSeconds * 1000
				const loop = (consecutiveRateLimits: number): Effect.Effect<never> =>
					Effect.gen(function* () {
						const startedAt = yield* Clock.currentTimeMillis
						const outcome = yield* scrapeOnce(target)
						const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt
						const delayMs = nextScrapeDelayMs({ baseMs, outcome, consecutiveRateLimits })
						if (outcome.rateLimited) {
							yield* Effect.logWarning("Scrape rate-limited, backing off").pipe(
								Effect.annotateLogs({
									targetId: target.id,
									orgId: target.orgId,
									...(target.subTargetKey ? { subTargetKey: target.subTargetKey } : {}),
									delayMs,
									retryAfterMs: outcome.retryAfterMs,
									consecutiveRateLimits: consecutiveRateLimits + 1,
								}),
							)
						}
						// Happy path: subtract the scrape's own elapsed time so cadence
						// stays start-to-start (matching the old Schedule.fixed). Backoff
						// runs the full delay from scrape end so Retry-After is honored.
						const sleepMs = outcome.rateLimited ? delayMs : Math.max(0, delayMs - elapsedMs)
						yield* Effect.sleep(Duration.millis(sleepMs))
						return yield* loop(outcome.rateLimited ? consecutiveRateLimits + 1 : 0)
					})
				return loop(0)
			}

			const reconcile = Effect.gen(function* () {
				const targets = yield* api.listTargets()
				const current = yield* Ref.get(fibersRef)
				const next = new Map<string, TargetEntry>()

				yield* Effect.forEach(
					targets,
					(target) =>
						Effect.gen(function* () {
							const key = targetKey(target)
							const fingerprint = targetFingerprint(target)
							const existing = current.get(key)
							if (existing && existing.fingerprint === fingerprint) {
								next.set(key, existing)
								return
							}
							if (existing) yield* Fiber.interrupt(existing.fiber)
							const fiber = yield* Effect.forkChild(targetLoop(target))
							next.set(key, { fingerprint, fiber })
						}),
					{ discard: true },
				)

				yield* Effect.forEach(
					current,
					([id, entry]) =>
						next.has(id) ? Effect.void : Fiber.interrupt(entry.fiber),
					{ discard: true },
				)

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
