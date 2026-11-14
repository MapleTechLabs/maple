/**
 * Tinybird as a cost provider: an organization's estimated daily cost, its usage from the
 * `organization.*` service data sources priced at list prices, read with the token the org saved.
 */
import { Clock, Context, Effect, Layer, Option } from "effect"
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
import { isDedicated, toCostRows } from "./normalize"
import * as TinybirdCost from "./tinybird-cost-api"

/** The newest days Tinybird may still be counting. */
const OPEN_DAYS = 2

type Reason = CostProviderError["reason"]

// Tinybird does not bill for API requests, so no failure counts any.
const failed = (reason: Reason, message: string) =>
	new CostProviderError({ message, provider: "tinybird", reason, requests: 0 })

const UNREADABLE = "Tinybird's usage could not be read."
const NO_SCOPE =
	"Tinybird no longer lets the saved token read the organization's usage. Replace it with a token with the ORG_DATASOURCES:READ scope."

const fromHostError = (error: TinybirdCost.TinybirdHostError): CostProviderError => {
	switch (error.kind) {
		case "rejected":
			return failed("auth", "Tinybird rejected the saved token. Replace the token to resume the sync.")
		case "no_scope":
			return failed("not_ready", NO_SCOPE)
		case "rate_limited":
			return failed("rate_limited", "Tinybird is rate limiting usage requests.")
		case "invalid_response":
			return failed("invalid_response", UNREADABLE)
		default:
			return failed("upstream", "Tinybird did not answer the usage request.")
	}
}

const fromApiError = (error: TinybirdCost.TinybirdCostApiError): CostProviderError => {
	switch (error.kind) {
		case "unauthorized":
		case "elsewhere":
			return failed("auth", "Tinybird rejected the saved token. Replace the token to resume the sync.")
		case "forbidden":
			return failed("not_ready", NO_SCOPE)
		case "invalid_response":
			return failed("invalid_response", UNREADABLE)
		case "rate_limited":
			return failed("rate_limited", "Tinybird is rate limiting usage requests.")
		// A 400 is a query Maple wrote wrong, which a retry does not fix but a deploy does.
		default:
			return failed("upstream", "Tinybird did not answer the usage request.")
	}
}

export class TinybirdCostProvider extends Context.Service<TinybirdCostProvider, CostProviderAdapter>()(
	"@maple/backend/services/cost/TinybirdCostProvider",
	{
		make: Effect.gen(function* () {
			const connections = yield* CostConnectionStore
			const httpClient = yield* HttpClient.HttpClient

			const pull = Effect.fn("TinybirdCostProvider.pull")(
				function* (source: CostPullSource, window: CostPullWindow) {
					yield* Effect.annotateCurrentSpan({
						orgId: source.orgId,
						"maple.cost.provider": "tinybird",
						"maple.cost.start_day": window.startDay,
						"maple.cost.end_day": window.endDay,
					})
					const credential = yield* connections
						.load("tinybird", source)
						.pipe(Effect.mapError(loadFailureOf("tinybird")))
					if (Option.isNone(credential)) {
						return yield* failed("auth", "No Tinybird token is saved for this source.")
					}
					const { secret, accountId } = credential.value
					const { host } = yield* TinybirdCost.resolveHost(httpClient, secret).pipe(
						Effect.mapError(fromHostError),
					)
					const workspaces = yield* TinybirdCost.getWorkspaces(httpClient, secret, host).pipe(
						Effect.mapError(fromApiError),
					)
					const dedicated = isDedicated(workspaces)
					const [compute, storage, transfer] = yield* Effect.all(
						[
							dedicated
								? Effect.succeed([])
								: TinybirdCost.getComputeOverage(httpClient, secret, host, window),
							TinybirdCost.getStorage(httpClient, secret, host, window),
							TinybirdCost.getTransfer(httpClient, secret, host, window),
						],
						{ concurrency: "unbounded" },
					).pipe(Effect.mapError(fromApiError))
					const now = yield* Clock.currentTimeMillis
					const openDay = addDays(utcToday(now), -OPEN_DAYS)
					const rows = toCostRows(
						{ workspaces, compute, storage, transfer },
						{ accountId, region: host.region },
						window,
						openDay,
					)
					yield* Effect.annotateCurrentSpan({
						"maple.cost.rows": rows.length,
						"maple.cost.tinybird.dedicated": dedicated,
					})
					return { rows, requests: 0 } satisfies CostPull
				},
				Effect.tapError((error) =>
					Effect.annotateCurrentSpan({ "maple.cost.error_reason": error.reason }),
				),
			)

			return { provider: "tinybird", pull } satisfies CostProviderAdapter
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(FetchHttpClient.layer, CostConnectionStore.layer)),
	)
}
