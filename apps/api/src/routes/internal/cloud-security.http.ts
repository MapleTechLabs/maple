import { HttpApiBuilder } from "effect/http-api"
import { CloudSecurityForbiddenError, CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { CloudSecurityReadService } from "@maple/backend/services/cloud-security/CloudSecurityReadService"
import { Effect } from "effect"

/** The caller's tenant, once they hold `security:manage`, as every Security Center read requires. */
const cloudSecurityTenant = Effect.tap(CurrentTenant.Context, (tenant) =>
	Policy.check(
		tenant.roles,
		"security:manage",
		(denial) => new CloudSecurityForbiddenError({ message: denial.message }),
	),
)

// The Security hub's Cloud tab. The service gates on the `cloudSecurity` rollout; every endpoint reads.
export const HttpCloudSecurityLive = HttpApiBuilder.group(MapleInternalApi, "cloudSecurity", (handlers) =>
	Effect.gen(function* () {
		const reads = yield* CloudSecurityReadService
		return handlers
			.handle("overview", () => Effect.flatMap(cloudSecurityTenant, (tenant) => reads.overview(tenant)))
			.handle("listFindings", ({ payload }) =>
				Effect.flatMap(cloudSecurityTenant, (tenant) => reads.listFindings(tenant, payload)),
			)
			.handle("finding", ({ query }) =>
				Effect.flatMap(cloudSecurityTenant, (tenant) => reads.finding(tenant, query)),
			)
	}),
)
