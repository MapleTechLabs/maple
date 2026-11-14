import type {
	CloudflareIntegrationStatus,
	RailwayIntegrationStatus,
	SupabaseIntegrationStatus,
} from "@maple/domain/http"
import type { V2GcpIntegration, V2PlanetScaleIntegration } from "@maple/domain/http/v2"
import { Clock, Context, Effect, Layer, Option, Ref, SynchronizedRef } from "effect"
import { MapleApiV2Client, MapleInternalApiClient } from "../platform/api-clients"

/**
 * The integration statuses the sidebar mounts and the infra integration pages read:
 * one request per status, shared while in flight and kept after for a minute, or until a reader
 * asks for a refresh (a write's `reactivityKeys`, an empty-page poll).
 */

export type PlanetscaleStatus = V2PlanetScaleIntegration
export type GcpStatus = V2GcpIntegration

export interface LoadOptions {
	readonly refresh?: boolean
	/** The org the answer is for; without it, the org the root opened last (`scopeTo`). */
	readonly orgId?: string
}

type Loader<A, E> = (options?: LoadOptions) => Effect.Effect<A, E>
type Held<A, E> = Readonly<{ orgId: string | null; startedAtMs: number; shared: Effect.Effect<A, E> }>

/**
 * How long a held answer is served. Pages judge a status by its timestamps against the current
 * time ("stalled" after 30 minutes without a read), so an answer from an hour ago reads as broken.
 */
export const STATUS_MAX_AGE_MS = 60_000
type Internal = MapleInternalApiClient["Service"]["integrations"]
type V2 = MapleApiV2Client["Service"]
type ErrorOf<F extends () => Effect.Effect<unknown, unknown>> = Effect.Error<ReturnType<F>>

/**
 * One shared load per status and org: another org's answer is never served, nor one older than
 * `STATUS_MAX_AGE_MS`. A failure is not kept: the next reader asks again.
 */
export const sharedLoader = <A, E>(load: Effect.Effect<A, E>): Effect.Effect<Loader<A, E>> =>
	Effect.map(SynchronizedRef.make(Option.none<Held<A, E>>()), (ref) => {
		const forget = (failed: Effect.Effect<A, E>) =>
			SynchronizedRef.update(ref, (held) =>
				Option.isSome(held) && held.value.shared === failed ? Option.none() : held,
			)
		const start = (orgId: string | null, startedAtMs: number) =>
			Effect.map(Effect.cached(load), (memo): Held<A, E> => {
				const shared: Effect.Effect<A, E> = Effect.tapError(memo, () => forget(shared))
				return { orgId, startedAtMs, shared }
			})
		return (options) => {
			const orgId = options?.orgId ?? null
			return Effect.flatten(
				SynchronizedRef.modifyEffect(ref, (current) =>
					Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
						Option.isSome(current) &&
						current.value.orgId === orgId &&
						nowMs - current.value.startedAtMs < STATUS_MAX_AGE_MS &&
						options?.refresh !== true
							? Effect.succeed([current.value.shared, current] as const)
							: Effect.map(
									start(orgId, nowMs),
									(next) => [next.shared, Option.some(next)] as const,
								),
					),
				),
			)
		}
	})

export class IntegrationStatuses extends Context.Service<
	IntegrationStatuses,
	{
		readonly cloudflare: Loader<CloudflareIntegrationStatus, ErrorOf<Internal["cloudflareStatus"]>>
		readonly railway: Loader<RailwayIntegrationStatus, ErrorOf<Internal["railwayStatus"]>>
		readonly planetscale: Loader<PlanetscaleStatus, ErrorOf<V2["planetscaleIntegration"]["status"]>>
		readonly gcp: Loader<GcpStatus, ErrorOf<V2["gcpIntegration"]["status"]>>
		readonly supabase: Loader<SupabaseIntegrationStatus, ErrorOf<Internal["supabaseStatus"]>>
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
				<A, E>(loader: Loader<A, E>): Loader<A, E> =>
				(options) =>
					Effect.flatMap(Ref.get(openOrg), (org) =>
						loader({ ...options, orgId: options?.orgId ?? Option.getOrUndefined(org) }),
					)
			const cloudflare = yield* sharedLoader(internal.integrations.cloudflareStatus())
			const railway = yield* sharedLoader(internal.integrations.railwayStatus())
			const planetscale = yield* sharedLoader(v2.planetscaleIntegration.status())
			const gcp = yield* sharedLoader(v2.gcpIntegration.status())
			const supabase = yield* sharedLoader(internal.integrations.supabaseStatus())
			return {
				cloudflare: inOrg(cloudflare),
				railway: inOrg(railway),
				planetscale: inOrg(planetscale),
				gcp: inOrg(gcp),
				supabase: inOrg(supabase),
				scopeTo: (orgId: string) => Ref.set(openOrg, Option.some(orgId)),
			}
		}),
	)
}
