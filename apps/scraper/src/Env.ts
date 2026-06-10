import { Config, Context, Effect, Layer, type Redacted } from "effect"

export interface ScraperEnvShape {
	/** Base URL of the Maple API, e.g. `https://api.maple.dev`. */
	readonly MAPLE_API_URL: string
	/** Shared internal bearer for the `/api/internal/*` scraper endpoints. */
	readonly SD_INTERNAL_TOKEN: Redacted.Redacted<string>
	readonly TINYBIRD_HOST: string
	readonly TINYBIRD_TOKEN: Redacted.Redacted<string>
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
	TINYBIRD_HOST: Config.string("TINYBIRD_HOST"),
	TINYBIRD_TOKEN: Config.redacted("TINYBIRD_TOKEN"),
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
		TINYBIRD_HOST: env.TINYBIRD_HOST.replace(/\/$/, ""),
	})),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
