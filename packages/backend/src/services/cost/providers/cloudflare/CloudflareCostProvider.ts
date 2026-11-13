/**
 * Cloudflare as a cost provider: an account's daily usage charges by product and priced metric,
 * plus its subscriptions' fees, read with the API token the org saved.
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
import { addDays, utcToday } from "../../sync-plan"
import * as CloudflareBilling from "./cloudflare-billing-api"
import { toSubscriptionRows, toUsageRows, unplacedFees } from "./normalize"

/** Days of a window one request reads: with the period it leads with, under the API's 90 day cap. */
const PIECE_DAYS = 55
/** The newest days Cloudflare may still be counting. */
const OPEN_DAYS = 2

type Reason = CostProviderError["reason"]

// Cloudflare does not bill for API requests, so no failure counts any.
const failed = (reason: Reason, message: string) =>
	new CostProviderError({ message, provider: "cloudflare", reason, requests: 0 })

/** Cloudflare's failures, as what the sync does next and the Cost page shows. */
const toCostProviderError = (error: CloudflareBilling.CloudflareBillingError): CostProviderError => {
	switch (error.kind) {
		case "unauthorized":
			return failed(
				"auth",
				"Cloudflare rejected the saved token. Replace the token to resume the sync.",
			)
		// The token passed this check when it was saved: its billing access was taken away since.
		case "forbidden":
			return failed(
				"not_ready",
				"Cloudflare no longer lets the saved token read the account's billing. Replace it with a token that has the Billing: Read permission.",
			)
		case "invalid_response":
			return failed("invalid_response", "Cloudflare's billing answer could not be read.")
		case "rate_limited":
			return failed("rate_limited", "Cloudflare is rate limiting billing requests.")
		// A 400 is a request Maple wrote wrong, which a retry does not fix but a deploy does.
		default:
			return failed("upstream", "Cloudflare did not answer the billing request.")
	}
}

/** The window as consecutive runs of at most `PIECE_DAYS` days, oldest first. */
const piecesOf = (window: CostPullWindow): ReadonlyArray<CostPullWindow> =>
	Arr.unfold(window.startDay, (startDay): Option.Option<readonly [CostPullWindow, string]> => {
		if (startDay > window.endDay) return Option.none()
		const last = addDays(startDay, PIECE_DAYS - 1)
		const endDay = last < window.endDay ? last : window.endDay
		return Option.some([{ startDay, endDay }, addDays(endDay, 1)])
	})

export class CloudflareCostProvider extends Context.Service<CloudflareCostProvider, CostProviderAdapter>()(
	"@maple/backend/services/cost/CloudflareCostProvider",
	{
		make: Effect.gen(function* () {
			const connections = yield* CostConnectionStore
			const httpClient = yield* HttpClient.HttpClient

			const pull = Effect.fn("CloudflareCostProvider.pull")(
				function* (source: CostPullSource, window: CostPullWindow) {
					yield* Effect.annotateCurrentSpan({
						orgId: source.orgId,
						"maple.cost.provider": "cloudflare",
						"maple.cost.start_day": window.startDay,
						"maple.cost.end_day": window.endDay,
					})
					const credential = yield* connections
						.load("cloudflare", source)
						.pipe(Effect.mapError(loadFailureOf("cloudflare")))
					if (Option.isNone(credential)) {
						return yield* failed("auth", "No Cloudflare token is saved for this source.")
					}
					const { secret, accountId } = credential.value
					const asked = <A>(call: Effect.Effect<A, CloudflareBilling.CloudflareBillingError>) =>
						Effect.mapError(call, toCostProviderError)

					const info = yield* asked(
						CloudflareBilling.getBillableUsageInfo(httpClient, secret, accountId),
					)
					if (!info.covered) {
						return yield* failed("not_ready", CloudflareBilling.NOT_COVERED)
					}
					const now = yield* Clock.currentTimeMillis
					const openDay = addDays(utcToday(now), -OPEN_DAYS)
					// One request at a time. Each answer is cut to its own piece: it also holds days from
					// before it, which belong to the piece before.
					const usage = yield* Effect.forEach(piecesOf(window), (piece) =>
						asked(CloudflareBilling.getBillableUsage(httpClient, secret, accountId, piece)).pipe(
							Effect.map((items) => toUsageRows(items, accountId, piece, openDay)),
						),
					)
					const subscriptions = yield* asked(
						CloudflareBilling.listSubscriptions(httpClient, secret, accountId),
					)
					const fees = toSubscriptionRows(subscriptions, accountId, window, openDay)
					const rows = [...Arr.flatten(usage), ...fees]
					yield* Effect.annotateCurrentSpan({
						"maple.cost.rows": rows.length,
						"maple.cost.cloudflare.fee_rows": fees.length,
						// Charged subscriptions no row holds: a frequency Maple does not step, or no period.
						"maple.cost.cloudflare.fees_skipped": unplacedFees(subscriptions),
						"maple.cost.cloudflare.usage_requests": usage.length,
					})
					return { rows, requests: 0 } satisfies CostPull
				},
				Effect.tapError((error) =>
					Effect.annotateCurrentSpan({ "maple.cost.error_reason": error.reason }),
				),
			)

			return { provider: "cloudflare", pull } satisfies CostProviderAdapter
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(FetchHttpClient.layer, CostConnectionStore.layer)),
	)
}
