import { V2SourceMap } from "@maple/domain/http/v2"
import { Array as Arr, Effect, Schema } from "effect"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { MapleApiV2Client } from "../../platform/api-clients"

// The source map reads the pages show, as Effects their Commands wrap.

/** Maps read per service: enough to count the newest release's files. */
export const SERVICE_SOURCE_MAPS_LIMIT = 100

/** One page of a service's maps, newest first, and whether the list goes on past it. */
export const ServiceSourceMaps = Schema.Struct({
	maps: Schema.Array(V2SourceMap),
	hasMore: Schema.Boolean,
})
export type ServiceSourceMaps = typeof ServiceSourceMaps.Type

/** `sourceMaps.list` for one service, newest first. */
export const listServiceSourceMaps = (serviceName: string) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const response = yield* client.sourceMaps.list({
			query: { service: serviceName, limit: SERVICE_SOURCE_MAPS_LIMIT },
		})
		return { maps: response.data, hasMore: response.has_more } satisfies ServiceSourceMaps
	}).pipe(Effect.mapError(toLoadFailure))

/**
 * The newest upload's release and its maps. Maps without a release cannot be told apart by build,
 * so an unversioned release is the newest map alone.
 */
export const latestRelease = (
	maps: ReadonlyArray<V2SourceMap>,
): { readonly version: string | null; readonly maps: ReadonlyArray<V2SourceMap> } | null => {
	const [newest] = maps
	if (newest === undefined) return null
	if (newest.version === null) return { version: null, maps: [newest] }
	return { version: newest.version, maps: Arr.filter(maps, (map) => map.version === newest.version) }
}
