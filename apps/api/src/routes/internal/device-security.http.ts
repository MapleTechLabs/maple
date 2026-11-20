import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, IntegrationsForbiddenError, MapleInternalApi } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { DeviceSecurityService } from "@maple/backend/services/device-security/DeviceSecurityService"
import { Effect } from "effect"

// The Security hub's Devices page. Device names and what they fail are for those who hold
// `security:manage`, as every Security Center read.
export const HttpDeviceSecurityLive = HttpApiBuilder.group(MapleInternalApi, "deviceSecurity", (handlers) =>
	Effect.gen(function* () {
		const deviceSecurity = yield* DeviceSecurityService
		return handlers.handle("devices", () =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				yield* Policy.check(
					tenant.roles,
					"security:manage",
					(denial) => new IntegrationsForbiddenError({ message: denial.message }),
				)
				return yield* deviceSecurity.devices(tenant.orgId)
			}),
		)
	}),
)
