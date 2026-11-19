/**
 * PlanetScale's invoice API as the cost source reads it, through `@distilled.cloud/planetscale`:
 * an organization's invoices and one invoice's line items, with the access token its caller
 * holds. A 401, 403 or 404 is an expected answer for a grant, not a failed call.
 */
import * as PlanetScale from "@distilled.cloud/planetscale"
import {
	type Duration,
	Effect,
	Layer,
	type Redacted,
	Schema,
	SchemaTransformation,
	Array as Arr,
	Record as Rec,
	String as Str,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http"
import * as VendorHttp from "../../../integrations/vendor-http"

const INVOICES_PER_PAGE = 50
const LINE_ITEMS_PER_PAGE = 100
/** 50 pages of invoices is four times what an organization of 50 years has. */
const MAX_INVOICE_PAGES = 50
/** 5,000 line items in one month: more is refused, never read in part. */
const MAX_LINE_ITEM_PAGES = 50

export interface PlanetScaleInvoiceCredentials {
	/** `MAPLE_PLANETSCALE_API_BASE_URL`, without the `/v1` prefix. */
	readonly apiBaseUrl: string
	/** The organization's slug, as in `app.planetscale.com/<organization>`. */
	readonly organization: string
	/** The org's OAuth access token, sent as `Authorization: Bearer <token>`. */
	readonly accessToken: Redacted.Redacted
}

/**
 * `unauthorized` (401): the access token is not live. `forbidden` (403): the grant lacks
 * `read_invoices`. `not_found` (404): the grant cannot see the organization. `too_large`: more
 * pages than a read takes. `timed_out`: the caller's bound on the read ran out.
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
			"timed_out",
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

/**
 * Dollars. PlanetScale sends a decimal string; a bare number is read the same way. A blank string
 * is refused: read as a number it would be zero, and the line would vanish.
 */
const Dollars = Schema.Union([
	Schema.Finite,
	Schema.String.check(Schema.isPattern(/\d/, { description: "Expected a decimal amount" })).pipe(
		Schema.decodeTo(Schema.Finite, SchemaTransformation.numberFromString),
	),
])

/** One billing period: a calendar month, `billing_period_end` exclusive (the next month's first). */
export const Invoice = Schema.Struct({
	id: Schema.String,
	billing_period_start: Schema.DateTimeUtcFromString,
	billing_period_end: Schema.DateTimeUtcFromString,
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

const STATUS_BY_TAG: Record<string, number> = Rec.fromEntries(
	Arr.map(Rec.toEntries(PlanetScale.HTTP_STATUS_MAP), ([status, error]) => [error.name, Number(status)]),
)

/** The status PlanetScale answered, or `undefined` when the request got no answer. */
const statusOf = (error: { readonly _tag: string; readonly status?: unknown }): number | undefined =>
	HttpClientError.isHttpClientError(error) && error.reason._tag === "StatusCodeError"
		? error.reason.response.status
		: typeof error.status === "number"
			? error.status
			: STATUS_BY_TAG[error._tag]

/** The SDK reads a 3xx body as an answer; a redirect fails here instead, with its status. */
const refuseRedirects = HttpClient.filterStatus((status) => status < 300 || status >= 400)

/**
 * One page through the SDK, its answer decoded by `schema`: the SDK does not check the bodies it
 * returns. Its retries are off, since a read that fails is re-run by the next sync.
 */
const getPage =
	<A, I>(schema: Schema.Codec<Page<A>, I>, what: string) =>
	(
		httpClient: HttpClient.HttpClient,
		credentials: PlanetScaleInvoiceCredentials,
		operation: Effect.Effect<unknown, { readonly _tag: string }, PlanetScale.PlanetScaleOpContext>,
	): Effect.Effect<Page<A>, PlanetScaleInvoiceApiError> =>
		operation.pipe(
			Effect.mapError((error) => {
				const status = statusOf(error)
				if (error._tag === "PlanetScaleParseError") {
					return failed("invalid_response", 200, `PlanetScale's ${what} answer could not be read.`)
				}
				// The transport's own message can hold the request; it is never repeated.
				return status === undefined
					? failed("upstream", 0, `PlanetScale did not answer the ${what} request.`)
					: failed(
							reasonOfStatus(status),
							status,
							`PlanetScale answered ${status} to the ${what} request.`,
						)
			}),
			Effect.flatMap((body) =>
				Schema.decodeUnknownEffect(schema)(body).pipe(
					Effect.mapError(() =>
						failed("invalid_response", 200, `PlanetScale's ${what} answer could not be read.`),
					),
				),
			),
			// The token is per org, so this cannot be hoisted into the static service graph.
			Effect.provide([
				PlanetScale.fromOAuth({
					accessToken: credentials.accessToken,
					organization: credentials.organization,
					apiBaseUrl: `${Str.replace(/\/$/, "")(credentials.apiBaseUrl)}/v1`,
				}),
				Layer.succeed(HttpClient.HttpClient, refuseRedirects(httpClient)),
				Layer.succeed(PlanetScale.Retry.Retry, { while: () => false }),
			]),
			// A redirect is not PlanetScale answering: the token is never followed to another host.
			Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
			// Only an answer Maple cannot read fails the span; a refusal is the caller's to judge.
			VendorHttp.vendorSdkRequestSpan(
				"PlanetScaleInvoices.request",
				"planetscale",
				(error: PlanetScaleInvoiceApiError) =>
					error.reason === "invalid_response" ? undefined : error.reason,
			),
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
		(page) =>
			getInvoicePage(
				httpClient,
				credentials,
				PlanetScale.listInvoices({
					organization: credentials.organization,
					per_page: INVOICES_PER_PAGE,
					page,
				}),
			),
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
				PlanetScale.getInvoiceLineItems({
					organization: credentials.organization,
					id: invoiceId,
					per_page: LINE_ITEMS_PER_PAGE,
					page,
				}),
			),
		MAX_LINE_ITEM_PAGES,
		"invoice line items",
		enough,
	)

/** `read`, failed as `timed_out` when it has not answered within `duration`. */
export const withinTime =
	(duration: Duration.Input) =>
	<A>(read: Effect.Effect<A, PlanetScaleInvoiceApiError>): Effect.Effect<A, PlanetScaleInvoiceApiError> =>
		Effect.timeoutOrElse(read, {
			duration,
			orElse: () => Effect.fail(failed("timed_out", 0, "PlanetScale took too long to answer.")),
		})
