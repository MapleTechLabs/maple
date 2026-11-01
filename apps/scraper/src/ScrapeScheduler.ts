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
import type { ScrapeFailureReason } from "./ScrapeError"
import { Scraper, type SubTargetScrape } from "./Scraper"
import { type TargetGroup, TargetRegistry, targetKey } from "./TargetRegistry"

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
export class StartJitter extends Context.Reference<(key: string, baseMs: number) => number>(
	"@maple/scraper/StartJitter",
	{ defaultValue: () => startJitterMs },
) {}

const toReport = (scrape: SubTargetScrape) =>
	new ScrapeResultReport({
		targetId: scrape.target.id,
		subTargetKey: scrape.target.subTargetKey,
		scrapedAt: scrape.scrapedAt,
		durationMs: scrape.durationMs,
		...(Result.isSuccess(scrape.result)
			? {
					error: null,
					samplesScraped: scrape.result.success.samplesScraped,
					samplesPostMetricRelabeling: scrape.result.success.samplesExported,
				}
			: { error: scrape.result.failure.message }),
	})

/** A sub-target in backoff: skipped by its parent's cycles until `notBefore`. */
interface Backoff {
	readonly consecutive: number
	readonly notBefore: number
	/** The failure that put it here; the same failure again is the same streak. */
	readonly reason: ScrapeFailureReason
	/** The URL it failed on; a changed URL is a new endpoint and starts clean. */
	readonly url: string
}

/** Per-parent loop state. Target-side backoff is per sub-target; an ingest block is per parent. */
interface LoopState {
	readonly backoffs: ReadonlyMap<string, Backoff>
	readonly deliveryBackoffs: number
}

const subTargetLog = (target: InternalScrapeTarget) => ({
	targetId: target.id,
	orgId: target.orgId,
	...(target.subTargetKey ? { subTargetKey: target.subTargetKey } : undefined),
})

/**
 * Backoff for the sub-targets a cycle scraped. `delivery_blocked` only ever comes
 * from ingest, so it parks the whole parent instead (see the loop).
 */
