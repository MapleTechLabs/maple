import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Array as Arr, Record as Rec } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import {
	FAKE_PLANETSCALE_ORGANIZATION,
	FAKE_PLANETSCALE_TOKEN,
	FAKE_PLANETSCALE_TOKEN_ID,
	type FakePlanetScale,
	fakeInvoice,
	fakeLineItem,
	fakePlanetScaleFetch,
	makeFakePlanetScale,
} from "./fake-planetscale"
import {
	listInvoiceLineItems,
	listInvoices,
	type PlanetScaleInvoiceCredentials,
	serviceTokenAuthorization,
} from "./invoices-api"
import { readInvoicesOfWindow } from "./read-window"

const CREDENTIALS: PlanetScaleInvoiceCredentials = {
	organization: FAKE_PLANETSCALE_ORGANIZATION,
	authorization: serviceTokenAuthorization(FAKE_PLANETSCALE_TOKEN_ID, FAKE_PLANETSCALE_TOKEN),
}

const MONTHS = ["2026-11", "2026-10", "2026-09", "2026-08", "2026-07", "2026-06"] as const
const NEXT_MONTH = ["2026-12", "2026-11", "2026-10", "2026-09", "2026-08", "2026-07"] as const
/** Six months newest first, the newest still open, each with one line. */
const SIX_MONTHS = Arr.map(MONTHS, (month, index) => fakeInvoice(month, NEXT_MONTH[index] ?? "", index > 0))
const ONE_LINE_EACH = Rec.fromEntries(Arr.map(SIX_MONTHS, (invoice) => [invoice.id, [fakeLineItem()]]))

const run = <A, E>(world: FakePlanetScale, effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
	effect.pipe(
		Effect.provide(
			FetchHttpClient.layer.pipe(
				Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fakePlanetScaleFetch(world))),
			),
		),
	)

const withClient = <A, E>(use: (httpClient: HttpClient.HttpClient) => Effect.Effect<A, E>) =>
	Effect.flatMap(HttpClient.HttpClient, use)

