import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { UsersReadService } from "@maple/backend/services/users/UsersReadService"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"

/** The users pages' reads (`/users`, `/users/$userId`), scoped by `CurrentTenant`, through `UsersReadService`. */
const withTenant =
	<Payload, A, E>(read: (tenant: TenantContext, payload: Payload) => Effect.Effect<A, E>) =>
	({ payload }: { readonly payload: Payload }) =>
		Effect.flatMap(CurrentTenant.Context, (tenant) => read(tenant, payload))

export const HttpUsersInternalLive = HttpApiBuilder.group(MapleInternalApi, "usersInternal", (handlers) =>
	Effect.gen(function* () {
		const users = yield* UsersReadService
		return handlers
			.handle("list", withTenant(users.list))
			.handle("groups", withTenant(users.groups))
			.handle("facets", withTenant(users.facets))
			.handle("profile", withTenant(users.profile))
			.handle("activity", withTenant(users.activity))
			.handle("overview", withTenant(users.overview))
			.handle("traces", withTenant(users.traces))
			.handle("logs", withTenant(users.logs))
			.handle("issues", withTenant(users.issues))
	}),
)
