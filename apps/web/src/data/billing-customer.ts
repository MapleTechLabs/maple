import type { BillingCustomer } from "@maple/domain/http"
import { Context, Deferred, Effect, Layer, Option, SynchronizedRef } from "effect"
import { MapleInternalApiClient } from "../platform/api-clients"
import { SessionBearer } from "../platform/session-bearer"

type Customer = BillingCustomer
type Entry = Readonly<{ token: Option.Option<string>; result: Deferred.Deferred<Customer, unknown> }>

const sameToken = (a: Option.Option<string>, b: Option.Option<string>): boolean =>
	Option.getOrNull(a) === Option.getOrNull(b)

/**
 * `billingCustomerAtom`: one `GET /internal/billing/customer` per session token (so per org), shared
 * by the root's plan gate, `/settings` and `/integrations`. `refresh` is
 * the atom's reactivity key: a plan change, a cap save or Retry reads it again.
 */
export class BillingCustomerCache extends Context.Service<
	BillingCustomerCache,
	{ readonly get: (options?: Readonly<{ refresh?: boolean }>) => Effect.Effect<Customer, unknown> }
>()("@maple/web/BillingCustomerCache") {
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const bearer = yield* SessionBearer
			const scope = yield* Effect.scope
			const current = yield* SynchronizedRef.make(Option.none<Entry>())

			const entryFor = (token: Option.Option<string>, refresh: boolean) =>
				SynchronizedRef.modifyEffect(current, (existing) => {
					if (!refresh && Option.isSome(existing) && sameToken(existing.value.token, token))
						return Effect.succeed([existing.value, existing] as const)
					return Effect.gen(function* () {
						const result = yield* Deferred.make<Customer, unknown>()
						yield* Effect.forkIn(Deferred.complete(result, client.billing.getCustomer()), scope)
						const entry: Entry = { token, result }
						return [entry, Option.some(entry)] as const
					})
				})

			return {
				get: (options) =>
					Effect.flatMap(bearer.token, (token) =>
						Effect.flatMap(entryFor(token, options?.refresh === true), (entry) =>
							Deferred.await(entry.result),
						),
					),
			}
		}),
	).pipe(Layer.provide([MapleInternalApiClient.layer, SessionBearer.layer]))
}
