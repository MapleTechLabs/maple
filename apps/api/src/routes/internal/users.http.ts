import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { readUsersFacets, readUsersList } from "@maple/backend/services/users/users-reads"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"

/** The users directory's reads (`/users`), scoped by `CurrentTenant`; the reads and their spans live in `users-reads`. */
const withTenant =
	<Payload, A, E, R>(read: (tenant: TenantContext, payload: Payload) => Effect.Effect<A, E, R>) =>
	({ payload }: { readonly payload: Payload }) =>
		Effect.flatMap(CurrentTenant.Context, (tenant) => read(tenant, payload))

export const HttpUsersInternalLive = HttpApiBuilder.group(MapleInternalApi, "usersInternal", (handlers) =>
	handlers.handle("list", withTenant(readUsersList)).handle("facets", withTenant(readUsersFacets)),
)
