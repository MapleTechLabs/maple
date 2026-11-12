// One PlanetScale cost pull, given the token: the window's invoices read and spread into rows,
// with PlanetScale's refusals as what the sync does next and the Cost page shows.
import { Duration, Effect } from "effect"
import type { HttpClient } from "effect/http"
import { CostProviderError, type CostPullRow, type CostPullWindow } from "../../CostProvider"
import type { PlanetScaleInvoiceApiError, PlanetScaleInvoiceCredentials } from "./invoices-api"
import { toCostRows } from "./normalize"
import { readInvoicesOfWindow } from "./read-window"

/** A year of invoices is a list read and thirteen line-item reads. */
const PULL_TIMEOUT = Duration.seconds(60)

type Reason = CostProviderError["reason"]

// PlanetScale does not bill for API requests, so no failure counts any.
export const planetScaleCostFailure = (reason: Reason, message: string) =>
	new CostProviderError({ message, provider: "planetscale", reason, requests: 0 })

const failure = (reason: Reason, message: string) => ({ reason, message })

const FAILURES = {
	unauthorized: failure(
		"auth",
		"PlanetScale rejected the saved service token. Replace the token to resume the sync.",
	),
	forbidden: failure(
		"not_ready",
		"This service token cannot read invoices. Add the read_invoices organization access to it in PlanetScale.",
	),
	// PlanetScale answers 404 for a deleted token as well as for an organization the token cannot see.
	not_found: failure(
		"not_ready",
		"PlanetScale found no organization for the saved service token. If the token was deleted, replace it to resume the sync.",
	),
	rate_limited: failure("rate_limited", "PlanetScale is rate limiting invoice requests."),
	invalid_response: failure("invalid_response", "PlanetScale's invoice answer could not be read."),
	too_large: failure(
		"too_large",
		"A month of this organization has more invoice line items than Maple reads.",
	),
	upstream: failure("upstream", "PlanetScale did not answer the invoice request."),
} satisfies Record<
	PlanetScaleInvoiceApiError["reason"],
	{ readonly reason: Reason; readonly message: string }
>

export const toCostProviderError = (error: PlanetScaleInvoiceApiError): CostProviderError => {
	const { reason, message } = FAILURES[error.reason]
	return planetScaleCostFailure(reason, message)
}

/** The window's days as rows, from every invoice that bills one of them. */
export const pullInvoiceCost = (
	httpClient: HttpClient.HttpClient,
	credentials: PlanetScaleInvoiceCredentials,
	window: CostPullWindow,
): Effect.Effect<ReadonlyArray<CostPullRow>, CostProviderError> =>
	readInvoicesOfWindow(httpClient, credentials, window).pipe(
		// The page shows the mapped message; which failure it was stays on the span.
		Effect.tapError((error) =>
			Effect.annotateCurrentSpan({
				"maple.cost.planetscale.error": error.reason,
				"maple.cost.planetscale.status": error.status,
			}),
		),
		Effect.mapError(toCostProviderError),
		Effect.tap((invoices) =>
			Effect.annotateCurrentSpan("maple.cost.planetscale.invoices", invoices.length),
		),
		Effect.map((invoices) => toCostRows(invoices, credentials.organization, window)),
		Effect.timeoutOrElse({
			duration: PULL_TIMEOUT,
			orElse: () =>
				Effect.fail(planetScaleCostFailure("upstream", "PlanetScale took too long to answer.")),
		}),
	)
