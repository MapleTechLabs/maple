import { describe, expect, it } from "vitest"
import {
	ApiSchemaErrors,
	ApiUnexpectedErrors,
	CurrentTenant,
	FleetDevicesResponse,
	FleetSecurityApiGroup,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { ApiErrorBoundaryLive } from "@maple/backend/http/error-boundary"
import { FleetFindingsService } from "@maple/backend/services/integrations/FleetFindingsService"
import { HttpFleetSecurityLive } from "./fleet-security.http"

class FleetSecurityOnlyApi extends HttpApi.make("MapleInternalApi")
	.add(FleetSecurityApiGroup)
	.middleware(ApiSchemaErrors)
	.middleware(ApiUnexpectedErrors) {}

const ORG_ID = Schema.decodeSync(OrgId)("org_fleet_route")
const USER_ID = Schema.decodeSync(UserId)("user_fleet_route")

const devicesAs = async (role: string) => {
	const asked: Array<string> = []
	const services = Layer.mergeAll(
		Layer.succeed(FleetFindingsService, {
			syncDue: Effect.die("unused"),
			devices: (orgId) =>
				Effect.sync(() => {
					asked.push(orgId)
					return new FleetDevicesResponse({
						connection: null,
						policies: [],
						vulnerabilities: [],
						moreVulnerabilities: 0,
					})
				}),
		}),
		Layer.succeed(
			CurrentTenant.SessionAuthorization,
			CurrentTenant.SessionAuthorization.of({
				bearer: (httpEffect) =>
					Effect.provideService(
						httpEffect,
						CurrentTenant.Context,
						new CurrentTenant.TenantSchema({
							orgId: ORG_ID,
							userId: USER_ID,
							roles: [Schema.decodeSync(RoleName)(role)],
							authMode: "clerk",
						}),
					),
			}),
		),
	)
	const routes = HttpApiBuilder.layer(FleetSecurityOnlyApi).pipe(
		Layer.provide(HttpFleetSecurityLive),
		Layer.provide(ApiErrorBoundaryLive),
		Layer.provide(services),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const response = await handler(
		new Request("http://maple.test/internal/fleet-security/devices", {
			headers: { authorization: "Bearer test-token" },
		}),
		Context.empty(),
	)
	await dispose()
	return { status: response.status, asked }
}

describe("GET /internal/fleet-security/devices", () => {
	it("reads the caller's own org for engineers and admins", async () => {
		for (const role of ["org:engineer", "org:admin"]) {
			const answer = await devicesAs(role)
			expect(answer).toEqual({ status: 200, asked: [ORG_ID] })
		}
	})

	it("refuses members and analysts before reading anything", async () => {
		for (const role of ["org:member", "org:analyst"]) {
			const answer = await devicesAs(role)
			expect(answer).toEqual({ status: 403, asked: [] })
		}
	})
})
