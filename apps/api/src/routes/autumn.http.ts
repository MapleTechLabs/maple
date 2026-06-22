import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Effect, Option, Redacted, Schema } from "effect"
import { autumnHandler, type CustomerData } from "autumn-js/backend"
import { EdgeCacheService, type EdgeCacheServiceShape } from "@maple/query-engine/caching"
import { Env } from "../lib/Env"
import { AuthService } from "../services/AuthService"

type AutumnResult = Awaited<ReturnType<typeof autumnHandler>>

/**
 * Sentinel used to keep non-200 Autumn responses out of the edge cache: the
 * compute Effect fails with this so `getOrCompute` never stores the value, and
 * the caller immediately recovers it back into the normal response path. The
 * struct field mirrors `AutumnHandlerResult` so `.result` stays typed without a
 * cast (it is never serialized — caught immediately).
 */
class UncacheableAutumnResult extends Schema.TaggedErrorClass<UncacheableAutumnResult>()(
	"@maple/api/autumn/UncacheableAutumnResult",
	{
		result: Schema.Struct({ statusCode: Schema.Number, response: Schema.Unknown }),
	},
) {}

// getOrCreateCustomer fires on every page load (the hot path) and its latency is
// dominated by the upstream Autumn API call. Cache its success response per org
// for 5 minutes behind the shared edge cache (Workers Cache; single-flight dedup
// collapses concurrent misses into one upstream call).
export const CUSTOMER_CACHE_BUCKET = "autumn-customer"
export const CUSTOMER_CACHE_TTL_SECONDS = 300

/**
 * Run `getOrCreateCustomer` through the per-org edge cache. Only 200 responses
 * are cached — anything else (Autumn error / transient) fails the compute via a
 * sentinel so `getOrCompute` never stores it, and is then recovered so the
 * caller still gets the real response. Returns the resolved result plus whether
 * it came from the cache (for span annotation). Exported for unit tests.
 */
export const readCustomerCached = (
	edgeCache: Pick<EdgeCacheServiceShape, "getOrCompute">,
	orgId: string,
	runAutumn: Effect.Effect<AutumnResult, Error>,
): Effect.Effect<{ readonly result: AutumnResult; readonly hit: boolean }, Error> =>
	edgeCache
		.getOrCompute(
			{ bucket: CUSTOMER_CACHE_BUCKET, key: orgId, ttlSeconds: CUSTOMER_CACHE_TTL_SECONDS },
			runAutumn.pipe(
				Effect.flatMap((res) =>
					res.statusCode === 200
						? Effect.succeed(res)
						: Effect.fail(new UncacheableAutumnResult({ result: res })),
				),
			),
		)
		.pipe(
			Effect.map((cached) => ({ result: cached.value, hit: cached.hit })),
			Effect.catchTag("@maple/api/autumn/UncacheableAutumnResult", (error) =>
				Effect.succeed({ result: error.result, hit: false }),
			),
		)

export const AutumnRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const env = yield* Env
		const authService = yield* AuthService
		const edgeCache = yield* EdgeCacheService
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

		// User-initiated routes that change the customer / subscription, so the
		// cached getOrCreateCustomer response must be evicted afterwards. NOTE:
		// caches.default is per-colo and best-effort — the acting user's mutation
		// and their immediate refetch normally hit the same colo (fresh at once),
		// but another org member or a different colo may see up to the 5-minute TTL
		// of staleness. That's acceptable for billing display/gating; hard limit
		// enforcement runs separately in the ingest gateway via Autumn /v1/check.
		const MUTATION_ROUTES = new Set([
			"attach",
			"multiAttach",
			"setupPayment",
			"updateSubscription",
			"redeemReferralCode",
			"openCustomerPortal",
		])

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

				const runAutumn = Effect.tryPromise({
					try: () =>
						autumnHandler({
							request: { url: req.url, method: req.method, body },
							customerId: Option.getOrUndefined(tenant)?.orgId,
							customerData,
							clientOptions: { secretKey },
						}),
					catch: (error) => (error instanceof Error ? error : new Error(String(error))),
				})

				let result: AutumnResult
				let cacheHit = false
				if (route === "getOrCreateCustomer" && Option.isSome(tenant)) {
					const outcome = yield* readCustomerCached(edgeCache, tenant.value.orgId, runAutumn)
					result = outcome.result
					cacheHit = outcome.hit
				} else {
					result = yield* runAutumn
				}

				yield* Effect.annotateCurrentSpan({
					"autumn.route": route,
					"cache.hit": cacheHit,
					...(Option.isSome(tenant) ? { orgId: tenant.value.orgId } : {}),
				})

				// Evict the cached customer after a successful billing mutation so the
				// next getOrCreateCustomer recomputes instead of serving pre-mutation
				// state. Same { bucket, key } as the read above.
				if (MUTATION_ROUTES.has(route) && Option.isSome(tenant) && result.statusCode === 200) {
					yield* edgeCache.invalidate({
						bucket: CUSTOMER_CACHE_BUCKET,
						key: tenant.value.orgId,
					})
				}

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
