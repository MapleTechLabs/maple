import type { BillingCustomer } from "@maple/domain/http"
import { Context, Deferred, Effect, Layer, Option, SynchronizedRef } from "effect"
import { MapleInternalApiClient } from "../platform/api-clients"

type Customer = BillingCustomer
type Entry<A> = Readonly<{ orgId: string | null; result: Deferred.Deferred<A, unknown> }>

export interface GetOptions {
	readonly refresh?: boolean
	/** The org the answer is for; without it, the org last asked for (the root's plan gate names it). */
	readonly orgId?: string
}

/** One shared `load` per org; a reader that names no org reads under the org last asked for. */
export const orgLoader = <A>(load: Effect.Effect<A, unknown>) =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope
		const current = yield* SynchronizedRef.make(Option.none<Entry<A>>())
		const entryFor = (options: GetOptions | undefined) =>
			SynchronizedRef.modifyEffect(current, (existing) => {
				const orgId = options?.orgId ?? Option.getOrNull(existing)?.orgId ?? null
				if (options?.refresh !== true && Option.isSome(existing) && existing.value.orgId === orgId)
					return Effect.succeed([existing.value, existing] as const)
				return Effect.gen(function* () {
					const result = yield* Deferred.make<A, unknown>()
					yield* Effect.forkIn(Deferred.complete(result, load), scope)
					const entry: Entry<A> = { orgId, result }
					return [entry, Option.some(entry)] as const
				})
			})
		return (options?: GetOptions) =>
			Effect.flatMap(entryFor(options), (entry) => Deferred.await(entry.result))
	})

/**
 * `billingCustomerAtom`: one `GET /internal/billing/customer` per org, shared by the root's plan
 * gate, `/settings` and `/integrations`. `refresh` is the atom's reactivity key: a plan change, a
 * cap save or Retry reads it again.
 */
export class BillingCustomerCache extends Context.Service<
	BillingCustomerCache,
	{ readonly get: (options?: GetOptions) => Effect.Effect<Customer, unknown> }
>()("@maple/web/BillingCustomerCache") {
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return { get: yield* orgLoader(client.billing.getCustomer()) }
		}),
	).pipe(Layer.provide(MapleInternalApiClient.layer))
}
