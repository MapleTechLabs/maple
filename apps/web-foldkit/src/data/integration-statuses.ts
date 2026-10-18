import type { CloudflareIntegrationStatus, RailwayIntegrationStatus } from "@maple/domain/http"
import type { V2GcpIntegration, V2PlanetScaleIntegration } from "@maple/domain/http/v2"
import { Context, Effect, Layer, Option, SynchronizedRef } from "effect"
import { MapleApiV2Client, MapleInternalApiClient } from "../platform/api-clients"

/**
 * The four integration statuses the sidebar mounts and the infra integration pages read. apps/web
 * shares one atom per status between them; this does the same: one request, shared while in flight
 * and kept after, until a reader asks for a refresh (a write's `reactivityKeys`, an empty-page poll).
 */

export type PlanetscaleStatus = V2PlanetScaleIntegration
export type GcpStatus = V2GcpIntegration

export interface LoadOptions {
	readonly refresh?: boolean
}

type Loader<A> = (options?: LoadOptions) => Effect.Effect<A, unknown>

/** One shared load per status. A failure is not kept: the next reader asks again, like the atom. */
export const sharedLoader = <A>(load: Effect.Effect<A, unknown>): Effect.Effect<Loader<A>> =>
	Effect.map(SynchronizedRef.make(Option.none<Effect.Effect<A, unknown>>()), (ref) => {
		const forget = (failed: Effect.Effect<A, unknown>) =>
			SynchronizedRef.update(ref, (held) => (Option.isSome(held) && held.value === failed ? Option.none() : held))
		const start = Effect.map(Effect.cached(load), (memo) => {
			const shared: Effect.Effect<A, unknown> = Effect.tapError(memo, () => forget(shared))
			return shared
		})
		return (options) =>
			Effect.flatten(
				SynchronizedRef.modifyEffect(ref, (current) =>
					Option.isSome(current) && options?.refresh !== true
						? Effect.succeed([current.value, current] as const)
						: Effect.map(start, (next) => [next, Option.some(next)] as const),
				),
			)
	})

export class IntegrationStatuses extends Context.Service<
	IntegrationStatuses,
	{
		readonly cloudflare: Loader<CloudflareIntegrationStatus>
		readonly railway: Loader<RailwayIntegrationStatus>
		readonly planetscale: Loader<PlanetscaleStatus>
		readonly gcp: Loader<GcpStatus>
	}
>()("@maple/web-foldkit/IntegrationStatuses") {
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const internal = yield* MapleInternalApiClient
			const v2 = yield* MapleApiV2Client
			return {
				cloudflare: yield* sharedLoader(internal.integrations.cloudflareStatus()),
				railway: yield* sharedLoader(internal.integrations.railwayStatus()),
				planetscale: yield* sharedLoader<PlanetscaleStatus>(v2.planetscaleIntegration.status()),
				gcp: yield* sharedLoader<GcpStatus>(v2.gcpIntegration.status()),
			}
		}),
	)
}
