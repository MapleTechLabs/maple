import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect, Option, Redacted } from "effect"
import { autumnHandler, type CustomerData } from "autumn-js/backend"
import { Env } from "../lib/Env"
import { AuthService } from "../services/AuthService"

export const AutumnRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const env = yield* Env
		const authService = yield* AuthService
		const secretKey = Option.match(env.AUTUMN_SECRET_KEY, {
			onNone: () => undefined,
			onSome: (value) => Redacted.value(value),
		})
		if (!secretKey) return

		// Routes that actually drive checkout / create a paid subscription. We
		// enrich only these with customerData (email, org name, fingerprint,
		// metadata) resolved from Clerk, so the customer record is identified
		// before checkout and Stripe pre-fills the buyer's email.
		//
		// Deliberately NOT enriched: `getOrCreateCustomer` (fired on every page
		// load via useCustomer() — the hot path), the `preview*` routes (price
		// previews only, no customer mutation), and read-only/listing routes.
		// These are user-initiated billing actions, so the extra Clerk lookups
		// stay off hot paths and only run when someone is genuinely paying.
		const ENRICHED_ROUTES = new Set(["attach", "multiAttach", "setupPayment", "updateSubscription"])

		const handle = (route: string) => (req: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				const tenant = yield* authService.resolveTenant(req.headers as Record<string, string>)

				const body = yield* req.json

				let customerData: CustomerData | undefined
				if (ENRICHED_ROUTES.has(route)) {
					const { email, orgName } = yield* authService.getCustomerData(tenant)
					if (email || orgName) {
						customerData = {
							email,
							name: orgName,
							fingerprint: tenant.orgId,
							metadata: { maple_user_id: String(tenant.userId), maple_user_email: email },
						}
					}
				}

				const result = yield* Effect.tryPromise(() =>
					autumnHandler({
						request: { url: req.url, method: req.method, body },
						customerId: tenant.orgId,
						customerData,
						clientOptions: { secretKey },
					}),
				)

				return yield* HttpServerResponse.json(result.response, {
					status: result.statusCode,
				})
			})

		const routes = [
			"getOrCreateCustomer",
			"attach",
			"previewAttach",
			"updateSubscription",
			"previewUpdateSubscription",
			"openCustomerPortal",
			"createReferralCode",
			"redeemReferralCode",
			"multiAttach",
			"previewMultiAttach",
			"setupPayment",
			"listPlans",
			"listEvents",
			"aggregateEvents",
		] as const

		for (const route of routes) {
			yield* router.add("POST", `/api/autumn/${route}`, handle(route))
		}
	}),
)
