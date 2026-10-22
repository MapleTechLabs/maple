import type { CurrentTenant } from "@maple/domain/http"
import { Context, Deferred, Effect, Layer, Option, type Scope, SynchronizedRef } from "effect"
import { MapleApiClient } from "../platform/api-clients"
import { SessionBearer } from "../platform/session-bearer"

type Tenant = CurrentTenant.TenantSchema
type Entry = Readonly<{ token: Option.Option<string>; result: Deferred.Deferred<Tenant, unknown> }>

const sameToken = (a: Option.Option<string>, b: Option.Option<string>): boolean =>
	Option.getOrNull(a) === Option.getOrNull(b)

/**
 * One read per session token, shared by every reader. A failed read is dropped once it settles,
 * so the next reader asks again rather than keeping the failure until the token renews.
 */
export const makeSessionTenantCache = (
	fetchTenant: Effect.Effect<Tenant, unknown>,
	token: Effect.Effect<Option.Option<string>>,
): Effect.Effect<{ readonly get: Effect.Effect<Tenant, unknown> }, never, Scope.Scope> =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope
		const current = yield* SynchronizedRef.make(Option.none<Entry>())

		const dropIfCurrent = (result: Entry["result"]) =>
			SynchronizedRef.update(current, (existing) =>
				Option.isSome(existing) && existing.value.result === result ? Option.none() : existing,
			)

		const entryFor = (forToken: Option.Option<string>) =>
			SynchronizedRef.modifyEffect(current, (existing) => {
				if (Option.isSome(existing) && sameToken(existing.value.token, forToken))
					return Effect.succeed([existing.value, existing] as const)
				return Effect.gen(function* () {
					const result = yield* Deferred.make<Tenant, unknown>()
					const read = fetchTenant.pipe(Effect.onError(() => dropIfCurrent(result)))
					yield* Effect.forkIn(Deferred.complete(result, read), scope)
					const entry: Entry = { token: forToken, result }
					return [entry, Option.some(entry)] as const
				})
			})

		return {
			get: Effect.flatMap(token, (forToken) =>
				Effect.flatMap(entryFor(forToken), (entry) => Deferred.await(entry.result)),
			),
		}
	})

/**
 * `retainedQuery("auth", "session", {})`: one `GET /api/auth/session` per session token, shared by
 * every reader (the shell's tenant lookup, the alerts pages' admin check).
 */
export class SessionTenant extends Context.Service<
	SessionTenant,
	{ readonly get: Effect.Effect<Tenant, unknown> }
>()("@maple/web/SessionTenant") {
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			const client = yield* MapleApiClient
			const bearer = yield* SessionBearer
			return yield* makeSessionTenantCache(client.auth.session(), bearer.token)
		}),
	).pipe(Layer.provide([MapleApiClient.layer, SessionBearer.layer]))
}

/** `useIsOrgAdmin()`: the session's roles allow org administration; `false` when it fails. */
export const readIsOrgAdmin = Effect.gen(function* () {
	const session = yield* (yield* SessionTenant).get
	return session.roles.some((role) => role === "root" || role === "org:admin")
}).pipe(Effect.orElseSucceed(() => false))
