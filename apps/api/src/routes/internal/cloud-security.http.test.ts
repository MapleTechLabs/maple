import * as Policy from "@maple/domain/policy"
import { describe, expect, it } from "vitest"
import {
	ApiSchemaErrors,
	ApiUnexpectedErrors,
	CloudSecurityApiGroup,
	CloudSecurityDisabledError,
	type CloudFindingsListRequest,
	CurrentTenant,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { ApiErrorBoundaryLive } from "@maple/backend/http/error-boundary"
import { CloudSecurityReadService } from "@maple/backend/services/cloud-security/CloudSecurityReadService"
import { HttpCloudSecurityLive } from "./cloud-security.http"

class CloudSecurityOnlyApi extends HttpApi.make("MapleInternalApi")
	.add(CloudSecurityApiGroup)
	.middleware(ApiSchemaErrors)
	.middleware(ApiUnexpectedErrors) {}

const ORG_ID = Schema.decodeSync(OrgId)("org_cloud_route")
const USER_ID = Schema.decodeSync(UserId)("user_cloud_route")
const asFailure = Schema.decodeUnknownSync(Schema.Struct({ _tag: Schema.String }))

const makeHarness = (enabled: boolean, role = "org:engineer") => {
	const asked: Array<CloudFindingsListRequest> = []
	const disabled = new CloudSecurityDisabledError({
		message: "Cloud security is not enabled for this organization.",
	})
	const services = Layer.mergeAll(
		Layer.succeed(CloudSecurityReadService, {
			overview: () => (enabled ? Effect.die("unused") : Effect.fail(disabled)),
			listFindings: (_tenant, request) =>
				enabled
					? Effect.sync(() => {
							asked.push(request)
							return { findings: [], nextOffset: null, telemetryMatched: true }
						})
					: Effect.fail(disabled),
			finding: () => Effect.die("unused"),
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
							permissions: Policy.grantsOf([Schema.decodeSync(RoleName)(role)]),
							authMode: "clerk",
						}),
					),
			}),
		),
	)
	const routes = HttpApiBuilder.layer(CloudSecurityOnlyApi).pipe(
		Layer.provide(HttpCloudSecurityLive),
		Layer.provide(ApiErrorBoundaryLive),
		Layer.provide(services),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const list = async (body: unknown) => {
		const response = await handler(
			new Request("http://maple.test/internal/cloud-security/findings", {
				method: "POST",
				headers: { authorization: "Bearer test-token", "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
			Context.empty(),
		)
		return { status: response.status, body: await response.json() }
	}
	return { list, asked, dispose }
}

describe("POST /internal/cloud-security/findings", () => {
	it("passes the filters through to the reads", async () => {
		const harness = makeHarness(true)
		const response = await harness.list({
			severities: ["critical", "high"],
			sources: ["guardduty"],
			region: "eu-west-1",
			search: "  ssh  ",
		})
		expect(response.status).toBe(200)
		expect(harness.asked).toEqual([
			{ severities: ["critical", "high"], sources: ["guardduty"], region: "eu-west-1", search: "ssh" },
		])
		await harness.dispose()
	})

	it("refuses an unknown severity, a bad region or an oversized page before any read", async () => {
		const harness = makeHarness(true)
		expect((await harness.list({ severities: ["urgent"] })).status).toBe(400)
		expect((await harness.list({ region: "moon-1" })).status).toBe(400)
		expect((await harness.list({ limit: 1000 })).status).toBe(400)
		expect(harness.asked).toEqual([])
		await harness.dispose()
	})

	it("answers 403 with the disabled error for an org outside the rollout", async () => {
		const harness = makeHarness(false)
		const response = await harness.list({})
		expect(response.status).toBe(403)
		expect(asFailure(response.body)._tag).toBe("@maple/http/errors/CloudSecurityDisabledError")
		await harness.dispose()
	})

	it("refuses members and analysts, as the rest of the Security Center does", async () => {
		await Effect.runPromise(
			Effect.forEach(["org:member", "org:analyst"], (role) =>
				Effect.promise(async () => {
					const harness = makeHarness(true, role)
					const response = await harness.list({})
					expect(response.status).toBe(403)
					expect(asFailure(response.body)._tag).toBe(
						"@maple/http/errors/CloudSecurityForbiddenError",
					)
					expect(harness.asked).toEqual([])
					await harness.dispose()
				}),
			),
		)
	})
})
