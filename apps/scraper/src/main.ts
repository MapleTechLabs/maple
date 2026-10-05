#!/usr/bin/env bun
/**
 * The Maple Prometheus scraper: polls the Maple API for enabled scrape targets,
 * runs one loop per target at its interval (5-300s), fetches exposition text
 * directly with SSRF protection, converts it to OTLP for the ingest gateway, and
 * reports outcomes back to the API. `/health` answers 503 once the target list
 * has gone stale.
 */
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Maple } from "@maple-dev/effect-sdk/server"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpRouter, HttpServerResponse } from "effect/http"
import { ApiClient } from "./ApiClient"
import { ScraperEnv } from "./Env"
import { OtlpIngest } from "./OtlpIngest"
import { ResultReporter } from "./ResultReporter"
import { ScrapeScheduler } from "./ScrapeScheduler"
import { Scraper } from "./Scraper"
import { TargetFetcher } from "./TargetFetcher"
import { TargetRegistry } from "./TargetRegistry"

const TelemetryLayer = Maple.layer({
	serviceName: "scraper",
	serviceNamespace: "core",
	repositoryUrl: "https://github.com/MapleTechLabs/maple",
	shutdownTimeout: "3 seconds",
})

const SchedulerLayer = ScrapeScheduler.layer.pipe(
	Layer.provide(Layer.mergeAll(TargetRegistry.layer, ResultReporter.layer, Scraper.layer)),
	Layer.provide(Layer.mergeAll(ApiClient.layer, OtlpIngest.layer, TargetFetcher.layer)),
	Layer.provideMerge(ScraperEnv.layer),
	Layer.provide(FetchHttpClient.layer),
)

const HealthRoutes = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const scheduler = yield* ScrapeScheduler
		yield* router.add(
			"GET",
			"/health",
			Effect.flatMap(scheduler.stats, (stats) =>
				HttpServerResponse.json(stats, { status: stats.status === "ok" ? 200 : 503 }),
			),
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

const MainLayer = HealthServer.pipe(Layer.provideMerge(SchedulerLayer))

const program = Effect.gen(function* () {
	const scheduler = yield* ScrapeScheduler
	yield* Effect.logInfo("Maple Prometheus scraper starting")
	return yield* scheduler.run
})

// Telemetry intentionally owns the outer scope so its exporter flushes after MainLayer closes.
/* oxlint-disable effecttsgo/multiple-effect-provide */
/* oxlint-disable effecttsgo/strict-effect-provide */
program.pipe(Effect.provide(MainLayer), Effect.provide(TelemetryLayer), BunRuntime.runMain)
/* oxlint-enable effecttsgo/strict-effect-provide */
/* oxlint-enable effecttsgo/multiple-effect-provide */
