/**
 * PlanetScale as a cost provider: an organization's monthly invoices per database and branch,
 * spread over the days each branch existed, read with the service token the org saved.
 */
import { Context, Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import type { CostProviderAdapter, CostPull, CostPullSource, CostPullWindow } from "../../CostProvider"
import { CostConnectionStore, type CostConnectionStoreError } from "../../CostConnectionStore"
import { planetScaleCostFailure, pullInvoiceCost } from "./pull"

const toStoreFailure = (error: CostConnectionStoreError) =>
	error.reason === "secret"
		? planetScaleCostFailure("auth", error.message)
		: planetScaleCostFailure("upstream", "PlanetScale connection database error")

export class PlanetScaleCostProvider extends Context.Service<PlanetScaleCostProvider, CostProviderAdapter>()(
	"@maple/backend/services/cost/PlanetScaleCostProvider",
	{
		make: Effect.gen(function* () {
			const connections = yield* CostConnectionStore
			const httpClient = yield* HttpClient.HttpClient

			const pull = Effect.fn("PlanetScaleCostProvider.pull")(
				function* (source: CostPullSource, window: CostPullWindow) {
					yield* Effect.annotateCurrentSpan({
						orgId: source.orgId,
						"maple.cost.provider": "planetscale",
						"maple.cost.start_day": window.startDay,
						"maple.cost.end_day": window.endDay,
					})
					const credential = yield* connections
						.load("planetscale", source)
						.pipe(Effect.mapError(toStoreFailure))
					if (Option.isNone(credential)) {
						return yield* planetScaleCostFailure(
							"auth",
							"No PlanetScale service token is saved for this source.",
						)
					}
					// The stored secret is the whole header, and the account is the organization.
					const { secret, accountId } = credential.value
					const rows = yield* pullInvoiceCost(
						httpClient,
						{ organization: accountId, authorization: secret },
						window,
					)
					yield* Effect.annotateCurrentSpan({ "maple.cost.rows": rows.length })
					return { rows, requests: 0 } satisfies CostPull
				},
				Effect.tapError((error) =>
					Effect.annotateCurrentSpan({ "maple.cost.error_reason": error.reason }),
				),
			)

			return { provider: "planetscale", pull } satisfies CostProviderAdapter
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(FetchHttpClient.layer, CostConnectionStore.layer)),
	)
}
