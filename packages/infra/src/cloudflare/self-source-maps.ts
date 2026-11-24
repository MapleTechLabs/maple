// The dashboard's own source maps, uploaded into Maple's org after each prd build of `web`.
import * as Maple from "@maple-dev/alchemy"
import { Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { commitSha } from "../env.ts"
import { resolveAs } from "../secret-guard.ts"
import { MapleSourceMapsApiKey } from "../secrets.ts"

/** The deploy's read of the upload key: absent outside prd, where nothing uploads. */
export const webSourceMapsApiKey = MapleSourceMapsApiKey.optionalValue

/**
 * Maple's providers on the upload key. Without one the key is empty and no `Maple.*` resource is
 * declared, so the client is never called.
 */
export const selfMapleProviders = Maple.providersWithDependencies().pipe(
	Layer.provide(FetchHttpClient.layer),
	Layer.provide(
		Layer.effect(
			Maple.MapleEnvironment,
			Effect.map(resolveAs("web", webSourceMapsApiKey), (key) => ({
				baseUrl: Maple.DEFAULT_BASE_URL,
				apiKey: Option.getOrElse(key, () => Redacted.make("")),
			})),
		).pipe(Layer.orDie),
	),
)

/**
 * Uploads web's maps from `dir` under the service and release its browser telemetry reports
 * (`service.version` is `VITE_COMMIT_SHA`, resolved here as `web`'s env resolves it). A no-op
 * without the key.
 */
export const uploadWebSourceMaps = (input: {
	readonly dir: string
	readonly service: string
	readonly after: unknown
}) =>
	Effect.gen(function* () {
		const key = yield* resolveAs("web", webSourceMapsApiKey)
		if (Option.isNone(key)) return
		const release = yield* commitSha("VITE_COMMIT_SHA")
		yield* Maple.SourceMaps("web-sourcemaps", {
			dir: input.dir,
			service: input.service,
			...(release === "" ? undefined : { release }),
			after: input.after,
		})
	})
