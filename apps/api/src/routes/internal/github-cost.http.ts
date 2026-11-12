import { HttpApiBuilder } from "effect/http-api"
import {
	CurrentTenant,
	GithubCostForbiddenError,
	GithubCostInstallations,
	GithubCostSourceAdded,
	GithubCostSourceRemoved,
	MapleInternalApi,
} from "@maple/domain/http"
import { Effect } from "effect"
import * as Policy from "@maple/domain/policy"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { GithubCostSourceService } from "@maple/backend/services/cost/GithubCostSourceService"

// A cost source is a connection like any other: the role that manages integrations manages it.
const requireIntegrationsManager = (roles: CurrentTenant.TenantSchema["roles"]) =>
	Policy.check(
		roles,
		"integrations:manage",
		(denial) => new GithubCostForbiddenError({ message: denial.message }),
	)

export const HttpGithubCostLive = HttpApiBuilder.group(MapleInternalApi, "githubCost", (handlers) =>
	Effect.gen(function* () {
		const sources = yield* GithubCostSourceService

		return handlers
			.handle("list", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const installations = yield* sources.list(tenant.orgId)
					return new GithubCostInstallations({ installations })
				}).pipe(Effect.withSpan("HttpGithubCost.list")),
			)
			.handle("add", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireIntegrationsManager(tenant.roles)
					const added = yield* sources.add(tenant.orgId, params.installationId)
					yield* recordHttpAudit("cost_source.created", {
						metadata: { provider: "github", account: added.accountLogin },
					})
					return new GithubCostSourceAdded(added)
				}).pipe(Effect.withSpan("HttpGithubCost.add")),
			)
			.handle("remove", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* requireIntegrationsManager(tenant.roles)
					const removed = yield* sources.remove(tenant.orgId, params.installationId)
					yield* recordHttpAudit("cost_source.deleted", {
						metadata: { provider: "github", installationId: params.installationId },
					})
					return new GithubCostSourceRemoved(removed)
				}).pipe(Effect.withSpan("HttpGithubCost.remove")),
			)
	}),
)
