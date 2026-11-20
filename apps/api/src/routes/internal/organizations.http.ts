import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { OrganizationDeletionService } from "@maple/backend/services/org/OrganizationDeletionService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"

export const HttpOrganizationsLive = HttpApiBuilder.group(MapleInternalApi, "organizations", (handlers) =>
	Effect.gen(function* () {
		const organizationDeletion = yield* OrganizationDeletionService

		return handlers.handle("delete", () =>
			Effect.gen(function* () {
				const deleted = yield* organizationDeletion.delete
				// Recorded after the fact so a refused delete cannot leave an entry
				// claiming the org is gone. The entry outlives the org: the audit
				// log is never cascaded, which is the point of a trail. It names the
				// integrations whose access could not be ended at the vendor.
				yield* recordHttpAudit("organization.deleted", {
					metadata: { incompleteTeardowns: deleted.incompleteTeardowns ?? [] },
				})
				return deleted
			}),
		)
	}),
)

export const HttpOrganizationCreationLive = HttpApiBuilder.group(
	MapleInternalApi,
	"organizationCreation",
	(handlers) =>
		Effect.gen(function* () {
			const organizationService = yield* OrganizationService

			return handlers.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const { userId } = yield* CurrentTenant.CurrentUser
					return yield* organizationService.create(userId, payload.name, payload.region)
				}),
			)
		}),
)

export const HttpOrganizationRegionLive = HttpApiBuilder.group(
	MapleInternalApi,
	"organizationRegion",
	(handlers) =>
		Effect.gen(function* () {
			const organizationService = yield* OrganizationService

			return handlers.handle("choose", ({ payload }) =>
				Effect.gen(function* () {
					const chosen = yield* organizationService.chooseRegion(payload.region)
					yield* recordHttpAudit("organization.region_chosen")
					return chosen
				}),
			)
		}),
)
