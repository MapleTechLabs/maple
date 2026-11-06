import type {
	UserDetailRequest,
	UsersFacetsRequest,
	UsersGroupsRequest,
	UsersListRequest,
} from "@maple/domain/http"
import { Context, Effect, Layer } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import {
	readUserActivity,
	readUserIssues,
	readUserLogs,
	readUserOverview,
	readUserProfile,
	readUserTraces,
	readUsersFacets,
	readUsersGroups,
	readUsersList,
} from "./users-reads"

// The one entry point to the users reads (dashboard handler, v2 API, MCP tools): the warehouse and
// the database are captured here, so a call needs only its tenant and request.
const make = Effect.gen(function* () {
	const warehouse = yield* WarehouseQueryService
	const database = yield* Database
	const provide = <A, E>(read: Effect.Effect<A, E, WarehouseQueryService | Database>) =>
		read.pipe(
			Effect.provideService(WarehouseQueryService, warehouse),
			Effect.provideService(Database, database),
		)
	return {
		list: (tenant: TenantContext, request: UsersListRequest) => provide(readUsersList(tenant, request)),
		groups: (tenant: TenantContext, request: UsersGroupsRequest) =>
			provide(readUsersGroups(tenant, request)),
		facets: (tenant: TenantContext, request: UsersFacetsRequest) =>
			provide(readUsersFacets(tenant, request)),
		overview: (tenant: TenantContext, request: UserDetailRequest) =>
			provide(readUserOverview(tenant, request)),
		profile: (tenant: TenantContext, request: UserDetailRequest) =>
			provide(readUserProfile(tenant, request)),
		activity: (tenant: TenantContext, request: UserDetailRequest) =>
			provide(readUserActivity(tenant, request)),
		issues: (tenant: TenantContext, request: UserDetailRequest) =>
			provide(readUserIssues(tenant, request)),
		traces: (tenant: TenantContext, request: UserDetailRequest) =>
			provide(readUserTraces(tenant, request)),
		logs: (tenant: TenantContext, request: UserDetailRequest) => provide(readUserLogs(tenant, request)),
	}
})

export class UsersReadService extends Context.Service<UsersReadService>()(
	"@maple/backend/services/users/UsersReadService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
