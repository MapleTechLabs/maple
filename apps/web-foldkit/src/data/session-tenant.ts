import type { CurrentTenant } from "@maple/domain/http"
import { Context, Deferred, Effect, Layer, Option, SynchronizedRef } from "effect"
import { MapleApiClient } from "../platform/api-clients"
import { SessionBearer } from "../platform/session-bearer"

type Entry = Readonly<{ token: Option.Option<string>; result: Deferred.Deferred<CurrentTenant.TenantSchema, unknown> }>

const sameToken = (a: Option.Option<string>, b: Option.Option<string>): boolean =>
	Option.getOrNull(a) === Option.getOrNull(b)

/**
 * `retainedQuery("auth", "session", {})`: one `GET /api/auth/session` per session token, shared by
 * every reader (the shell's tenant lookup, the alerts pages' admin check), as one atom is in apps/web.
 */
export class SessionTenant extends Context.Service<
	SessionTenant,
	{ readonly get: Effect.Effect<CurrentTenant.TenantSchema, unknown> }
>()("@maple/web-foldkit/SessionTenant") {
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const client = yield* MapleApiClient
			const bearer = yield* SessionBearer
			const scope = yield* Effect.scope
			const current = yield* SynchronizedRef.make(Option.none<Entry>())

			const entryFor = (token: Option.Option<string>) =>
				SynchronizedRef.modifyEffect(current, (existing) => {
					if (Option.isSome(existing) && sameToken(existing.value.token, token))
						return Effect.succeed([existing.value, existing] as const)
					return Effect.gen(function* () {
						const result = yield* Deferred.make<CurrentTenant.TenantSchema, unknown>()
						yield* Effect.forkIn(Deferred.complete(result, client.auth.session()), scope)
						const entry: Entry = { token, result }
						return [entry, Option.some(entry)] as const
					})
				})

			return {
				get: Effect.flatMap(bearer.token, (token) =>
					Effect.flatMap(entryFor(token), (entry) => Deferred.await(entry.result)),
				),
			}
		}),
	).pipe(Layer.provide([MapleApiClient.layer, SessionBearer.layer]))
}
