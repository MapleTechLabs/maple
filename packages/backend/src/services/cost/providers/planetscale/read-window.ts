// The invoices a pull window needs: one list read, then one line-item read per month in the window.
import { Effect, Array as Arr } from "effect"
import type { HttpClient } from "effect/http"
import type { CostPullWindow } from "../../CostProvider"
import { listInvoiceLineItems, listInvoices, type PlanetScaleInvoiceCredentials } from "./invoices-api"
import { type InvoiceWithLineItems, invoicePeriod, periodInWindow } from "./normalize"

/**
 * Every invoice that bills a day of `window`, with all its line items. Invoices come newest first,
 * so listing stops at the first page that reaches back to the window's first day.
 */
export const readInvoicesOfWindow = (
	httpClient: HttpClient.HttpClient,
	credentials: PlanetScaleInvoiceCredentials,
	window: CostPullWindow,
) =>
	listInvoices(httpClient, credentials, (page) =>
		Arr.some(page, (invoice) => invoicePeriod(invoice).startDay <= window.startDay),
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
