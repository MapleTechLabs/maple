import { Cause, Clock, Context, Effect, Layer, Result } from "effect"
import type { InternalScrapeTarget } from "@maple/domain/http"
import {
	convertFamiliesToOtlp,
	countSamples,
	parsePrometheusText,
	type ScrapeOtlpContext,
} from "@maple/prometheus-otlp"
import { OtlpIngest } from "./OtlpIngest"
import { ScrapeError, scrapeError, withScrapeSpan } from "./ScrapeError"
import { TargetFetcher } from "./TargetFetcher"

export interface ScrapeSuccess {
	/** Prometheus samples parsed from the exposition. */
	readonly samplesScraped: number
	/** OTLP data points exported after conversion drops. */
	readonly samplesExported: number
}

export interface ScraperApi {
	/** Fetch, parse, convert and deliver one target's metrics as one root span. */
	readonly scrape: (target: InternalScrapeTarget) => Effect.Effect<ScrapeSuccess, ScrapeError>
}

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

export class Scraper extends Context.Service<Scraper, ScraperApi>()("@maple/scraper/Scraper", {
	make: Effect.gen(function* () {
		const fetcher = yield* TargetFetcher
		const ingest = yield* OtlpIngest

		const scrape = (target: InternalScrapeTarget) => {
			const host = hostFromUrl(target.url)
			return Effect.gen(function* () {
				const scrapeTimeMs = yield* Clock.currentTimeMillis
				const body = yield* fetcher.fetch(target)
				const parsed = parsePrometheusText(body)
				const converted = convertFamiliesToOtlp(parsed.families, otlpContext(target, scrapeTimeMs))
				if (converted.request !== null) yield* ingest.send(target.ingestKey, converted.request)

				const counts = converted.dataPointCounts
				yield* Effect.annotateCurrentSpan({
					"maple.scraper.sum_data_points": counts.sum,
					"maple.scraper.gauge_data_points": counts.gauge,
					"maple.scraper.histogram_data_points": counts.histogram,
					"maple.scraper.dropped_series": converted.droppedSeriesCount,
					"maple.scraper.skipped_lines": parsed.skippedLineCount,
				})
				return {
					samplesScraped: countSamples(parsed.families),
					samplesExported: counts.sum + counts.gauge + counts.histogram,
				} satisfies ScrapeSuccess
			}).pipe(
				Effect.catchDefect((defect) =>
					Effect.fail(
						scrapeError({ message: Cause.pretty(Cause.die(defect)), reason: "scrape_failed" }),
					),
				),
				Effect.mapError((error) => attribute(error, target, host)),
				// `root`: loops are forked inside `scraper.reconcile` and would otherwise
				// parent every scrape, for hours, under that one trace.
				withScrapeSpan("scraper.scrape_target", {
					root: true,
					attributes: {
						orgId: target.orgId,
						"maple.scraper.target_id": target.id,
						"maple.scraper.target_name": target.name,
						"maple.scraper.target_host": host,
						"maple.scraper.interval_seconds": target.scrapeIntervalSeconds,
						...(target.subTargetKey
							? { "maple.scraper.sub_target_key": target.subTargetKey }
							: undefined),
					},
				}),
			)
		}

		return { scrape } satisfies ScraperApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