describe("PlanetScale invoice API", () => {
	it.effect("lists invoices with the token as the whole Authorization header", () => {
		const world = makeFakePlanetScale({ invoices: SIX_MONTHS })
		return run(
			world,
			Effect.gen(function* () {
				const invoices = yield* withClient((httpClient) => listInvoices(httpClient, CREDENTIALS))
				assert.deepStrictEqual(
					Arr.map(invoices, (invoice) => [invoice.id, invoice.paid]),
					Arr.map(SIX_MONTHS, (invoice) => [invoice.id, invoice.paid]),
				)
				assert.deepStrictEqual(world.urls, ["/v1/organizations/acme/invoices?per_page=50&page=1"])
				assert.deepStrictEqual(world.authorizations, [
					`${FAKE_PLANETSCALE_TOKEN_ID}:${FAKE_PLANETSCALE_TOKEN}`,
				])
			}),
		)
	})

	it.effect("reads every page of an invoice's line items", () => {
		const lines = Arr.makeBy(5, (index) =>
			fakeLineItem({ id: `line_${index}`, subtotal: `${index + 1}.50` }),
		)
		const world = makeFakePlanetScale({
			invoices: SIX_MONTHS,
			lineItems: { "inv_2026-10": lines },
			maxPerPage: 2,
		})
		return run(
			world,
			Effect.gen(function* () {
				const read = yield* withClient((httpClient) =>
					listInvoiceLineItems(httpClient, CREDENTIALS, "inv_2026-10"),
				)
				assert.deepStrictEqual(
					Arr.map(read, (line) => [line.id, line.subtotal]),
					[
						["line_0", 1.5],
						["line_1", 2.5],
						["line_2", 3.5],
						["line_3", 4.5],
						["line_4", 5.5],
					],
				)
				assert.deepStrictEqual(world.urls, [
					"/v1/organizations/acme/invoices/inv_2026-10/line-items?per_page=100&page=1",
					"/v1/organizations/acme/invoices/inv_2026-10/line-items?per_page=100&page=2",
					"/v1/organizations/acme/invoices/inv_2026-10/line-items?per_page=100&page=3",
				])
			}),
		)
	})

	it.effect("reads a window's invoices once each, and lists no further back than the window", () => {
		const world = makeFakePlanetScale({ invoices: SIX_MONTHS, lineItems: ONE_LINE_EACH, maxPerPage: 2 })
		return run(
			world,
			Effect.gen(function* () {
				const read = yield* withClient((httpClient) =>
					readInvoicesOfWindow(httpClient, CREDENTIALS, {
						startDay: "2026-09-20",
						endDay: "2026-10-03",
					}),
				)
				assert.deepStrictEqual(
					Arr.map(read, ({ invoice, lineItems }) => [invoice.id, lineItems.length]),
					[
						["inv_2026-10", 1],
						["inv_2026-09", 1],
					],
				)
				// Two list pages reach September; November bills no day of the window and is not read.
				assert.deepStrictEqual(world.urls, [
					"/v1/organizations/acme/invoices?per_page=50&page=1",
					"/v1/organizations/acme/invoices?per_page=50&page=2",
					"/v1/organizations/acme/invoices/inv_2026-10/line-items?per_page=100&page=1",
					"/v1/organizations/acme/invoices/inv_2026-09/line-items?per_page=100&page=1",
				])
			}),
		)
	})

	it.effect("reads nothing for a window older than the first invoice", () => {
		const world = makeFakePlanetScale({ invoices: SIX_MONTHS, lineItems: ONE_LINE_EACH })
		return run(
			world,
			Effect.gen(function* () {
				const read = yield* withClient((httpClient) =>
					readInvoicesOfWindow(httpClient, CREDENTIALS, {
						startDay: "2026-04-01",
						endDay: "2026-04-30",
					}),
				)
				assert.deepStrictEqual([read.length, world.urls.length], [0, 1])
			}),
		)
	})

	it.effect("names why PlanetScale refused, by status", () => {
		const world = makeFakePlanetScale({ invoices: SIX_MONTHS })
		return run(
			world,
			Effect.gen(function* () {
				const reasons = yield* Effect.forEach([401, 403, 404, 429, 502], (status) =>
					Effect.gen(function* () {
						world.invoicesStatus = status
						const error = yield* Effect.flip(
							withClient((httpClient) => listInvoices(httpClient, CREDENTIALS)),
						)
						return [error.reason, error.status]
					}),
				)
				assert.deepStrictEqual(reasons, [
					["unauthorized", 401],
					["forbidden", 403],
					["not_found", 404],
					["rate_limited", 429],
					["upstream", 502],
				])
			}),
		)
	})

	it.effect("answers not found for another organization or a token PlanetScale does not know", () => {
		const world = makeFakePlanetScale({ invoices: SIX_MONTHS })
		return run(
			world,
			Effect.gen(function* () {
				const reasons = yield* Effect.forEach(
					[
						{ ...CREDENTIALS, organization: "someone-else" },
						{ ...CREDENTIALS, authorization: serviceTokenAuthorization("tokenid0123", "wrong") },
					],
					(credentials) =>
						Effect.flip(withClient((httpClient) => listInvoices(httpClient, credentials))).pipe(
							Effect.map((error) => error.reason),
						),
				)
				assert.deepStrictEqual(reasons, ["not_found", "not_found"])
			}),
		)
	})

	it.effect("fails an answer it cannot read as invalid", () => {
		const world = makeFakePlanetScale({ invoices: "<html>maintenance</html>" })
		return run(
			world,
			Effect.gen(function* () {
				const list = withClient((httpClient) => listInvoices(httpClient, CREDENTIALS))
				assert.strictEqual((yield* Effect.flip(list)).reason, "invalid_response")
				// JSON, but no invoice: the period is not a time.
				world.invoices = [{ ...fakeInvoice("2026-10", "2026-11"), billing_period_end: "soon" }]
				assert.strictEqual((yield* Effect.flip(list)).reason, "invalid_response")
				world.invoices = SIX_MONTHS
				world.lineItems = { "inv_2026-10": [fakeLineItem({ subtotal: "a lot" })] }
				const lines = withClient((httpClient) =>
					listInvoiceLineItems(httpClient, CREDENTIALS, "inv_2026-10"),
				)
				assert.strictEqual((yield* Effect.flip(lines)).reason, "invalid_response")
			}),
		)
	})

	it.effect("refuses an invoice with more line items than a read takes, and returns no part of it", () => {
		const world = makeFakePlanetScale({
			lineItems: { "inv_2026-10": Arr.makeBy(201, (index) => fakeLineItem({ id: `line_${index}` })) },
			maxPerPage: 1,
		})
		return run(
			world,
			Effect.gen(function* () {
				const error = yield* Effect.flip(
					withClient((httpClient) => listInvoiceLineItems(httpClient, CREDENTIALS, "inv_2026-10")),
				)
				assert.deepStrictEqual([error.reason, world.urls.length], ["too_large", 200])
			}),
		)
	})
})
