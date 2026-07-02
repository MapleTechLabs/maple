import { autumnHandler, type CustomerData } from "autumn-js/backend"
import { Effect, Schema } from "effect"
import { BillingUpstreamError } from "@maple/domain/http"

// Shared, dependency-free primitives for speaking the internal `autumn-js/backend`
// contract. Extracted from billing.http.ts so non-HTTP callers (the billing
// reconcile cron, the Autumn webhook receiver) reuse the exact same call path
// instead of re-implementing it. The HTTP billing group still owns the per-org
// edge cache (`readCustomerCached`) — that stays in billing.http.ts.

export type AutumnResult = Awaited<ReturnType<typeof autumnHandler>>

// `autumnHandler` matches its route by `method` + `path`, always POST against
// `${DEFAULT_PATH_PREFIX}/${route}` (= /api/autumn/<route>) regardless of which
// Maple endpoint fronts it, so every call here speaks that internal contract.
export const AUTUMN_PATH_PREFIX = "/api/autumn"

export const makeCallAutumn =
	(secretKey: string | undefined) =>
	(
		route: string,
		body: unknown,
		customerId: string | undefined,
		customerData?: CustomerData,
	): Effect.Effect<AutumnResult, BillingUpstreamError> =>
		secretKey === undefined
			? Effect.fail(new BillingUpstreamError({ message: "Billing is not configured" }))
			: Effect.tryPromise({
					try: () =>
						autumnHandler({
							request: { url: `${AUTUMN_PATH_PREFIX}/${route}`, method: "POST", body },
							customerId,
							customerData,
							clientOptions: { secretKey },
						}),
					catch: (error) =>
						new BillingUpstreamError({
							message: error instanceof Error ? error.message : String(error),
						}),
				})

// Surface a readable message for a non-2xx Autumn response (it carries a
// `{ message }` / `{ error }` body) so the client error isn't an opaque 502.
const upstreamMessage = (result: AutumnResult): string => {
	const body = result.response as { message?: unknown; error?: unknown } | null
	const message = body?.message ?? body?.error
	return typeof message === "string" ? message : `Billing request failed (${result.statusCode})`
}

export const ensureOk = (result: AutumnResult): Effect.Effect<unknown, BillingUpstreamError> =>
	result.statusCode >= 200 && result.statusCode < 300
		? Effect.succeed(result.response)
		: Effect.fail(new BillingUpstreamError({ message: upstreamMessage(result) }))

export const decodeUpstream = <S extends Schema.Top>(
	schema: S,
	value: unknown,
): Effect.Effect<S["Type"], BillingUpstreamError, S["DecodingServices"]> =>
	Schema.decodeUnknownEffect(schema)(value).pipe(
		Effect.mapError(
			(error) => new BillingUpstreamError({ message: `Unexpected billing response: ${error}` }),
		),
	)
