/**
 * Vercel as a cost provider: a team's daily billed charges by product, project and region, from
 * the billing charges API, read with the token of the org's Vercel connection.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { VercelConnections } from "@maple/db/tables"
import { Clock, Context, Duration, Effect, Layer, Stream } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { secretKeyringFromEnv } from "@maple/backend/platform/SecretBox"
import { streamBillingCharges, type VercelApiError } from "../../../integrations/vercel/api"
import { openVercelToken } from "../../../integrations/vercel/token"
import {
	type CostProviderAdapter,
	CostProviderError,
	type CostPull,
	type CostPullSource,
	type CostPullWindow,
} from "../../CostProvider"
import { addDays, daysOfWindow, utcToday } from "../../sync-plan"
import { addCharge, emptyChargeTotals, rowsOf } from "./normalize"

const PULL_TIMEOUT = Duration.seconds(45)
/** Vercel serves a year at most in one request. The sync's windows are far shorter. */
const MAX_REQUEST_DAYS = 366

type Reason = CostProviderError["reason"]

// Vercel does not bill for API requests, so no failure counts any.
const failed = (reason: Reason, message: string) =>
	new CostProviderError({ message, provider: "vercel", reason, requests: 0 })

const TOKEN_REJECTED = "Vercel rejected the saved token. Connect Vercel again with a new token."

/** Vercel's failures, as what the sync does next and the Cost page shows. */
const toCostProviderError = (error: VercelApiError): CostProviderError => {
	switch (error.kind) {
		case "unauthorized":
			return failed("auth", TOKEN_REJECTED)
		case "forbidden":
			return failed(
				"not_ready",
				"This Vercel token's role cannot read the team's billing. Use a token from an Owner, Member, Developer or Billing role.",
			)
		case "not_found":
			return failed("not_ready", "Vercel has no billing data for this team, or the team is gone.")
		case "rate_limited":
			return failed("rate_limited", "Vercel is rate limiting billing requests.")
		case "invalid_response":
			return failed("invalid_response", "Vercel's billing answer could not be read.")
		case "upstream":
			return failed("upstream", "Vercel did not answer the billing request.")
	}
}

export class VercelCostProvider extends Context.Service<VercelCostProvider, CostProviderAdapter>()(
	"@maple/backend/services/cost/VercelCostProvider",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient
			// Read at the first pull, not here: an unusable key must not stop the sync of other providers.
			const keyring = yield* Effect.cached(
				secretKeyringFromEnv(env, (message) => failed("auth", message)),
			)
			const dbExecute = makeDbExecute(database, "VercelCostProvider", () =>
				failed("upstream", "Vercel connection database error"),
			)

			const pull = Effect.fn("VercelCostProvider.pull")(
				function* (source: CostPullSource, window: CostPullWindow) {
					yield* Effect.annotateCurrentSpan({
						orgId: source.orgId,
						"maple.cost.provider": "vercel",
						"maple.cost.start_day": window.startDay,
						"maple.cost.end_day": window.endDay,
					})
					if (daysOfWindow(window).length > MAX_REQUEST_DAYS) {
						return yield* failed(
							"too_large",
							`Vercel serves ${MAX_REQUEST_DAYS} days in one request at most.`,
						)
					}
					// By org as well as id: a source never reads another org's token.
					const [row] = yield* dbExecute((db) =>
						db.run(
							PG.from(VercelConnections)
								.select()
								.where(($) => [$.orgId.eq(source.orgId), $.id.eq(source.connectionRef)])
								.limit(1),
						),
					)
					if (row === undefined) {
						return yield* failed("auth", "No Vercel connection is saved for this source.")
					}
					// The integration's poller found the token rejected: asking again would only be refused.
					if (row.authFailedAt !== null) return yield* failed("auth", TOKEN_REJECTED)
					const secrets = yield* keyring
					const token = yield* openVercelToken(secrets, row, (message) => failed("auth", message))
					// Today and yesterday: Vercel may still be counting a day that ended hours ago.
					const now = yield* Clock.currentTimeMillis
					const openDay = addDays(utcToday(now), -1)
					const totals = yield* streamBillingCharges(httpClient, token, row.teamId, {
						from: `${window.startDay}T00:00:00Z`,
						// `to` is exclusive.
						to: `${addDays(window.endDay, 1)}T00:00:00Z`,
					}).pipe(
						Stream.runFold(emptyChargeTotals, (sums, charge) =>
							addCharge(sums, charge, row.teamSlug, window, openDay),
						),
						// The page shows the mapped message; which failure it was stays on the span.
						Effect.tapError((error) =>
							Effect.annotateCurrentSpan({
								"maple.cost.vercel.error": error.kind,
								"maple.cost.vercel.status": error.status ?? 0,
							}),
						),
						Effect.mapError(toCostProviderError),
						Effect.timeoutOrElse({
							duration: PULL_TIMEOUT,
							orElse: () => Effect.fail(failed("upstream", "Vercel took too long to answer.")),
						}),
					)
					const rows = rowsOf(totals)
					yield* Effect.annotateCurrentSpan({
						"maple.cost.rows": rows.length,
						"maple.cost.vercel.charge_groups": totals.size,
					})
					return { rows, requests: 0 } satisfies CostPull
				},
				Effect.tapError((error) =>
					Effect.annotateCurrentSpan({ "maple.cost.error_reason": error.reason }),
				),
			)

			return { provider: "vercel", pull } satisfies CostProviderAdapter
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
