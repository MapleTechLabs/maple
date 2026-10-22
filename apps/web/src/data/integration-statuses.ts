import type {
	CloudflareIntegrationStatus,
	RailwayIntegrationStatus,
	SupabaseIntegrationStatus,
} from "@maple/domain/http"
import type { V2GcpIntegration, V2PlanetScaleIntegration } from "@maple/domain/http/v2"
import { Context, Effect, Layer, Option, Ref, SynchronizedRef } from "effect"
import { MapleApiV2Client, MapleInternalApiClient } from "../platform/api-clients"

/**
 * The integration statuses the sidebar mounts and the infra integration pages read:
 * one request per status, shared while in flight
 * and kept after, until a reader asks for a refresh (a write's `reactivityKeys`, an empty-page poll).
 */

export type PlanetscaleStatus = V2PlanetScaleIntegration
export type GcpStatus = V2GcpIntegration

export interface LoadOptions {
	readonly refresh?: boolean
	/** The org the answer is for; without it, the org the root opened last (`scopeTo`). */
	readonly orgId?: string
}

type Loader<A> = (options?: LoadOptions) => Effect.Effect<A, unknown>
type Held<A> = Readonly<{ orgId: string | null; shared: Effect.Effect<A, unknown> }>

/**
 * One shared load per status and org: another org's
 * answer is never served. A failure is not kept: the next reader asks again.
 */
export const sharedLoader = <A>(load: Effect.Effect<A, unknown>): Effect.Effect<Loader<A>> =>
	Effect.map(SynchronizedRef.make(Option.none<Held<A>>()), (ref) => {
		const forget = (failed: Effect.Effect<A, unknown>) =>
			SynchronizedRef.update(ref, (held) =>
				Option.isSome(held) && held.value.shared === failed ? Option.none() : held,
			)
		const start = (orgId: string | null) =>
			Effect.map(Effect.cached(load), (memo): Held<A> => {
				const shared: Effect.Effect<A, unknown> = Effect.tapError(memo, () => forget(shared))
				return { orgId, shared }
			})
		return (options) => {
			const orgId = options?.orgId ?? null
			return Effect.flatten(
				SynchronizedRef.modifyEffect(ref, (current) =>
					Option.isSome(current) && current.value.orgId === orgId && options?.refresh !== true
						? Effect.succeed([current.value.shared, current] as const)
						: Effect.map(start(orgId), (next) => [next.shared, Option.some(next)] as const),
				),
			)
		}
	})

export class IntegrationStatuses extends Context.Service<
	IntegrationStatuses,
	{
		readonly cloudflare: Loader<CloudflareIntegrationStatus>
		readonly railway: Loader<RailwayIntegrationStatus>
		readonly planetscale: Loader<PlanetscaleStatus>
		readonly gcp: Loader<GcpStatus>
		readonly supabase: Loader<SupabaseIntegrationStatus>
		/** The open org: readers that do not name one read under it. */
		readonly scopeTo: (orgId: string) => Effect.Effect<void>
	}
>()("@maple/web/IntegrationStatuses") {
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const internal = yield* MapleInternalApiClient
			const v2 = yield* MapleApiV2Client
			const openOrg = yield* Ref.make(Option.none<string>())
			const inOrg =
				<A>(loader: Loader<A>): Loader<A> =>
				(options) =>
					Effect.flatMap(Ref.get(openOrg), (org) =>
						loader({ ...options, orgId: options?.orgId ?? Option.getOrUndefined(org) }),
					)
			return {
				cloudflare: inOrg(yield* sharedLoader(internal.integrations.cloudflareStatus())),
				railway: inOrg(yield* sharedLoader(internal.integrations.railwayStatus())),
				planetscale: inOrg(
					yield* sharedLoader<PlanetscaleStatus>(v2.planetscaleIntegration.status()),
				),
				gcp: inOrg(yield* sharedLoader<GcpStatus>(v2.gcpIntegration.status())),
				supabase: inOrg(yield* sharedLoader(internal.integrations.supabaseStatus())),
				scopeTo: (orgId: string) => Ref.set(openOrg, Option.some(orgId)),
			}
		}),
	)
}
