/**
 * OpenAI as a cost provider: an organization's daily API spend by model, line item and project,
 * read with the Admin API key the org saved.
 */
import { Clock, Context, DateTime, Effect, Layer, Option, Result } from "effect"
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
import * as OpenAiCosts from "./openai-costs-api"
import { toCostRows } from "./normalize"

/** Pages one pull reads at most: far beyond a year of days grouped by project and line item. */
export const MAX_PULL_PAGES = 60
/** The newest days OpenAI may still be counting. */
const OPEN_DAYS = 2

type Reason = CostProviderError["reason"]

// OpenAI does not bill for API requests, so no failure counts any.
const failed = (reason: Reason, message: string) =>
	new CostProviderError({ message, provider: "openai", reason, requests: 0 })

/** OpenAI's failures, as what the sync does next and the Cost page shows. */
const toCostProviderError = (error: OpenAiCosts.OpenAiCostsError): CostProviderError => {
	switch (error.kind) {
		case "unauthorized":
			return failed("auth", "OpenAI rejected the saved key. Replace the key to resume the sync.")
		// The key passed this check when it was saved: its access was taken away since.
		case "forbidden":
			return failed(
				"not_ready",
				"OpenAI no longer lets the saved key read the organization's costs. Replace it with an Admin API key.",
			)
		case "invalid_response":
			return failed("invalid_response", "OpenAI's cost answer could not be read.")
		case "rate_limited":
			return failed("rate_limited", "OpenAI is rate limiting cost requests.")
		// A 400 is a request Maple wrote wrong, which a retry does not fix but a deploy does.
		default:
			return failed("upstream", "OpenAI did not answer the cost request.")
	}
}

/** The Unix seconds `day` starts at, UTC. */
export const unixDayStart = (day: string): number =>
	DateTime.toEpochMillis(DateTime.makeUnsafe(`${day}T00:00:00Z`)) / 1000

export class OpenAiCostProvider extends Context.Service<OpenAiCostProvider, CostProviderAdapter>()(
	"@maple/backend/services/cost/OpenAiCostProvider",
	{
		make: Effect.gen(function* () {
			const connections = yield* CostConnectionStore
			const httpClient = yield* HttpClient.HttpClient

			const pull = Effect.fn("OpenAiCostProvider.pull")(
				function* (source: CostPullSource, window: CostPullWindow) {
					yield* Effect.annotateCurrentSpan({
						orgId: source.orgId,
						"maple.cost.provider": "openai",
						"maple.cost.start_day": window.startDay,
						"maple.cost.end_day": window.endDay,
					})
					const credential = yield* connections
						.load("openai", source)
						.pipe(Effect.mapError(loadFailureOf("openai")))
					if (Option.isNone(credential)) {
						return yield* failed("auth", "No OpenAI key is saved for this source.")
					}
					const { secret, accountId } = credential.value
					const listing = yield* OpenAiCosts.listCosts(
						httpClient,
						secret,
						{
							startTime: unixDayStart(window.startDay),
							endTime: unixDayStart(addDays(window.endDay, 1)),
							groupBy: ["project_id", "line_item"],
						},
						MAX_PULL_PAGES,
					).pipe(Effect.mapError(toCostProviderError))
					yield* Effect.annotateCurrentSpan({ "maple.cost.openai.pages": listing.pages })
					// Part of the window's costs would store its other days as empty.
					if (!listing.complete) {
						return yield* failed(
							"too_large",
							`OpenAI's costs for this window take more than ${MAX_PULL_PAGES} pages.`,
						)
					}
					const now = yield* Clock.currentTimeMillis
					const openDay = addDays(utcToday(now), -OPEN_DAYS)
					const normalized = toCostRows(listing.buckets, accountId, window, openDay)
					if (Result.isFailure(normalized)) {
						return yield* failed("invalid_response", "OpenAI's cost answer could not be read.")
					}
					const rows = normalized.success
					yield* Effect.annotateCurrentSpan({ "maple.cost.rows": rows.length })
					return { rows, requests: 0 } satisfies CostPull
				},
				Effect.tapError((error) =>
					Effect.annotateCurrentSpan({ "maple.cost.error_reason": error.reason }),
				),
			)

			return { provider: "openai", pull } satisfies CostProviderAdapter
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(FetchHttpClient.layer, CostConnectionStore.layer)),
	)
}
