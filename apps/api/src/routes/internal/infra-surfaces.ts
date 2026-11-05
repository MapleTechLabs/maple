import { InfraSurfacesResponse, type InfraSurfaceLiteral } from "@maple/domain/http"
import { Effect } from "effect"

/** What each lookup answers when it succeeds. */
interface InfraSurfaceValues {
	readonly surfaces: ReadonlyArray<InfraSurfaceLiteral>
	readonly cloudflare: boolean
	readonly railway: boolean
	readonly planetscale: boolean
	readonly gcp: boolean
	readonly supabase: boolean
	readonly aws: boolean
}

/** One provided lookup per surface, each with its own error type (`Errors[K]`), logged and dropped. */
export type InfraSurfaceLookups<Errors extends Record<keyof InfraSurfaceValues, unknown>> = {
	readonly [K in keyof Errors]: Effect.Effect<InfraSurfaceValues[K & keyof InfraSurfaceValues], Errors[K]>
}

/** A failed lookup answers `null` instead of failing the response. */
const settle = <A, E, R>(name: string, lookup: Effect.Effect<A, E, R>) =>
	lookup.pipe(
		Effect.tapError((error) => Effect.logWarning(`Infra surfaces: ${name} lookup failed`, error)),
		Effect.orElseSucceed(() => null),
	)

/** Every lookup runs at once; each answers on its own. */
export const settleInfraSurfaces = <Errors extends Record<keyof InfraSurfaceValues, unknown>>(
	lookups: InfraSurfaceLookups<Errors>,
) =>
	Effect.all(
		{
			surfaces: settle("presence", lookups.surfaces),
			cloudflare: settle("cloudflare", lookups.cloudflare),
			railway: settle("railway", lookups.railway),
			planetscale: settle("planetscale", lookups.planetscale),
			gcp: settle("gcp", lookups.gcp),
			supabase: settle("supabase", lookups.supabase),
			aws: settle("aws", lookups.aws),
		},
		{ concurrency: "unbounded" },
	).pipe(
		Effect.map(({ surfaces, ...integrations }) => new InfraSurfacesResponse({ surfaces, integrations })),
	)
