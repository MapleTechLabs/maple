// One PlanetScale cost pull, given the token: the window's invoices read and spread into rows,
// with PlanetScale's refusals as what the sync does next and the Cost page shows.
import { Duration, Effect, Array as Arr } from "effect"
import type { HttpClient } from "effect/http"
import { CostProviderError, type CostPullRow, type CostPullWindow } from "../../CostProvider"
import { addDays, PREVIOUS_MONTH_OPEN_DAYS } from "../../sync-plan"
import {
	listInvoiceLineItems,
	listInvoices,
	NO_INVOICE_ACCESS,
	type PlanetScaleInvoiceApiError,
	type PlanetScaleInvoiceCredentials,
} from "./invoices-api"
import { type InvoiceWithLineItems, invoicePeriod, periodInWindow, toCostRows } from "./normalize"

/**
 * A year of invoices is a list read and thirteen line-item reads. Two months at the most pages a
 * month may have is a hundred requests, which this still leaves time for.
 */
const PULL_TIMEOUT = Duration.seconds(120)

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
	forbidden: failure("not_ready", NO_INVOICE_ACCESS),
	// PlanetScale answers 404 for a deleted token as well as for an organization the token cannot see.
	not_found: failure(
		"not_ready",
		"PlanetScale found no organization for the saved service token. If the token was deleted, replace it to resume the sync.",
	),
	rate_limited: failure("rate_limited", "PlanetScale is rate limiting invoice requests."),
	invalid_response: failure("invalid_response", "PlanetScale's invoice answer could not be read."),
	too_large: failure(
		"too_large",
		"This organization has more invoices or invoice line items than Maple reads.",
	),
	upstream: failure("upstream", "PlanetScale did not answer the invoice request."),
} satisfies Record<
	PlanetScaleInvoiceApiError["reason"],
	{ readonly reason: Reason; readonly message: string }
>

const toCostProviderError = (error: PlanetScaleInvoiceApiError): CostProviderError => {
	const { reason, message } = FAILURES[error.reason]
	return planetScaleCostFailure(reason, message)
}

/**
 * Every invoice that bills a day of `window`, with all its line items. Invoices come newest first,
 * so listing stops at the first page that holds one from wholly before the window.
 */
export const readInvoicesOfWindow = (
	httpClient: HttpClient.HttpClient,
	credentials: PlanetScaleInvoiceCredentials,
	window: CostPullWindow,
) =>
	listInvoices(httpClient, credentials, (page) =>
		Arr.some(page, (invoice) => invoicePeriod(invoice).endDay < window.startDay),
	).pipe(
		Effect.flatMap((invoices) =>
			Effect.forEach(
				Arr.filter(invoices, (invoice) => periodInWindow(invoicePeriod(invoice), window)),
				(invoice) =>
					listInvoiceLineItems(httpClient, credentials, invoice.id).pipe(
						Effect.map((lineItems): InvoiceWithLineItems => ({ invoice, lineItems })),
					),
			),
		),
	)

/** The window's days as rows, from every invoice that bills one of them. `today` is the UTC day of the pull. */
export const pullInvoiceCost = (
	httpClient: HttpClient.HttpClient,
	credentials: PlanetScaleInvoiceCredentials,
	window: CostPullWindow,
	today: string,
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
		// The sync pulls the previous month once more after it closed: that pull writes it final.
		Effect.map((invoices) =>
			toCostRows(invoices, credentials.organization, window, addDays(today, -PREVIOUS_MONTH_OPEN_DAYS)),
		),
		Effect.timeoutOrElse({
			duration: PULL_TIMEOUT,
			orElse: () =>
				Effect.fail(planetScaleCostFailure("upstream", "PlanetScale took too long to answer.")),
		}),
	)
