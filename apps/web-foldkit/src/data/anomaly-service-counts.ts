import type { V2AnomalyServiceCount } from "@maple/domain/http/v2"
import { Context, Effect, Layer, Option, SynchronizedRef } from "effect"
import { MapleApiV2Client } from "../platform/api-clients"

/**
 * `openAnomalyServiceCountsAtom`, which the Overview and the services list both read. apps/web's
 * retained atom answers the second page without a request; this does the same: one request,
 * shared while in flight and kept after, until a reader asks for a refresh (a Reload).
 */
export class AnomalyServiceCounts extends Context.Service<
	AnomalyServiceCounts,
	{
		readonly load: (options?: {
			readonly refresh?: boolean
		}) => Effect.Effect<ReadonlyArray<V2AnomalyServiceCount>, unknown>
	}
>()("@maple/web-foldkit/AnomalyServiceCounts") {
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const request = Effect.map(
				client.anomalies.serviceCounts({ query: { status: "open" } }),
				(response) => response.data,
			)
			const ref = yield* SynchronizedRef.make(
				Option.none<Effect.Effect<ReadonlyArray<V2AnomalyServiceCount>, unknown>>(),
			)
			const load = (options?: { readonly refresh?: boolean }) =>
				Effect.flatten(
					SynchronizedRef.modifyEffect(ref, (current) =>
						Option.isSome(current) && options?.refresh !== true
							? Effect.succeed([current.value, current] as const)
							: Effect.map(Effect.cached(request), (next) => [next, Option.some(next)] as const),
					),
				)
			return { load }
		}),
	)
}
