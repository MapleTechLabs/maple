#!/usr/bin/env bun
/**
 * The Maple scraper: polls the Maple API for enabled scrape targets and uptime
 * monitors. Scrape targets run one loop per target at its interval (5-300s),
 * fetch exposition text with SSRF protection and send it to ingest as OTLP.
 * Uptime monitors run one HTTP, TCP or DNS check per interval, export a span per
 * check into the org's traces, and report each outcome to the API. `/health`
 * answers 503 once either list has gone stale.
 */
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpRouter, HttpServerResponse } from "effect/http"
import { ApiClient } from "./ApiClient"
import { ScraperEnv } from "./Env"
import { OtlpIngest } from "./OtlpIngest"
import { ResultReporter, UptimeReporter } from "./ResultReporter"
import { ScrapeScheduler } from "./ScrapeScheduler"
import { Scraper } from "./Scraper"
import { TargetFetcher } from "./TargetFetcher"
import { TargetRegistry } from "./TargetRegistry"
import { telemetryLayer } from "./Telemetry"
import { UptimeDnsProbe } from "./UptimeDnsProbe"
import { UptimeHttpProbe } from "./UptimeHttpProbe"
import { UptimeProber } from "./UptimeProber"
import { UptimeRegistry } from "./UptimeRegistry"
import { UptimeScheduler } from "./UptimeScheduler"
import { UptimeSpanExporter } from "./UptimeSpanExporter"
import { UptimeTcpProbe } from "./UptimeTcpProbe"

const TelemetryLive = telemetryLayer()

const ScrapeLive = ScrapeScheduler.layer.pipe(
	Layer.provide(Layer.mergeAll(TargetRegistry.layer, ResultReporter.layer, Scraper.layer)),
	Layer.provide(Layer.mergeAll(OtlpIngest.layer, TargetFetcher.layer)),
)

const UptimeLive = UptimeScheduler.layer.pipe(
	Layer.provide(Layer.mergeAll(UptimeRegistry.layer, UptimeReporter.layer, UptimeProber.layer)),
	Layer.provide(
		Layer.mergeAll(
			UptimeHttpProbe.layer,
			UptimeTcpProbe.layer,
			UptimeDnsProbe.layer,
			UptimeSpanExporter.layer,
		),
	),
)

const SchedulerLive = Layer.mergeAll(ScrapeLive, UptimeLive).pipe(
	Layer.provide(ApiClient.layer),
	Layer.provideMerge(ScraperEnv.layer),
	Layer.provide(FetchHttpClient.layer),
)

const HealthRoutes = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const scrapes = yield* ScrapeScheduler
		const uptime = yield* UptimeScheduler
		yield* router.add(
			"GET",
			"/health",
			Effect.gen(function* () {
				const scrapeStats = yield* scrapes.stats
				const uptimeStats = yield* uptime.stats
				const status = scrapeStats.status === "ok" && uptimeStats.status === "ok" ? "ok" : "degraded"
				return yield* HttpServerResponse.json(
					{ ...scrapeStats, status, uptime: uptimeStats },
					{ status: status === "ok" ? 200 : 503 },
				)
			}),
		)
	}),
)

const HealthServer = HttpRouter.serve(HealthRoutes, { disableLogger: true }).pipe(
	Layer.provide(
		Layer.unwrap(
			Effect.gen(function* () {
				const env = yield* ScraperEnv
				return BunHttpServer.layer({ port: env.PORT, hostname: "0.0.0.0" })
			}),
		),
	),
)

const MainLive = HealthServer.pipe(Layer.provideMerge(SchedulerLive))

const program = Effect.gen(function* () {
	const scrapes = yield* ScrapeScheduler
	const uptime = yield* UptimeScheduler
	yield* Effect.logInfo("Maple scraper starting")
	// Both run forever; a defect in either ends the process instead of hiding behind the other.
	return yield* Effect.all([scrapes.run, uptime.run], { concurrency: 2, discard: true })
})

// Telemetry intentionally owns the outer scope so its exporter flushes after MainLive closes.
/* oxlint-disable effecttsgo/multiple-effect-provide */
/* oxlint-disable effecttsgo/strict-effect-provide */
program.pipe(Effect.provide(MainLive), Effect.provide(TelemetryLive), BunRuntime.runMain)
/* oxlint-enable effecttsgo/strict-effect-provide */
/* oxlint-enable effecttsgo/multiple-effect-provide */
