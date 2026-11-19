import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, IntegrationsForbiddenError, MapleInternalApi } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { FleetFindingsService } from "@maple/backend/services/integrations/FleetFindingsService"
import { Effect } from "effect"

// The Security hub's Devices page. Device names and what they fail are for those who hold
// `security:manage`, as every Security Center read.
export const HttpFleetSecurityLive = HttpApiBuilder.group(MapleInternalApi, "fleetSecurity", (handlers) =>
	Effect.gen(function* () {
		const findings = yield* FleetFindingsService
		return handlers.handle("devices", () =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				yield* Policy.check(
					tenant.roles,
					"security:manage",
					(denial) => new IntegrationsForbiddenError({ message: denial.message }),
				)
				return yield* findings.devices(tenant.orgId)
			}),
		)
	}),
)
