import { Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { describe, expect, it } from "vitest"
import { PlansListResponse, loadPlans, resolveOffer } from "./pricing-offer"

/** A `POST /v1/plans.list` body as Autumn returns it (trimmed of fields the offer ignores). */
const recorded = {
	list: [
		{
			id: "startup",
			name: "Startup",
			description: null,
			group: null,
			version: 3,
			add_on: false,
			auto_enable: false,
			price: { amount: 49, interval: "month" },
			free_trial: { duration_length: 7, duration_type: "day", card_required: false },
			items: [
				{
					feature_id: "traces",
					feature: { id: "traces", name: "traces", type: "metered" },
					included: 50,
					unlimited: false,
					pooled: false,
					reset: null,
					price: {
						amount: 0.25,
						interval: "month",
						billing_units: 1,
						billing_method: "usage_based",
						max_purchase: null,
					},
				},
				{
					feature_id: "logs",
					included: 50,
					unlimited: false,
					pooled: false,
					reset: null,
					price: {
						amount: 0.25,
						interval: "month",
						billing_units: 1,
						billing_method: "usage_based",
						max_purchase: null,
					},
				},
				{
					feature_id: "product_events",
					included: 1000000,
					unlimited: false,
					pooled: false,
					reset: null,
					price: {
						amount: 0.005,
						interval: "month",
						billing_units: 1000,
						billing_method: "usage_based",
						max_purchase: null,
					},
				},
				{
					feature_id: "seats",
					included: 0,
					unlimited: true,
					pooled: false,
					reset: null,
					price: null,
				},
			],
			created_at: 1730000000000,
			env: "live",
			archived: false,
			metadata: {},
			base_variant_id: null,
		},
		{ id: "extra", name: "Extra", add_on: true, price: { amount: 5, interval: "month" }, items: [] },
	],
}

const clientReplying = (
	status: number,
	body: unknown,
	seen: Array<HttpClientRequest.HttpClientRequest> = [],
) =>
	Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request) => {
			seen.push(request)
			return Effect.succeed(
				HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status })),
			)
		}),
	)

describe("pricing offer", () => {
	it("reads the offer from a recorded plans.list response, skipping add-ons and unadvertised items", () => {
		const offer = resolveOffer(Option.some(Schema.decodeSync(PlansListResponse)(recorded)))
		expect(offer.name).toBe("Startup")
		expect(offer.price).toBe(49)
		expect(offer.interval).toBe("/month")
		expect(offer.trialDuration).toBe(7)
		expect(offer.allotments.map((a) => [a.featureId, a.included, a.rate, a.rateUnits])).toEqual([
			["logs", 50, 0.25, 1],
			["traces", 50, 0.25, 1],
			["product_events", 1_000_000, 5, 1_000_000],
		])
	})

	it("posts to plans.list with the bearer key and the pinned api version", async () => {
		const seen: Array<HttpClientRequest.HttpClientRequest> = []
		const plans = await Effect.runPromise(
			loadPlans("sk_test").pipe(Effect.provide(clientReplying(200, recorded, seen))),
		)
		expect(Option.map(plans, (p) => p.list.length)).toEqual(Option.some(2))
		expect(
			seen.map((r) => [r.method, r.url, r.headers.authorization, r.headers["x-api-version"]]),
		).toEqual([["POST", "https://api.useautumn.com/v1/plans.list", "Bearer sk_test", "2.3.0"]])
	})

	it("falls back to the mirror when Autumn errors", async () => {
		const plans = await Effect.runPromise(
			loadPlans("sk_test").pipe(Effect.provide(clientReplying(503, {}))),
		)
		expect(Option.isNone(plans)).toBe(true)
		const offer = resolveOffer(plans)
		expect([offer.name, offer.price, offer.interval, offer.trialDuration]).toEqual([
			"Startup",
			39,
			"/month",
			14,
		])
		expect(offer.allotments.map((a) => a.featureId)).toEqual([
			"logs",
			"traces",
			"metrics",
			"browser_sessions",
			"product_events",
			"ai_credits",
		])
	})

	it("falls back without a request when the secret key is missing", async () => {
		const seen: Array<HttpClientRequest.HttpClientRequest> = []
		const plans = await Effect.runPromise(
			loadPlans(undefined).pipe(Effect.provide(clientReplying(200, recorded, seen))),
		)
		expect(Option.isNone(plans)).toBe(true)
		expect(seen).toEqual([])
	})
})
