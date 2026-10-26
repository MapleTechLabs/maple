import { Cause, Clock, Context, Duration, Effect, Layer, Result, type Semaphore } from "effect"
import { type InternalScrapeTarget, SOURCE_ID_ATTRIBUTE } from "@maple/domain/http"
import {
	convertFamiliesToOtlp,
	countSamples,
	mergeExportRequests,
	type OtlpExportRequest,
	parsePrometheusText,
	type ScrapeOtlpContext,
} from "@maple/prometheus-otlp"
import { OtlpIngest } from "./OtlpIngest"
import { ScrapeError, scrapeError, withScrapeSpan } from "./ScrapeError"
import { scrapeTimeoutMs, TargetFetcher } from "./TargetFetcher"
import type { TargetGroup } from "./TargetRegistry"

export interface ScrapeSuccess {
	/** Prometheus samples parsed from the exposition. */
	readonly samplesScraped: number
	/** OTLP data points exported after conversion drops. */
	readonly samplesExported: number
}

/** One sub-target's outcome within a cycle, reported to the API on its own. */
export interface SubTargetScrape {
	readonly target: InternalScrapeTarget
	/** Epoch ms its fetch started. */
	readonly scrapedAt: number
	/** Its own fetch and convert time; the shared delivery is timed on the cycle span. */
	readonly durationMs: number
	/** Its own fetch/convert failure, or the cycle's delivery failure, attributed to it. */
	readonly result: Result.Result<ScrapeSuccess, ScrapeError>
}

export interface ScrapeCycle {
	readonly scrapes: ReadonlyArray<SubTargetScrape>
	/** The shared ingest failure. The ingest key is per parent, so a block applies to all of it. */
	readonly deliveryFailure: ScrapeError | null
}

export interface ScraperApi {
	/**
	 * Fetch every sub-target of one parent in parallel (one `permits` permit each),
	 * convert each, and deliver the successful ones as one merged export. Never fails:
	 * each sub-target carries its own result.
	 */
	readonly scrapeCycle: (targets: TargetGroup, permits: Semaphore.Semaphore) => Effect.Effect<ScrapeCycle>
}

/**
 * Fetch ceiling for a sub-target sharing a cycle: half the interval, so one
 * stalled branch cannot hold the others' delivery past the next tick. A lone
 * target keeps the fetcher's own interval-wide ceiling.
 */
export const sharedCycleFetchTimeoutMs = (scrapeIntervalSeconds: number): number =>
	Math.min(scrapeTimeoutMs(scrapeIntervalSeconds), Math.max(1_000, scrapeIntervalSeconds * 500))

export const hostFromUrl = (url: string): string =>
	Result.getOrElse(
		Result.try(() => new URL(url).host),
		() => url,
	)

/**
 * The OTLP shape the ingest gateway expects from a scrape. `maple_org_id` is
 * deliberately absent: the gateway injects it from the ingest key.
 */
export const otlpContext = (target: InternalScrapeTarget, scrapeTimeMs: number): ScrapeOtlpContext => {
	const serviceName = target.serviceName ?? target.name
	return {
		resource: {
			"service.name": serviceName,
			maple_scrape_target_id: target.id,
			maple_scrape_target_name: target.name,
			...(target.sourceId === undefined ? undefined : { [SOURCE_ID_ATTRIBUTE]: target.sourceId }),
		},
		scopeName: "maple-prometheus-scraper",
		job: serviceName,
		instance: hostFromUrl(target.url),
		targetLabels: target.labels,
		scrapeTimeMs,
	}
}

/** Name the target in the failure, so its error issue and fingerprint identify it. */
const attribute = (error: ScrapeError, target: InternalScrapeTarget, host: string): ScrapeError =>
	new ScrapeError({
		message: `target "${target.name}" (${host}) ${error.message}`,
		reason: error.reason,
		statusCode: error.statusCode,
		retryAfterMs: error.retryAfterMs,
		targetId: target.id,
		targetName: target.name,
		targetHost: host,
	})

interface Collected {
	readonly target: InternalScrapeTarget
	readonly scrapedAt: number
	readonly fetchedAt: number
	readonly result: Result.Result<
		{ readonly request: OtlpExportRequest | null; readonly success: ScrapeSuccess },
		ScrapeError
	>
}

