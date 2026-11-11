import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, DependencyScanForbiddenError, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import * as Policy from "@maple/domain/policy"
import { DependencyScanService } from "@maple/backend/services/dependency-scan/DependencyScanService"

/** The caller's tenant, once they hold `security:manage`: the Security Center is for engineers and admins. */
const securityTenant = Effect.tap(CurrentTenant.Context, (tenant) =>
	Policy.check(
		tenant.roles,
		"security:manage",
		(denial) => new DependencyScanForbiddenError({ message: denial.message }),
	),
)

export const HttpDependencyScanLive = HttpApiBuilder.group(MapleInternalApi, "dependencyScan", (handlers) =>
	Effect.gen(function* () {
		const scans = yield* DependencyScanService

		return handlers
			.handle("listRepositories", () =>
				Effect.flatMap(securityTenant, (tenant) => scans.listRepositories(tenant)),
			)
			.handle("scanRepository", ({ params }) =>
				Effect.flatMap(securityTenant, (tenant) =>
					scans.requestScan(tenant.orgId, params.repositoryId),
				),
			)
			.handle("listFindings", ({ query }) =>
				Effect.flatMap(securityTenant, (tenant) => scans.listFindings(tenant, query)),
			)
			.handle("updateFinding", ({ params, payload }) =>
				Effect.flatMap(securityTenant, (tenant) =>
					scans.updateFinding(tenant.orgId, tenant.userId, params.findingId, payload),
				),
			)
	}),
)
