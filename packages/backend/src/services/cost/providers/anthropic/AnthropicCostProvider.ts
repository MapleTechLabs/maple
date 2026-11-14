/**
 * Anthropic as a cost provider: an organization's daily API spend by model or tool, cost line and
 * workspace, read from the cost report with the Admin API key the org saved.
 */
import { Clock, Context, Effect, Layer, Option, Redacted, Result } from "effect"
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
import * as AnthropicCost from "./anthropic-cost-api"
import { toCostRows } from "./normalize"

/** Pages one pull reads at most: years of days, far beyond any window the sync asks for. */
const MAX_PAGES = 60
/** The newest days Anthropic may still be counting. */
const OPEN_DAYS = 2

type Reason = CostProviderError["reason"]

// Anthropic does not bill for Admin API requests, so no failure counts any.
const failed = (reason: Reason, message: string) =>
	new CostProviderError({ message, provider: "anthropic", reason, requests: 0 })

const UNREADABLE = "Anthropic's cost report could not be read."

/** Anthropic's failures, as what the sync does next and the Cost page shows. */
const toCostProviderError = (error: AnthropicCost.AnthropicCostApiError): CostProviderError => {
	switch (error.kind) {
		case "unauthorized":
			return failed("auth", "Anthropic rejected the saved key. Replace the key to resume the sync.")
		// The key read the costs when it was saved: that access was taken away since.
		case "forbidden":
			return failed(
				"not_ready",
				"Anthropic no longer lets the saved key read the organization's costs. Replace it with an Admin API key.",
			)
		case "invalid_response":
			return failed("invalid_response", UNREADABLE)
		case "rate_limited":
			return failed("rate_limited", "Anthropic is rate limiting cost report requests.")
		// A 400 is a request Maple wrote wrong, which a retry does not fix but a deploy does.
		default:
			return failed("upstream", "Anthropic did not answer the cost report request.")
	}
}

interface Report {
	readonly buckets: ReadonlyArray<AnthropicCost.CostBucket>
	readonly pages: number
}

export class AnthropicCostProvider extends Context.Service<AnthropicCostProvider, CostProviderAdapter>()(
	"@maple/backend/services/cost/AnthropicCostProvider",
	{
		make: Effect.gen(function* () {
			const connections = yield* CostConnectionStore
			const httpClient = yield* HttpClient.HttpClient

			/** Every bucket of the window, one page at a time, following `next_page` while there is more. */
			const readReport = (
				key: Redacted.Redacted,
				window: CostPullWindow,
				page: string | undefined,
				read: Report,
			): Effect.Effect<Report, CostProviderError> =>
				Effect.gen(function* () {
					if (read.pages >= MAX_PAGES) {
						return yield* failed(
							"too_large",
							"Anthropic's cost report for this window spans too many pages.",
						)
					}
					const body = yield* AnthropicCost.getCostReport(httpClient, key, window, page).pipe(
						Effect.mapError(toCostProviderError),
					)
					const next = { buckets: [...read.buckets, ...body.data], pages: read.pages + 1 }
					if (!body.has_more) return next
					const cursor = body.next_page ?? null
					// More pages and no way to ask for them, or the same page again: reading on would only
					// repeat it, so what was read is only part of the window.
					if (cursor === null || cursor === page)
						return yield* failed("invalid_response", UNREADABLE)
					return yield* readReport(key, window, cursor, next)
				})

			const pull = Effect.fn("AnthropicCostProvider.pull")(
				function* (source: CostPullSource, window: CostPullWindow) {
					yield* Effect.annotateCurrentSpan({
						orgId: source.orgId,
						"maple.cost.provider": "anthropic",
						"maple.cost.start_day": window.startDay,
						"maple.cost.end_day": window.endDay,
					})
					const credential = yield* connections
						.load("anthropic", source)
						.pipe(Effect.mapError(loadFailureOf("anthropic")))
					if (Option.isNone(credential)) {
						return yield* failed("auth", "No Anthropic key is saved for this source.")
					}
					const { secret, accountId } = credential.value
					const report = yield* readReport(secret, window, undefined, { buckets: [], pages: 0 })
					yield* Effect.annotateCurrentSpan({ "maple.cost.anthropic.pages": report.pages })
					const now = yield* Clock.currentTimeMillis
					const openDay = addDays(utcToday(now), -OPEN_DAYS)
					const normalized = toCostRows(report.buckets, accountId, window, openDay)
					if (Result.isFailure(normalized)) {
						yield* Effect.annotateCurrentSpan({ "maple.cost.anthropic.error": "bad_amount" })
						return yield* failed("invalid_response", UNREADABLE)
					}
					const rows = normalized.success
					yield* Effect.annotateCurrentSpan({ "maple.cost.rows": rows.length })
					return { rows, requests: 0 } satisfies CostPull
				},
				Effect.tapError((error) =>
					Effect.annotateCurrentSpan({ "maple.cost.error_reason": error.reason }),
				),
			)

			return { provider: "anthropic", pull } satisfies CostProviderAdapter
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(FetchHttpClient.layer, CostConnectionStore.layer)),
	)
}
