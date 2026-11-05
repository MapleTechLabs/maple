import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, DependencyScanForbiddenError, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import * as Policy from "@maple/domain/policy"
import { DependencyScanService } from "@maple/backend/services/dependency-scan/DependencyScanService"

export const HttpDependencyScanLive = HttpApiBuilder.group(MapleInternalApi, "dependencyScan", (handlers) =>
	Effect.gen(function* () {
		const scans = yield* DependencyScanService

		return handlers
			.handle("listRepositories", () =>
				Effect.flatMap(CurrentTenant.Context, (tenant) => scans.listRepositories(tenant)),
			)
			.handle("scanRepository", ({ params }) =>
				Effect.flatMap(CurrentTenant.Context, (tenant) =>
					scans.requestScan(tenant.orgId, params.repositoryId),
				),
			)
			.handle("listFindings", ({ query }) =>
				Effect.flatMap(CurrentTenant.Context, (tenant) => scans.listFindings(tenant, query)),
			)
			.handle("updateFinding", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// Triage, like the code audit's, needs security:manage (engineers and admins).
					yield* Policy.check(
						tenant.roles,
						"security:manage",
						(denial) =>
							new DependencyScanForbiddenError({
								message: denial.message,
							}),
					)
					return yield* scans.updateFinding(tenant.orgId, tenant.userId, params.findingId, payload)
				}),
			)
	}),
)
