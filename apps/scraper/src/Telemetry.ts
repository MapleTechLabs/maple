import { MapleFlush, type MapleFlushableConfig } from "@maple-dev/effect-sdk/server"
import { Duration, Effect, Layer } from "effect"

const REPOSITORY_URL = "https://github.com/MapleTechLabs/maple"
const SHUTDOWN_TIMEOUT = Duration.seconds(3)

/**
 * The scraper's own telemetry on the buffered server preset. Unlike `Maple.layer`
 * (Effect's OTLP tracer), it exports a raw 4xx client span such as a 402 from ingest
 * without an `exception` event, so a status the scraper handles opens no issue.
 * Ingest key, endpoint and commit come from env; without a key it does not export.
 */
export const telemetryLayer = (overrides: Partial<MapleFlushableConfig> = {}): Layer.Layer<never> =>
	Layer.unwrap(
		Effect.acquireRelease(
			Effect.sync(() =>
				MapleFlush.make({
					serviceName: "scraper",
					serviceNamespace: "core",
					attributes: { "vcs.repository.url.full": REPOSITORY_URL },
					...overrides,
				}),
			),
			// Final flush once everything provided inside this layer has shut down, bounded
			// because the flush fetch has no timeout of its own.
			(telemetry) =>
				Effect.promise(telemetry.dispose).pipe(Effect.timeout(SHUTDOWN_TIMEOUT), Effect.ignore),
		).pipe(Effect.map((telemetry) => telemetry.layer)),
	)
