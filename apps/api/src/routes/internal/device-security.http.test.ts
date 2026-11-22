import { describe, expect, it } from "vitest"
import {
	ApiSchemaErrors,
	ApiUnexpectedErrors,
	CurrentTenant,
	DevicesResponse,
	DeviceSecurityApiGroup,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { ApiErrorBoundaryLive } from "@maple/backend/http/error-boundary"
import { DeviceSecurityService } from "@maple/backend/services/device-security/DeviceSecurityService"
import { HttpDeviceSecurityLive } from "./device-security.http"

class DeviceSecurityOnlyApi extends HttpApi.make("MapleInternalApi")
	.add(DeviceSecurityApiGroup)
	.middleware(ApiSchemaErrors)
	.middleware(ApiUnexpectedErrors) {}

const ORG_ID = Schema.decodeSync(OrgId)("org_device_route")
const USER_ID = Schema.decodeSync(UserId)("user_device_route")

const devicesAs = async (role: string) => {
	const asked: Array<string> = []
	const services = Layer.mergeAll(
		Layer.succeed(DeviceSecurityService, {
			devices: (orgId) =>
				Effect.sync(() => {
					asked.push(orgId)
					return new DevicesResponse({
						sources: [],
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
					CurrentTenant.provide(
						new CurrentTenant.TenantSchema({
							orgId: ORG_ID,
							userId: USER_ID,
							roles: [Schema.decodeSync(RoleName)(role)],
							permissions: Policy.grantsOf([role]),
							authMode: "clerk",
						}),
					)(httpEffect),
			}),
		),
	)
	const routes = HttpApiBuilder.layer(DeviceSecurityOnlyApi).pipe(
		Layer.provide(HttpDeviceSecurityLive),
		Layer.provide(ApiErrorBoundaryLive),
		Layer.provide(services),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const response = await handler(
		new Request("http://maple.test/internal/device-security/devices", {
			headers: { authorization: "Bearer test-token" },
		}),
		Context.empty(),
	)
	await dispose()
	return { status: response.status, asked }
}

describe("GET /internal/device-security/devices", () => {
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
