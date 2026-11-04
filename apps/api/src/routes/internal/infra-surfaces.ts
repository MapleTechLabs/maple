import { InfraSurfacesResponse, type InfraSurfaceLiteral } from "@maple/domain/http"
import { Effect } from "effect"

export interface InfraSurfaceLookups<R> {
	readonly surfaces: Effect.Effect<ReadonlyArray<InfraSurfaceLiteral>, unknown, R>
	readonly cloudflare: Effect.Effect<boolean, unknown, R>
	readonly railway: Effect.Effect<boolean, unknown, R>
	readonly vercel: Effect.Effect<boolean, unknown, R>
	readonly planetscale: Effect.Effect<boolean, unknown, R>
	readonly gcp: Effect.Effect<boolean, unknown, R>
	readonly supabase: Effect.Effect<boolean, unknown, R>
	readonly aws: Effect.Effect<boolean, unknown, R>
}

/** A failed lookup answers `null` instead of failing the response. */
const settle = <A, E, R>(name: string, lookup: Effect.Effect<A, E, R>) =>
	lookup.pipe(
		Effect.tapError((error) => Effect.logWarning(`Infra surfaces: ${name} lookup failed`, error)),
		Effect.orElseSucceed(() => null),
	)

/** Every lookup runs at once; each answers on its own. */
export const settleInfraSurfaces = <R>(lookups: InfraSurfaceLookups<R>) =>
	Effect.all(
		{
			surfaces: settle("presence", lookups.surfaces),
			cloudflare: settle("cloudflare", lookups.cloudflare),
			railway: settle("railway", lookups.railway),
			vercel: settle("vercel", lookups.vercel),
			planetscale: settle("planetscale", lookups.planetscale),
			gcp: settle("gcp", lookups.gcp),
			supabase: settle("supabase", lookups.supabase),
			aws: settle("aws", lookups.aws),
		},
		{ concurrency: "unbounded" },
	).pipe(
		Effect.map(({ surfaces, ...integrations }) => new InfraSurfacesResponse({ surfaces, integrations })),
	)
