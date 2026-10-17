import { getServicesFacets, type ServicesFacetsResponse } from "@maple/web-data/warehouse/services"
import { WarehouseExecutor } from "@maple/web-data/warehouse/warehouse-services"
import { Context, Effect, Layer, SynchronizedRef } from "effect"
import type { TimeWindow } from "./time-range"

/**
 * The snapped 24 h services facets probe that the Overview page and the shell's namespace list both
 * read. apps/web's atom cache answers the second reader without a request; this does the same: one
 * request per window, shared while in flight and kept after, until a reader asks for a refresh.
 */
export class ServicesFacetsProbe extends Context.Service<
	ServicesFacetsProbe,
	{
		readonly load: (
			window: TimeWindow,
			options?: { readonly refresh?: boolean },
		) => Effect.Effect<ServicesFacetsResponse, unknown>
	}
>()("@maple/web-foldkit/ServicesFacetsProbe") {
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const context = yield* Effect.context<WarehouseExecutor>()
			const entries = yield* SynchronizedRef.make(
				new Map<string, Effect.Effect<ServicesFacetsResponse, unknown>>(),
			)
			const load = (window: TimeWindow, options?: { readonly refresh?: boolean }) =>
				Effect.flatten(
					SynchronizedRef.modifyEffect(entries, (map) => {
						const key = `${window.startTime}|${window.endTime}`
						const existing = map.get(key)
						if (existing !== undefined && options?.refresh !== true)
							return Effect.succeed([existing, map] as const)
						return Effect.map(
							Effect.cached(Effect.provide(getServicesFacets({ data: window }), context)),
							(cached) => [cached, new Map(map).set(key, cached)] as const,
						)
					}),
				)
			return { load }
		}),
	)
}
