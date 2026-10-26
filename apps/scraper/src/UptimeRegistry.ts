import { Clock, Context, Effect, Layer, Option, Ref } from "effect"
import type { UptimeProbeTarget } from "@maple/domain/uptime"
import { ApiClient, type ApiRequestError } from "./ApiClient"

export interface UptimeRegistryApi {
	/** Fetch the monitor list and make it current. A failure leaves the current list in place. */
	readonly refresh: Effect.Effect<ReadonlyMap<string, UptimeProbeTarget>, ApiRequestError>
	/** The latest config for a monitor, or `none` once it is gone (deleted, paused, disabled). */
	readonly get: (id: string) => Effect.Effect<Option.Option<UptimeProbeTarget>>
	/** Epoch ms of the last successful refresh. */
	readonly lastRefreshAt: Effect.Effect<number | null>
}

/** The desired monitors. Loops read their config here every check, so edits apply without a restart. */
export class UptimeRegistry extends Context.Service<UptimeRegistry, UptimeRegistryApi>()(
	"@maple/scraper/UptimeRegistry",
	{
		make: Effect.gen(function* () {
			const api = yield* ApiClient
			const monitors = yield* Ref.make<ReadonlyMap<string, UptimeProbeTarget>>(new Map())
			const lastRefreshAt = yield* Ref.make<number | null>(null)

			const refresh = Effect.gen(function* () {
				const list = yield* api.listUptimeTargets()
				const byId = new Map(list.map((target): [string, UptimeProbeTarget] => [target.id, target]))
				yield* Ref.set(monitors, byId)
				yield* Ref.set(lastRefreshAt, yield* Clock.currentTimeMillis)
				return byId
			})

			const get = (id: string) =>
				Effect.map(Ref.get(monitors), (current) => Option.fromNullishOr(current.get(id)))

			return { refresh, get, lastRefreshAt: Ref.get(lastRefreshAt) } satisfies UptimeRegistryApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
