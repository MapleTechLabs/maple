import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Option, Redacted } from "effect"
import { HttpRouter } from "effect/http"
import { GoogleAdsConversionsPassword } from "@maple/infra/secrets"
import { AdConversionsService } from "@maple/backend/services/ad-conversions/AdConversionsService"
import { OrganizationRegionService } from "@maple/backend/services/org/OrganizationRegionService"
import { GOOGLE_ADS_CONVERSIONS_PATH, GoogleAdsConversionsRoute } from "./google-ads-conversions.http"

const PASSWORD = "s3cret-for-google"

const conversions = Layer.mock(AdConversionsService)({
	listForExport: () =>
		Effect.succeed([
			{ conversion: "signup", clickType: "gclid", clickId: "Cj0K_ada", convertedAt: 1_764_000_000_000 },
		]),
})

const handlerFor = (password: Option.Option<string>, region: "us" | "eu" = "us") =>
	HttpRouter.toWebHandler(
		GoogleAdsConversionsRoute.pipe(
			Layer.provide(conversions),
			Layer.provide(
				Layer.succeed(OrganizationRegionService, {
					region,
					ensureServedHere: () => Effect.void,
					servedHere: () => Effect.succeed("here"),
					forget: () => Effect.void,
				}),
			),
			Layer.provide(
				Layer.succeed(
					GoogleAdsConversionsPassword,
					Option.map(password, (v) => Redacted.make(v)),
				),
			),
		),
		{ disableLogger: true },
	)

const basic = (user: string, password: string) => `Basic ${btoa(`${user}:${password}`)}`

const get = (
	handler: (request: Request, context: Context.Context<never>) => Promise<Response>,
	authorization?: string,
) =>
	Effect.promise(() =>
		handler(
			new Request(`http://api.localhost${GOOGLE_ADS_CONVERSIONS_PATH}`, {
				headers: authorization === undefined ? {} : { authorization },
			}),
			Context.empty(),
		),
	)

describe("GoogleAdsConversionsRouter", () => {
	it.live("serves the CSV to Google's username and password only", () =>
		Effect.gen(function* () {
			const { handler, dispose } = handlerFor(Option.some(PASSWORD))
			yield* Effect.gen(function* () {
				const missing = yield* get(handler)
				assert.strictEqual(missing.status, 401)
				assert.strictEqual(missing.headers.get("www-authenticate"), 'Basic realm="maple"')
				assert.strictEqual((yield* get(handler, basic("google-ads", "wrong"))).status, 401)
				assert.strictEqual((yield* get(handler, basic("someone", PASSWORD))).status, 401)
				assert.strictEqual((yield* get(handler, "Basic !!not-base64")).status, 401)
				assert.strictEqual((yield* get(handler, `Bearer ${PASSWORD}`)).status, 401)

				const ok = yield* get(handler, basic("google-ads", PASSWORD))
				assert.strictEqual(ok.status, 200)
				assert.include(ok.headers.get("content-type") ?? "", "text/csv")
				assert.strictEqual(ok.headers.get("cache-control"), "no-store")
				assert.include(
					yield* Effect.promise(() => ok.text()),
					"Cj0K_ada,Sign-up (server),2025-11-24 16:00:00+0000,,",
				)
			}).pipe(Effect.ensuring(Effect.promise(dispose)))
		}),
	)

	it.live("503s while the password is unset and 404s outside the default region", () =>
		Effect.gen(function* () {
			const unset = handlerFor(Option.none())
			assert.strictEqual((yield* get(unset.handler, basic("google-ads", PASSWORD))).status, 503)
			yield* Effect.promise(unset.dispose)
			const eu = handlerFor(Option.some(PASSWORD), "eu")
			assert.strictEqual((yield* get(eu.handler, basic("google-ads", PASSWORD))).status, 404)
			yield* Effect.promise(eu.dispose)
		}),
	)
})
