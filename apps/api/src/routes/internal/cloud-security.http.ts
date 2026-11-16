import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import { CloudSecurityReadService } from "@maple/backend/services/cloud-security/CloudSecurityReadService"
import { Effect } from "effect"

// The Security hub's Cloud tab. The service gates on the `cloudSecurity` rollout; every endpoint reads.
export const HttpCloudSecurityLive = HttpApiBuilder.group(MapleInternalApi, "cloudSecurity", (handlers) =>
	Effect.gen(function* () {
		const reads = yield* CloudSecurityReadService
		return handlers
			.handle("overview", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* reads.overview(tenant)
				}),
			)
			.handle("listFindings", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* reads.listFindings(tenant, payload)
				}),
			)
			.handle("finding", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* reads.finding(tenant, query)
				}),
			)
	}),
)
