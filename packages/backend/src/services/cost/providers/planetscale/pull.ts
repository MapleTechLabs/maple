// One read of PlanetScale invoice cost, given the authorization: the window's invoices read and
// spread into rows. What a refusal means for the sync and the Cost page is the adapter's to say.
import { Duration, Effect, Array as Arr } from "effect"
import type { HttpClient } from "effect/http"
import type { CostPullRow, CostPullWindow } from "../../CostProvider"
import { addDays } from "../../sync-plan"
import {
	listInvoiceLineItems,
	listInvoices,
	type PlanetScaleInvoiceApiError,
	type PlanetScaleInvoiceCredentials,
	withinTime,
} from "./invoices-api"
import { type InvoiceWithLineItems, invoicePeriod, periodInWindow, toCostRows } from "./normalize"

/**
 * A year of invoices is a list read and thirteen line-item reads. Two months at the most pages a
 * month may have is a hundred requests, which this still leaves time for.
 */
const PULL_TIMEOUT = Duration.seconds(120)

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
export const readInvoiceCost = (
	httpClient: HttpClient.HttpClient,
	credentials: PlanetScaleInvoiceCredentials,
	window: CostPullWindow,
	today: string,
): Effect.Effect<ReadonlyArray<CostPullRow>, PlanetScaleInvoiceApiError> =>
	readInvoicesOfWindow(httpClient, credentials, window).pipe(
		Effect.tap((invoices) =>
			Effect.annotateCurrentSpan("maple.cost.planetscale.invoices", invoices.length),
		),
		// Today and yesterday are still arriving, as with the other providers.
		Effect.map((invoices) => toCostRows(invoices, credentials.organization, window, addDays(today, -1))),
		withinTime(PULL_TIMEOUT),
	)
