import { Config, Context, Effect, Layer, type Redacted } from "effect"

export interface ScraperEnvShape {
	/** Base URL of the Maple API, e.g. `https://api.maple.dev`. */
	readonly MAPLE_API_URL: string
	/** Shared internal bearer for the `/api/internal/*` scraper endpoints. */
	readonly SD_INTERNAL_TOKEN: Redacted.Redacted<string>
	/**
	 * Base URL of the Maple ingest gateway, e.g. `https://ingest.maple.dev`.
	 * Scraped metrics are sent here as OTLP/JSON with each org's public
	 * ingest key so they get billed and warehouse-routed per org.
	 */
	readonly MAPLE_INGEST_URL: string
	/** Max concurrent scrapes across all targets. */
	readonly SCRAPER_CONCURRENCY: number
	/** How often the target list is refreshed, in seconds. */
	readonly SCRAPER_RECONCILE_INTERVAL_SECONDS: number
	/** Port for the `/health` endpoint. */
	readonly PORT: number
}

const envConfig = Config.all({
	MAPLE_API_URL: Config.string("MAPLE_API_URL"),
	SD_INTERNAL_TOKEN: Config.redacted("SD_INTERNAL_TOKEN"),
	MAPLE_INGEST_URL: Config.string("MAPLE_INGEST_URL"),
	SCRAPER_CONCURRENCY: Config.number("SCRAPER_CONCURRENCY").pipe(Config.withDefault(10)),
	SCRAPER_RECONCILE_INTERVAL_SECONDS: Config.number("SCRAPER_RECONCILE_INTERVAL_SECONDS").pipe(
		Config.withDefault(60),
	),
	PORT: Config.number("PORT").pipe(Config.withDefault(3475)),
})

export class ScraperEnv extends Context.Service<ScraperEnv, ScraperEnvShape>()("@maple/scraper/Env", {
	make: Effect.map(envConfig, (env) => ({
		...env,
		MAPLE_API_URL: env.MAPLE_API_URL.replace(/\/$/, ""),
		MAPLE_INGEST_URL: env.MAPLE_INGEST_URL.replace(/\/$/, ""),
	})),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
