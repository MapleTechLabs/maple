import type { BillingCustomer } from "@maple/domain/http"
import { Context, Deferred, Effect, Layer, Option, SynchronizedRef } from "effect"
import { MapleInternalApiClient } from "../platform/api-clients"

type Customer = BillingCustomer
type Entry<A, E> = Readonly<{ orgId: string | null; result: Deferred.Deferred<A, E> }>
type CustomerError = Effect.Error<ReturnType<MapleInternalApiClient["Service"]["billing"]["getCustomer"]>>

export interface GetOptions {
	readonly refresh?: boolean
	/** The org the answer is for; without it, the org last asked for (the root's plan gate names it). */
	readonly orgId?: string
}

/** One shared `load` per org; a reader that names no org reads under the org last asked for. */
export const orgLoader = <A, E>(load: Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope
		const current = yield* SynchronizedRef.make(Option.none<Entry<A, E>>())
		// A failed read is dropped once it settles, so the next reader asks again.
		const dropIfCurrent = (result: Entry<A, E>["result"]) =>
			SynchronizedRef.update(current, (existing) =>
				Option.isSome(existing) && existing.value.result === result ? Option.none() : existing,
			)
		const entryFor = (options: GetOptions | undefined) =>
			SynchronizedRef.modifyEffect(current, (existing) => {
				const orgId = options?.orgId ?? Option.getOrNull(existing)?.orgId ?? null
				if (options?.refresh !== true && Option.isSome(existing) && existing.value.orgId === orgId)
					return Effect.succeed([existing.value, existing] as const)
				return Effect.gen(function* () {
					const result = yield* Deferred.make<A, E>()
					const read = load.pipe(Effect.onError(() => dropIfCurrent(result)))
					yield* Effect.forkIn(Deferred.complete(result, read), scope)
					const entry: Entry<A, E> = { orgId, result }
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
	{ readonly get: (options?: GetOptions) => Effect.Effect<Customer, CustomerError> }
>()("@maple/web/BillingCustomerCache") {
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return { get: yield* orgLoader(client.billing.getCustomer()) }
		}),
	).pipe(Layer.provide(MapleInternalApiClient.layer))
}
