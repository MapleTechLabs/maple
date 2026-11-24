/**
 * Morph as a cost provider: the account's daily spend by model, from Morph's usage API, read with
 * the key the org saved.
 */
import { Clock, Context, Effect, Layer, Option, Array as Arr } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import {
	type CostProviderAdapter,
	CostProviderError,
	type CostPull,
	type CostPullSource,
	type CostPullWindow,
} from "../../CostProvider"
import { CostConnectionStore, loadFailureOf } from "../../CostConnectionStore"
import { addDays, minDay, utcToday } from "../../sync-plan"
import * as MorphUsage from "./morph-usage-api"
import { toCostRows } from "./normalize"

type Reason = CostProviderError["reason"]

// Morph does not bill for API requests, so no failure counts any.
const failed = (reason: Reason, message: string) =>
	new CostProviderError({ message, provider: "morph", reason, requests: 0 })

/** Morph's failures, as what the sync does next and the Cost page shows. */
export const toCostProviderError = (error: MorphUsage.MorphUsageError): CostProviderError => {
	switch (error.kind) {
		case "unauthorized":
			return failed("auth", "Morph rejected the saved key. Replace the key to resume the sync.")
		case "invalid_response":
			return failed("invalid_response", "Morph's usage answer could not be read.")
		case "rate_limited":
			return failed("rate_limited", "Morph is rate limiting usage requests.")
		default:
			return failed("upstream", "Morph did not answer the usage request.")
	}
}

/** `start` through `end` in ranges Morph serves in one request each. */
export const usageRanges = (
	start: string,
	end: string,
): ReadonlyArray<{ readonly start: string; readonly end: string }> => {
	if (start > end) return []
	const last = minDay(end, addDays(start, MorphUsage.MORPH_MAX_RANGE_DAYS - 1))
	return [{ start, end: last }, ...usageRanges(addDays(last, 1), end)]
}

export class MorphCostProvider extends Context.Service<MorphCostProvider, CostProviderAdapter>()(
	"@maple/backend/services/cost/MorphCostProvider",
	{
		make: Effect.gen(function* () {
			const connections = yield* CostConnectionStore
			const httpClient = yield* HttpClient.HttpClient

			const pull = Effect.fn("MorphCostProvider.pull")(
				function* (source: CostPullSource, window: CostPullWindow) {
					yield* Effect.annotateCurrentSpan({
						orgId: source.orgId,
						"maple.cost.provider": "morph",
						"maple.cost.start_day": window.startDay,
						"maple.cost.end_day": window.endDay,
					})
					const credential = yield* connections
						.load("morph", source)
						.pipe(Effect.mapError(loadFailureOf("morph")))
					if (Option.isNone(credential)) {
						return yield* failed("auth", "No Morph key is saved for this source.")
					}
					const { secret, accountId } = credential.value
					// Morph refuses a range that ends before it starts, and has nothing after today.
					const now = yield* Clock.currentTimeMillis
					const today = utcToday(now)
					const ranges = usageRanges(window.startDay, minDay(window.endDay, today))
					const answers = yield* Effect.forEach(ranges, (range) =>
						MorphUsage.getUsage(httpClient, secret, range).pipe(
							Effect.mapError(toCostProviderError),
						),
					)
					const days = Arr.flatMap(answers, (answer) => answer.days)
					// Today's figures still grow: Morph refreshes them every 30 minutes.
					const rows = toCostRows(days, accountId, window, today)
					yield* Effect.annotateCurrentSpan({
						"maple.cost.morph.days": days.length,
						"maple.cost.rows": rows.length,
					})
					return { rows, requests: 0 } satisfies CostPull
				},
				Effect.tapError((error) =>
					Effect.annotateCurrentSpan({ "maple.cost.error_reason": error.reason }),
				),
			)

			return { provider: "morph", pull } satisfies CostProviderAdapter
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(FetchHttpClient.layer, CostConnectionStore.layer)),
	)
}
