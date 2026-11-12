/**
 * PlanetScale's invoice API as the cost source reads it: an organization's invoices and one
 * invoice's line items, with a service token. Plain requests with the status read off the answer:
 * a 401, 403 or 404 is an expected answer when a token is checked, not a failed call.
 */
import { Effect, Redacted, Schema, Array as Arr } from "effect"
import { FetchHttpClient, type HttpClient, HttpClientRequest } from "effect/http"

export const PLANETSCALE_API_URL = "https://api.planetscale.com/v1"

const INVOICES_PER_PAGE = 50
const LINE_ITEMS_PER_PAGE = 100
/** 50 pages of invoices is four times what an organization of 50 years has. */
const MAX_INVOICE_PAGES = 50
/** 20,000 line items in one month: more is refused, never read in part. */
const MAX_LINE_ITEM_PAGES = 200

export interface PlanetScaleInvoiceCredentials {
	/** The organization's slug, as in `app.planetscale.com/<organization>`. */
	readonly organization: string
	/** `<token id>:<token>`: the whole `Authorization` header PlanetScale takes, with no scheme. */
	readonly authorization: Redacted.Redacted
}

/** The header value a service token is sent as. */
export const serviceTokenAuthorization = (tokenId: string, token: string): Redacted.Redacted =>
	Redacted.make(`${tokenId}:${token}`)

/**
 * `unauthorized` (401): not a live token. `forbidden` (403): the token lacks `read_invoices`.
 * `not_found` (404): the token cannot see the organization. `too_large`: more pages than a read takes.
 */
export class PlanetScaleInvoiceApiError extends Schema.TaggedError<PlanetScaleInvoiceApiError>()(
	"@maple/backend/cost/PlanetScaleInvoiceApiError",
	{
		message: Schema.String,
		reason: Schema.Literals([
			"unauthorized",
			"forbidden",
			"not_found",
			"rate_limited",
			"invalid_response",
			"too_large",
			"upstream",
		]),
		status: Schema.Number,
	},
) {}

type Reason = PlanetScaleInvoiceApiError["reason"]

const failed = (reason: Reason, status: number, message: string) =>
	new PlanetScaleInvoiceApiError({ reason, status, message })

const reasonOfStatus = (status: number): Reason =>
	status === 401
		? "unauthorized"
		: status === 403
			? "forbidden"
			: status === 404
				? "not_found"
				: status === 429
					? "rate_limited"
					: "upstream"

/** Dollars. PlanetScale sends a decimal string; a bare number is read the same way. */
const Dollars = Schema.Union([Schema.Finite, Schema.FiniteFromString])

/** One billing period: a calendar month, `billing_period_end` exclusive (the next month's first). */
export const Invoice = Schema.Struct({
	id: Schema.String,
	billing_period_start: Schema.DateTimeUtcFromString,
	billing_period_end: Schema.DateTimeUtcFromString,
	paid: Schema.Boolean,
})
export type Invoice = typeof Invoice.Type

/** What a line item is billed for: a branch, with when it was made and deleted. */
const LineItemResource = Schema.Struct({
	type: Schema.optionalKey(Schema.NullOr(Schema.String)),
	name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	created_at: Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtcFromString)),
	deleted_at: Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtcFromString)),
})

/** One charge of an invoice. `subtotal` is negative on a prorated discount line. */
export const InvoiceLineItem = Schema.Struct({
	id: Schema.String,
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	/** The SKU, e.g. `PS_10_AWS_ARM` or `egress`. */
	metric_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	subtotal: Dollars,
	database_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	resource: Schema.optionalKey(Schema.NullOr(LineItemResource)),
})
export type InvoiceLineItem = typeof InvoiceLineItem.Type

const pageOf = <A, I>(item: Schema.Codec<A, I>) =>
	Schema.Struct({ next_page: Schema.NullOr(Schema.Number), data: Schema.Array(item) })

const InvoicePage = pageOf(Invoice)
const LineItemPage = pageOf(InvoiceLineItem)

