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

		// The plan catalog is global, not customer-specific (autumn-js marks
		// listPlans' customerId optional). Resolve the tenant optionally for it so a
		// transient onboarding token gap serves the catalog instead of a 401 —
		// authenticated callers still pass customerId and get per-customer eligibility.
		const PUBLIC_ROUTES = new Set(["listPlans"])

		const handle = (route: string) => (req: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				const headers = req.headers as Record<string, string>
				const tenant = PUBLIC_ROUTES.has(route)
					? yield* Effect.option(authService.resolveTenant(headers))
					: Option.some(yield* authService.resolveTenant(headers))

				const body = yield* req.json

				let customerData: CustomerData | undefined
				if (ENRICHED_ROUTES.has(route) && Option.isSome(tenant)) {
					const { email, orgName } = yield* authService.getCustomerData(tenant.value)
					if (email || orgName) {
						customerData = {
							email,
							name: orgName,
							fingerprint: tenant.value.orgId,
							metadata: { maple_user_id: String(tenant.value.userId), maple_user_email: email },
						}
					}
				}

				const result = yield* Effect.tryPromise({
					try: () =>
						autumnHandler({
							request: { url: req.url, method: req.method, body },
							customerId: Option.getOrUndefined(tenant)?.orgId,
							customerData,
							clientOptions: { secretKey },
						}),
					catch: (error) => (error instanceof Error ? error : new Error(String(error))),
				})

				return yield* HttpServerResponse.json(result.response, {
					status: result.statusCode,
				})
			}).pipe(
				// Never fall through to an empty-body 500: the Autumn SDK client
				// calls `.json()` on the response and throws "Unexpected end of JSON
				// input" on an empty body. `useCustomer()` fires getOrCreateCustomer
				// on every page load — including during sign-up before a Clerk org is
				// active, where resolveTenant raises UnauthorizedError — so always
				// return a JSON body with a sensible status.
				Effect.catch((error: unknown) => {
					const tag =
						typeof error === "object" && error !== null && "_tag" in error
							? (error as { _tag?: unknown })._tag
							: undefined
					const isUnauthorized = tag === "@maple/http/errors/UnauthorizedError"
					const message =
						typeof error === "object" && error !== null && "message" in error
							? String((error as { message?: unknown }).message)
							: String(error)
					const status = isUnauthorized ? 401 : 500
					return Effect.flatMap(
						isUnauthorized
							? Effect.void
							: Effect.logError("[autumn] handler failed", { route, error: message }),
						() => HttpServerResponse.json({ error: message }, { status }),
					)
				}),
			)

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

		yield* Effect.forEach(routes, (route) => router.add("POST", `/api/autumn/${route}`, handle(route)), {
			concurrency: 1,
			discard: true,
		})
	}),
)
