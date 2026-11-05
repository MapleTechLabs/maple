import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import {
	readUserActivity,
	readUserLogs,
	readUserProfile,
	readUserTraces,
	readUsersFacets,
	readUsersList,
} from "@maple/backend/services/users/users-reads"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"

/** The users pages' reads (`/users`, `/users/$userId`), scoped by `CurrentTenant`; the reads and their spans live in `users-reads`. */
const withTenant =
	<Payload, A, E, R>(read: (tenant: TenantContext, payload: Payload) => Effect.Effect<A, E, R>) =>
	({ payload }: { readonly payload: Payload }) =>
		Effect.flatMap(CurrentTenant.Context, (tenant) => read(tenant, payload))

export const HttpUsersInternalLive = HttpApiBuilder.group(MapleInternalApi, "usersInternal", (handlers) =>
	handlers
		.handle("list", withTenant(readUsersList))
		.handle("facets", withTenant(readUsersFacets))
		.handle("profile", withTenant(readUserProfile))
		.handle("activity", withTenant(readUserActivity))
		.handle("traces", withTenant(readUserTraces))
		.handle("logs", withTenant(readUserLogs)),
)
