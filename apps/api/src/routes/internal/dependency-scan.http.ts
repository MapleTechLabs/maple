import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, DependencyScanForbiddenError, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { requireAdmin } from "@maple/backend/services/auth/auth"
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
					// Triage, like the code audit's, is an admin's call.
					yield* requireAdmin(
						tenant.roles,
						() =>
							new DependencyScanForbiddenError({
								message: "Only org admins can triage findings",
							}),
					)
					return yield* scans.updateFinding(tenant.orgId, tenant.userId, params.findingId, payload)
				}),
			)
	}),
)
