/**
 * OpenRouter as a cost provider: an account's daily spend by model and serving provider, from
 * the activity API, read with the management key the org saved.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { OpenRouterCostConnections } from "@maple/db/tables"
import { Clock, Context, Duration, Effect, Layer, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { openSecret, secretKeyringFromEnv } from "@maple/backend/platform/SecretBox"
import { openRouterCostKeySlot } from "@maple/backend/platform/secret-slots"
import * as OpenRouterApi from "../../../org/openrouter-api"
import {
	type CostProviderAdapter,
	CostProviderError,
	type CostPull,
	type CostPullSource,
	type CostPullWindow,
} from "../../CostProvider"
import { addDays, utcToday } from "../../sync-plan"
import { toCostRows } from "./normalize"

const PULL_TIMEOUT = Duration.seconds(30)

type Reason = CostProviderError["reason"]

// OpenRouter does not bill for management requests, so no failure counts any.
const failed = (reason: Reason, message: string) =>
	new CostProviderError({ message, provider: "openrouter", reason, requests: 0 })

/** OpenRouter's typed failures, as what the sync does next and the Cost page shows. */
const toCostProviderError = (error: OpenRouterApi.OpenRouterError): CostProviderError => {
	switch (error._tag) {
		case "@maple/backend/openrouter/Unauthorized":
			return failed("auth", "OpenRouter rejected the saved key. Replace the key to resume the sync.")
		// The key passed this check when it was saved: its access was taken away since.
		case "@maple/backend/openrouter/Forbidden":
			return failed(
				"not_ready",
				"OpenRouter no longer lets the saved key read the account's activity. Replace it with a new management key.",
			)
		case "@maple/backend/openrouter/OpenRouterParseError":
			return failed("invalid_response", "OpenRouter's activity answer could not be read.")
		// The SDK's own name for a 429.
		case "TooManyRequests":
			return failed("rate_limited", "OpenRouter is rate limiting activity requests.")
		default:
			return failed("upstream", "OpenRouter did not answer the activity request.")
	}
}

export class OpenRouterCostProvider extends Context.Service<OpenRouterCostProvider, CostProviderAdapter>()(
	"@maple/backend/services/cost/OpenRouterCostProvider",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient
			// Read at the first pull, not here: an unusable key must not stop the sync of other providers.
			const keyring = yield* Effect.cached(
				secretKeyringFromEnv(env, (message) => failed("auth", message)),
			)
			const dbExecute = makeDbExecute(database, "OpenRouterCostProvider", () =>
				failed("upstream", "OpenRouter connection database error"),
			)

			const pull = Effect.fn("OpenRouterCostProvider.pull")(
				function* (source: CostPullSource, window: CostPullWindow) {
					yield* Effect.annotateCurrentSpan({
						orgId: source.orgId,
						"maple.cost.provider": "openrouter",
						"maple.cost.start_day": window.startDay,
						"maple.cost.end_day": window.endDay,
					})
					// By org as well as id: a source never reads another org's key.
					const [row] = yield* dbExecute((db) =>
						db.run(
							PG.from(OpenRouterCostConnections)
								.select()
								.where(($) => [$.orgId.eq(source.orgId), $.id.eq(source.connectionRef)])
								.limit(1),
						),
					)
					if (row === undefined)
						return yield* failed("auth", "No OpenRouter key is saved for this source.")
					const secrets = yield* keyring
					const apiKey = yield* openSecret(
						secrets,
						openRouterCostKeySlot,
						{ orgId: row.orgId },
						{ ciphertext: row.keyCiphertext, iv: row.keyIv, tag: row.keyTag },
						(message) => failed("auth", message),
					)
					// One answer holds every day OpenRouter serves, so any window is one request.
					const activity = yield* OpenRouterApi.getActivity({}).pipe(
						// The page shows the mapped message; which failure it was stays on the span.
						Effect.tapError((error) =>
							Effect.annotateCurrentSpan("maple.cost.openrouter.error", error._tag),
						),
						Effect.mapError(toCostProviderError),
						OpenRouterApi.withKey(httpClient, {
							apiKey: Redacted.make(apiKey),
							apiBaseUrl: OpenRouterApi.OPENROUTER_MANAGEMENT_API_URL,
						}),
						Effect.timeoutOrElse({
							duration: PULL_TIMEOUT,
							orElse: () =>
								Effect.fail(failed("upstream", "OpenRouter took too long to answer.")),
						}),
					)
					// Yesterday ended hours ago at most: OpenRouter may still be counting it.
					const now = yield* Clock.currentTimeMillis
					const openDay = addDays(utcToday(now), -1)
					const rows = toCostRows(activity.data, row.accountId, window, openDay)
					yield* Effect.annotateCurrentSpan({
						"maple.cost.rows": rows.length,
						"maple.cost.openrouter.activity_rows": activity.data.length,
					})
					return { rows, requests: 0 } satisfies CostPull
				},
				Effect.tapError((error) =>
					Effect.annotateCurrentSpan({ "maple.cost.error_reason": error.reason }),
				),
			)

			return { provider: "openrouter", pull } satisfies CostProviderAdapter
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