interface Page<A> {
	readonly next_page: number | null
	readonly data: ReadonlyArray<A>
}

const getPage =
	<A, I>(schema: Schema.Codec<Page<A>, I>, what: string) =>
	(
		httpClient: HttpClient.HttpClient,
		credentials: PlanetScaleInvoiceCredentials,
		path: string,
		perPage: number,
		page: number,
	): Effect.Effect<Page<A>, PlanetScaleInvoiceApiError> =>
		httpClient
			.execute(
				HttpClientRequest.get(
					`${PLANETSCALE_API_URL}/organizations/${encodeURIComponent(credentials.organization)}${path}`,
				).pipe(
					HttpClientRequest.setUrlParams({ per_page: `${perPage}`, page: `${page}` }),
					HttpClientRequest.setHeader("Authorization", Redacted.value(credentials.authorization)),
					HttpClientRequest.acceptJson,
				),
			)
			.pipe(
				// A redirect is not PlanetScale answering: the token is never followed to another host.
				Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
				Effect.mapError(() =>
					failed("upstream", 0, `PlanetScale did not answer the ${what} request.`),
				),
				Effect.flatMap((response) =>
					response.status === 200
						? response.json.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(schema)),
								Effect.mapError(() =>
									failed(
										"invalid_response",
										200,
										`PlanetScale's ${what} answer could not be read.`,
									),
								),
							)
						: Effect.fail(
								failed(
									reasonOfStatus(response.status),
									response.status,
									`PlanetScale answered ${response.status} to the ${what} request.`,
								),
							),
				),
				Effect.annotateSpans("peer.service", "planetscale"),
			)

// Pages from the first on, until the API names no next page or `enough` of them are read.
const readPages = <A>(
	read: (page: number) => Effect.Effect<Page<A>, PlanetScaleInvoiceApiError>,
	maxPages: number,
	what: string,
	enough: (items: ReadonlyArray<A>) => boolean,
) => {
	const from = (
		page: number,
		before: ReadonlyArray<A>,
	): Effect.Effect<ReadonlyArray<A>, PlanetScaleInvoiceApiError> =>
		read(page).pipe(
			Effect.flatMap((answer) => {
				const items = Arr.appendAll(before, answer.data)
				if (answer.next_page === null || enough(answer.data)) return Effect.succeed(items)
				return page >= maxPages
					? Effect.fail(
							failed("too_large", 200, `PlanetScale has more ${what} than one read takes.`),
						)
					: from(page + 1, items)
			}),
		)
	return from(1, [])
}

const getInvoicePage = getPage(InvoicePage, "invoices")
const getLineItemPage = getPage(LineItemPage, "invoice line items")

/**
 * The organization's invoices, newest first, the open month included. Reading stops at the first
 * page that `enough` accepts: invoices older than a pull's window are not asked for.
 */
export const listInvoices = (
	httpClient: HttpClient.HttpClient,
	credentials: PlanetScaleInvoiceCredentials,
	enough: (page: ReadonlyArray<Invoice>) => boolean = () => false,
) =>
	readPages(
		(page) => getInvoicePage(httpClient, credentials, "/invoices", INVOICES_PER_PAGE, page),
		MAX_INVOICE_PAGES,
		"invoices",
		enough,
	)

/** Every line item of one invoice, or its first pages up to the one `enough` accepts. */
export const listInvoiceLineItems = (
	httpClient: HttpClient.HttpClient,
	credentials: PlanetScaleInvoiceCredentials,
	invoiceId: string,
	enough: (page: ReadonlyArray<InvoiceLineItem>) => boolean = () => false,
) =>
	readPages(
		(page) =>
			getLineItemPage(
				httpClient,
				credentials,
				`/invoices/${encodeURIComponent(invoiceId)}/line-items`,
				LINE_ITEMS_PER_PAGE,
				page,
			),
		MAX_LINE_ITEM_PAGES,
		"invoice line items",
		enough,
	)
