import { HttpApiBuilder } from "effect/http-api"
import {
	CurrentTenant,
	IntegrationsForbiddenError,
	MapleInternalApi,
	VercelCostSourceAdded,
	VercelCostSourceRemoved,
	VercelCostStatus,
} from "@maple/domain/http"
import { Effect } from "effect"
import * as Policy from "@maple/domain/policy"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { VercelCostSourceService } from "@maple/backend/services/cost/VercelCostSourceService"

// A cost source is a connection like any other: the role that manages integrations manages it.
const requireIntegrationsManager = (roles: CurrentTenant.TenantSchema["roles"]) =>
	Policy.check(
		roles,
		"integrations:manage",
		(denial) => new IntegrationsForbiddenError({ message: denial.message }),
	)

export const HttpVercelCostLive = HttpApiBuilder.group(MapleInternalApi, "vercelCost", (handlers) =>
	Effect.gen(function* () {
		const sources = yield* VercelCostSourceService

		return handlers
			.handle("status", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const status = yield* sources.status(tenant.orgId)
					return new VercelCostStatus(status)
				}).pipe(Effect.withSpan("HttpVercelCost.status")),
			)
			.handle("add", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireIntegrationsManager(tenant.roles)
					const added = yield* sources.add(tenant.orgId, payload.teamId)
					// Adding what is a source already changed nothing, so it leaves no entry.
					if (added.created) {
						yield* recordHttpAudit("cost_source.added", {
							metadata: { provider: "vercel", account: added.team.slug },
						})
					}
					return new VercelCostSourceAdded({ team: added.team })
				}).pipe(Effect.withSpan("HttpVercelCost.add")),
			)
			.handle("remove", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireIntegrationsManager(tenant.roles)
					const removed = yield* sources.remove(tenant.orgId)
					// Removing what is not there changed nothing, so it leaves no entry.
					if (removed.removed) {
						yield* recordHttpAudit("cost_source.removed", { metadata: { provider: "vercel" } })
					}
					return new VercelCostSourceRemoved(removed)
				}).pipe(Effect.withSpan("HttpVercelCost.remove")),
			)
	}),
)
