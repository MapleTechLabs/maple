import { HttpApiBuilder } from "effect/http-api"
import {
	CurrentTenant,
	IntegrationsForbiddenError,
	MapleInternalApi,
	PlanetScaleCostSourceAdded,
	PlanetScaleCostSourceRemoved,
	PlanetScaleCostStatus,
} from "@maple/domain/http"
import { Effect } from "effect"
import * as Policy from "@maple/domain/policy"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { PlanetScaleCostSourceService } from "@maple/backend/services/cost/PlanetScaleCostSourceService"

// A cost source is a connection like any other: the role that manages integrations manages it.
const requireIntegrationsManager = (roles: CurrentTenant.TenantSchema["roles"]) =>
	Policy.check(
		roles,
		"integrations:manage",
		(denial) => new IntegrationsForbiddenError({ message: denial.message }),
	)

export const HttpPlanetScaleCostLive = HttpApiBuilder.group(MapleInternalApi, "planetScaleCost", (handlers) =>
	Effect.gen(function* () {
		const sources = yield* PlanetScaleCostSourceService

		return handlers
			.handle("status", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const status = yield* sources.status(tenant.orgId)
					return new PlanetScaleCostStatus(status)
				}).pipe(Effect.withSpan("HttpPlanetScaleCost.status")),
			)
			.handle("add", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireIntegrationsManager(tenant.roles)
					const added = yield* sources.add(tenant.orgId, payload.organization)
					// Adding what is a source already changed nothing, so it leaves no entry.
					if (added.created) {
						yield* recordHttpAudit("cost_source.created", {
							metadata: { provider: "planetscale", account: added.organization },
						})
					}
					return new PlanetScaleCostSourceAdded({ organization: added.organization })
				}).pipe(Effect.withSpan("HttpPlanetScaleCost.add")),
			)
			.handle("remove", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireIntegrationsManager(tenant.roles)
					const removed = yield* sources.remove(tenant.orgId)
					// Removing what is not there changed nothing, so it leaves no entry.
					if (removed.removed) {
						yield* recordHttpAudit("cost_source.deleted", {
							metadata: { provider: "planetscale" },
						})
					}
					return new PlanetScaleCostSourceRemoved(removed)
				}).pipe(Effect.withSpan("HttpPlanetScaleCost.remove")),
			)
	}),
)