const nextBackoffs = (
	current: ReadonlyMap<string, Backoff>,
	group: TargetGroup,
	scrapes: ReadonlyArray<SubTargetScrape>,
	baseMs: number,
	endedAt: number,
): ReadonlyMap<string, Backoff> => {
	const live = new Set(group.map(targetKey))
	const kept = Array.from(current).filter(([key]) => live.has(key))
	const scraped = new Set(scrapes.map((scrape) => targetKey(scrape.target)))
	const updated = scrapes.flatMap((scrape): ReadonlyArray<readonly [string, Backoff]> => {
		const failure = Result.isFailure(scrape.result) ? scrape.result.failure : null
		if (failure === null || !shouldBackOff(failure) || failure.reason === "delivery_blocked") return []
		const key = targetKey(scrape.target)
		const consecutive = current.get(key)?.consecutive ?? 0
		const delayMs = nextScrapeDelayMs({ baseMs, failure, consecutiveBackoffs: consecutive })
		const backoff = {
			consecutive: consecutive + 1,
			notBefore: endedAt + delayMs,
			reason: failure.reason,
			url: scrape.target.url,
		}
		return [[key, backoff]]
	})
	return new Map([...kept.filter(([key]) => !scraped.has(key)), ...updated])
}

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

			const record = (scrape: SubTargetScrape) =>
				Effect.gen(function* () {
					yield* Metric.update(scrapeDurationMs, scrape.durationMs)
					yield* Metric.update(scrapesTotal, Result.isSuccess(scrape.result) ? "ok" : "error")
					yield* reporter.record(toReport(scrape))
					if (Result.isFailure(scrape.result)) {
						const failure = scrape.result.failure
						yield* Effect.logWarning(
							shouldBackOff(failure) ? backoffLogMessage(failure.reason) : "Scrape failed",
						).pipe(
							Effect.annotateLogs({
								...subTargetLog(scrape.target),
								targetName: scrape.target.name,
								reason: failure.reason,
								error: failure.message,
								retryAfterMs: failure.retryAfterMs,
							}),
						)
					}
				})

			// One cycle per parent: every due sub-target is fetched, and all of them go
			// out as one export. Cadence is start-to-start; a sub-target in backoff sits
			// out cycles until its delay (from cycle end, so Retry-After holds) passes.
			const cycle = (id: string, state: Ref.Ref<LoopState>) =>
				Effect.gen(function* () {
					const latest = yield* registry.get(id)
					if (Option.isNone(latest)) return Option.none<number>()
					const group = latest.value
					const baseMs = group[0].scrapeIntervalSeconds * 1000
					const cycleStart = yield* Clock.currentTimeMillis
					const before = yield* Ref.get(state)
					// A backoff earned on another URL neither delays nor quiets the new one.
					const current = new Map(
						Array.from(before.backoffs).filter(([key, backoff]) =>
							group.some((target) => targetKey(target) === key && target.url === backoff.url),
						),
					)

					const notBefore = (target: InternalScrapeTarget) =>
						current.get(targetKey(target))?.notBefore ?? 0
					const [firstDue, ...restDue] = group.filter((target) => notBefore(target) <= cycleStart)
					const outcome =
						firstDue === undefined
							? { scrapes: [], deliveryFailure: null }
							: yield* scraper.scrapeCycle(
									[firstDue, ...restDue],
									semaphore,
									new Map(Array.from(current, ([key, backoff]) => [key, backoff.reason])),
								)
					yield* Effect.forEach(outcome.scrapes, record, { discard: true })
					const endedAt = yield* Clock.currentTimeMillis

					const backoffs = nextBackoffs(current, group, outcome.scrapes, baseMs, endedAt)
					const blocked =
						outcome.deliveryFailure !== null && shouldBackOff(outcome.deliveryFailure)
							? outcome.deliveryFailure
							: null
					yield* Ref.set(state, {
						backoffs,
						deliveryBackoffs: blocked === null ? 0 : before.deliveryBackoffs + 1,
					})
					if (blocked !== null) {
						return Option.some(
							endedAt +
								nextScrapeDelayMs({
									baseMs,
									failure: blocked,
									consecutiveBackoffs: before.deliveryBackoffs,
								}),
						)
					}
					// A healthy sub-target holds the tick. When all are backing off, wake at the
					// earlier of the tick and the first backoff end, so a branch discovered
					// meanwhile still runs within one interval.
					const nextTick = cycleStart + baseMs
					const healthy = group.some((target) => !backoffs.has(targetKey(target)))
					return Option.some(
						healthy
							? nextTick
							: Math.min(
									nextTick,
									...Array.from(backoffs.values(), (backoff) => backoff.notBefore),
								),
					)
				})

			const parentLoop = (id: string, initial: TargetGroup) =>
				Effect.gen(function* () {
					const state = yield* Ref.make<LoopState>({ backoffs: new Map(), deliveryBackoffs: 0 })
					yield* Effect.sleep(
						Duration.millis(startJitter(id, initial[0].scrapeIntervalSeconds * 1000)),
					)
					const step: Effect.Effect<void> = Effect.flatMap(cycle(id, state), (wakeAt) =>
						Option.isNone(wakeAt)
							? Effect.void
							: Effect.flatMap(Clock.currentTimeMillis, (now) =>
									Effect.sleep(Duration.millis(Math.max(0, wakeAt.value - now))),
								).pipe(Effect.andThen(Effect.suspend(() => step))),
					)
					yield* step
				})

			// One loop per parent target id, reading its sub-targets each cycle, so
			// reconcile only starts loops for new parents and stops loops for gone ones.
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
						([key, group]) =>
							Effect.flatMap(FiberMap.has(loops, key), (running) =>
								running
									? Effect.void
									: Effect.flatMap(Effect.forkChild(parentLoop(key, group)), (fiber) =>
											FiberMap.set(loops, key, fiber),
										),
							),
						{ discard: true },
					)
					const running = yield* FiberMap.size(loops)
					const subTargets = Array.from(desired.values()).reduce(
						(total, group) => total + group.length,
						0,
					)
					yield* Ref.set(activeLoops, subTargets)
					yield* Metric.update(activeTargets, subTargets)
					yield* Effect.annotateCurrentSpan({
						"maple.scraper.active_targets": subTargets,
						"maple.scraper.active_loops": running,
					})
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
