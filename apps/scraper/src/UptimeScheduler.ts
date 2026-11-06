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
	Schedule,
	Semaphore,
} from "effect"
import type { UptimeProbeTarget } from "@maple/domain/uptime"
import { ScraperEnv } from "./Env"
import { activeMonitors } from "./Metrics"
import { UptimeReporter } from "./ResultReporter"
import { StartJitter } from "./ScrapeScheduler"
import { UptimeProber } from "./UptimeProber"
import { UptimeRegistry } from "./UptimeRegistry"
import { UptimeSpanExporter } from "./UptimeSpanExporter"

export interface UptimeSchedulerStats {
	/** `degraded` once the monitor list has not refreshed for {@link STALE_RECONCILES} intervals. */
	readonly status: "ok" | "degraded"
	readonly activeMonitors: number
	readonly lastReconcileAt: number | null
	readonly pendingResults: number
	readonly pendingSpans: number
}

export interface UptimeSchedulerApi {
	/** Reconcile monitors on an interval and run one loop per monitor. Exits only on interruption. */
	readonly run: Effect.Effect<never>
	readonly stats: Effect.Effect<UptimeSchedulerStats>
}

const STALE_RECONCILES = 3

export class UptimeScheduler extends Context.Service<UptimeScheduler, UptimeSchedulerApi>()(
	"@maple/scraper/UptimeScheduler",
	{
		make: Effect.gen(function* () {
			const env = yield* ScraperEnv
			const registry = yield* UptimeRegistry
			const prober = yield* UptimeProber
			const reporter = yield* UptimeReporter
			const exporter = yield* UptimeSpanExporter
			const startJitter = yield* StartJitter

			const semaphore = yield* Semaphore.make(env.UPTIME_CONCURRENCY)
			const startedAt = yield* Clock.currentTimeMillis
			const activeLoops = yield* Ref.make(0)

			// One check and its wait, at the latest interval; false once the monitor is gone.
			const checkStep = (id: string): Effect.Effect<boolean> =>
				Effect.gen(function* () {
					const latest = yield* registry.get(id)
					if (Option.isNone(latest)) return false
					const target = latest.value
					const loopStart = yield* Clock.currentTimeMillis
					const report = yield* semaphore.withPermits(1)(prober.check(target))
					yield* reporter.record(report)
					const elapsedMs = (yield* Clock.currentTimeMillis) - loopStart
					yield* Effect.sleep(
						Duration.millis(Math.max(0, target.intervalSeconds * 1000 - elapsedMs)),
					)
					return true
				})

			// Start-to-start whatever the outcome: a down target keeps its cadence, there is no
			// backoff. Repeated rather than recursive, so a long-lived loop holds no growing stack.
			const checkLoop = (id: string): Effect.Effect<void> =>
				checkStep(id).pipe(Effect.repeat({ while: (more) => more }), Effect.asVoid)

			const monitorLoop = (target: UptimeProbeTarget) =>
				Effect.sleep(
					Duration.millis(startJitter(`uptime:${target.id}`, target.intervalSeconds * 1000)),
				).pipe(Effect.andThen(checkLoop(target.id)))

			const reconcile = (loops: FiberMap.FiberMap<string>) =>
				Effect.gen(function* () {
					const desired = yield* registry.refresh
					yield* Effect.forEach(
						Array.from(loops, ([id]) => id),
						(id) => (desired.has(id) ? Effect.void : FiberMap.remove(loops, id)),
						{ discard: true },
					)
					// A plain child fork so loops inherit the run fiber's clock; the map interrupts on removal.
					yield* Effect.forEach(
						desired,
						([id, target]) =>
							Effect.flatMap(FiberMap.has(loops, id), (running) =>
								running
									? Effect.void
									: Effect.flatMap(Effect.forkChild(monitorLoop(target)), (fiber) =>
											FiberMap.set(loops, id, fiber),
										),
							),
						{ discard: true },
					)
					const running = yield* FiberMap.size(loops)
					yield* Ref.set(activeLoops, running)
					yield* Metric.update(activeMonitors, running)
					yield* Effect.annotateCurrentSpan("maple.uptime.active_monitors", running)
				}).pipe(
					Effect.withSpan("uptime.reconcile"),
					// A failed list fetch keeps every current loop running untouched.
					Effect.catch((error) =>
						Effect.logWarning("Failed to refresh uptime monitor list").pipe(
							Effect.annotateLogs({ error: error.message }),
						),
					),
				)

			const run = Effect.scoped(
				Effect.gen(function* () {
					const loops = yield* FiberMap.make<string>()
					yield* Effect.forkChild(reporter.run)
					yield* Effect.forkChild(exporter.run)
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
					activeMonitors: yield* Ref.get(activeLoops),
					lastReconcileAt,
					pendingResults: yield* reporter.pending,
					pendingSpans: yield* exporter.pending,
				} satisfies UptimeSchedulerStats
			})

			return { run, stats } satisfies UptimeSchedulerApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