export class Scraper extends Context.Service<Scraper, ScraperApi>()("@maple/scraper/Scraper", {
	make: Effect.gen(function* () {
		const fetcher = yield* TargetFetcher
		const ingest = yield* OtlpIngest

		// One span per sub-target, so dashboards and per-branch error issues keep their shape.
		const collect = (target: InternalScrapeTarget, shared: boolean) => {
			const host = hostFromUrl(target.url)
			return Effect.gen(function* () {
				const scrapeTimeMs = yield* Clock.currentTimeMillis
				const body = yield* shared
					? fetcher.fetch(target).pipe(
							Effect.timeoutOrElse({
								duration: Duration.millis(
									sharedCycleFetchTimeoutMs(target.scrapeIntervalSeconds),
								),
								orElse: () =>
									Effect.fail(
										scrapeError({ message: "request timed out", reason: "target_error" }),
									),
							}),
						)
					: fetcher.fetch(target)
				const parsed = parsePrometheusText(body)
				const converted = convertFamiliesToOtlp(parsed.families, otlpContext(target, scrapeTimeMs))

				const counts = converted.dataPointCounts
				yield* Effect.annotateCurrentSpan({
					"maple.scraper.sum_data_points": counts.sum,
					"maple.scraper.gauge_data_points": counts.gauge,
					"maple.scraper.histogram_data_points": counts.histogram,
					"maple.scraper.dropped_series": converted.droppedSeriesCount,
					"maple.scraper.skipped_lines": parsed.skippedLineCount,
				})
				return {
					request: converted.request,
					success: {
						samplesScraped: countSamples(parsed.families),
						samplesExported: counts.sum + counts.gauge + counts.histogram,
					} satisfies ScrapeSuccess,
				}
			}).pipe(
				Effect.catchDefect((defect) =>
					Effect.fail(
						scrapeError({ message: Cause.pretty(Cause.die(defect)), reason: "scrape_failed" }),
					),
				),
				Effect.mapError((error) => attribute(error, target, host)),
				withScrapeSpan("scraper.scrape_target", {
					attributes: {
						orgId: target.orgId,
						"maple.scraper.target_id": target.id,
						"maple.scraper.target_name": target.name,
						"maple.scraper.target_host": host,
						"maple.scraper.interval_seconds": target.scrapeIntervalSeconds,
						...(target.subTargetKey
							? { "maple.scraper.sub_target_key": target.subTargetKey }
							: undefined),
						...(target.sourceId === undefined
							? undefined
							: { "maple.source.id": target.sourceId }),
					},
				}),
			)
		}

		const timedCollect = (target: InternalScrapeTarget, shared: boolean, permits: Semaphore.Semaphore) =>
			permits.withPermits(1)(
				Effect.gen(function* () {
					const scrapedAt = yield* Clock.currentTimeMillis
					const result = yield* Effect.result(collect(target, shared))
					const fetchedAt = yield* Clock.currentTimeMillis
					return { target, scrapedAt, fetchedAt, result } satisfies Collected
				}),
			)

		const scrapeCycle = (targets: TargetGroup, permits: Semaphore.Semaphore) => {
			const [first] = targets
			return Effect.gen(function* () {
				const collected = yield* Effect.forEach(
					targets,
					(target) => timedCollect(target, targets.length > 1, permits),
					{
						concurrency: "unbounded",
					},
				)
				const requests = collected.flatMap((entry) =>
					Result.isSuccess(entry.result) && entry.result.success.request !== null
						? [entry.result.success.request]
						: [],
				)
				// Sub-targets of one parent share its org and ingest key, so one export carries them all.
				const delivery =
					requests.length === 0
						? Result.succeed(undefined)
						: yield* Effect.result(
								permits.withPermits(1)(
									ingest.send(first.ingestKey, mergeExportRequests(requests)),
								),
							)
				const deliveryFailure = Result.isFailure(delivery) ? delivery.failure : null

				// Duration is the sub-target's own fetch and convert; the shared send is on the cycle span.
				const scrapes = collected.map(
					({ target, scrapedAt, fetchedAt, result }): SubTargetScrape => ({
						target,
						scrapedAt,
						durationMs: fetchedAt - scrapedAt,
						result:
							Result.isSuccess(result) &&
							result.success.request !== null &&
							deliveryFailure !== null
								? Result.fail(attribute(deliveryFailure, target, hostFromUrl(target.url)))
								: Result.map(result, (ok) => ok.success),
					}),
				)
				yield* Effect.annotateCurrentSpan({
					"maple.scraper.sub_targets": targets.length,
					"maple.scraper.failed_sub_targets": scrapes.filter((scrape) =>
						Result.isFailure(scrape.result),
					).length,
					"maple.scraper.merged_resources": requests.length,
				})
				return { scrapes, deliveryFailure } satisfies ScrapeCycle
			}).pipe(
				// `root`: loops are forked inside `scraper.reconcile` and would otherwise
				// parent every cycle, for hours, under that one trace.
				Effect.withSpan("scraper.scrape_cycle", {
					root: true,
					attributes: {
						orgId: first.orgId,
						"maple.scraper.target_id": first.id,
						"maple.scraper.interval_seconds": first.scrapeIntervalSeconds,
						...(first.sourceId === undefined ? undefined : { "maple.source.id": first.sourceId }),
					},
				}),
			)
		}

		return { scrapeCycle } satisfies ScraperApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
