import * as Policy from "@maple/domain/policy"
import { afterEach, describe, expect, it } from "@effect/vitest"
import {
	ApiSchemaErrors,
	ApiUnexpectedErrors,
	CurrentTenant,
	CustomRoleResponse,
	OrgId,
	RoleName,
	RolesApiGroup,
	UserId,
} from "@maple/domain/http"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { ApiErrorBoundaryLive } from "@maple/backend/http/error-boundary"
import { AuditLogService, type AuditLogRecordInput } from "@maple/backend/services/audit/AuditLogService"
import { RolesService } from "@maple/backend/services/roles/RolesService"
import { HttpRolesLive } from "./roles.http"

class RolesOnlyApi extends HttpApi.make("MapleInternalApi")
	.add(RolesApiGroup)
	.middleware(ApiSchemaErrors)
	.middleware(ApiUnexpectedErrors) {}

const ORG_ID = Schema.decodeSync(OrgId)("org_roles_route")
const USER_ID = Schema.decodeSync(UserId)("user_roles_route")

const created = new CustomRoleResponse({
	id: Policy.CustomRoleId.make("role_oncall000000"),
	name: "On-call",
	description: "",
	permissions: ["telemetry:read"],
	memberCount: 0,
	createdAt: 1,
	updatedAt: 1,
})

const handlers: Array<() => void> = []
afterEach(() => {
	for (const dispose of handlers.splice(0)) dispose()
})

const makeHarness = (role: string) => {
	const creates: Array<string> = []
	const audited: Array<Pick<AuditLogRecordInput, "action" | "changes" | "metadata">> = []
	const unused = () => Effect.die("unused")
	const service = Layer.succeed(RolesService, {
		list: Effect.die("unused"),
		members: unused,
		create: (request) => Effect.sync(() => (creates.push(request.name), created)),
		update: (_roleId, request) =>
			Effect.succeed({
				before: created,
				role: new CustomRoleResponse({
					...created,
					name: request.name,
					description: request.description,
				}),
			}),
		delete: unused,
		setMemberRole: unused,
	})
	const audit = Layer.succeed(AuditLogService, {
		record: (input) =>
			Effect.sync(
				() =>
					void audited.push({
						action: input.action,
						metadata: input.metadata,
						...(input.changes !== undefined ? { changes: input.changes } : undefined),
					}),
			),
		list: () => Effect.die("unused"),
	})
	const roleName = Schema.decodeSync(RoleName)(role)
	const authorization = Layer.succeed(
		CurrentTenant.SessionAuthorization,
		CurrentTenant.SessionAuthorization.of({
			bearer: (httpEffect) =>
				CurrentTenant.provide(
					new CurrentTenant.TenantSchema({
						orgId: ORG_ID,
						userId: USER_ID,
						roles: [roleName],
						permissions: Policy.grantsOf([roleName]),
						authMode: "clerk",
					}),
				)(httpEffect),
		}),
	)
	const routes = HttpApiBuilder.layer(RolesOnlyApi).pipe(
		Layer.provide(HttpRolesLive),
		Layer.provide(ApiErrorBoundaryLive),
		Layer.provideMerge(authorization),
		Layer.provide(Layer.mergeAll(service, audit)),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	handlers.push(() => void dispose())

	const send = async (method: string, path: string, body: unknown) => {
		const response = await handler(
			new Request(`http://maple.test/internal/roles${path}`, {
				method,
				headers: { authorization: "Bearer test-token", "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
			Context.empty() as never,
		)
		return { status: response.status, body: await response.json() }
	}

	const createRole = () => send("POST", "", { name: "On-call", permissions: ["telemetry:read"] })

	return { send, createRole, creates, audited }
}

describe("/internal/roles", () => {
	it("refuses to create a role for a member without roles:manage, and changes nothing", async () => {
		const harness = makeHarness("org:engineer")
		const response = await harness.createRole()
		expect(response.status).toBe(403)
		expect(harness.creates).toEqual([])
		expect(harness.audited).toEqual([])
	})

	it("creates the role for an admin and audits it", async () => {
		const harness = makeHarness("org:admin")
		const response = await harness.createRole()
		expect(response.status).toBe(200)
		expect(response.body.id).toBe("role_oncall000000")
		expect(harness.audited).toEqual([
			{
				action: "role.created",
				metadata: { roleId: "role_oncall000000", name: "On-call", permissions: "telemetry:read" },
			},
		])
	})

	it("audits only the fields an update changed", async () => {
		const harness = makeHarness("org:admin")
		const response = await harness.send("PATCH", "/role_oncall000000", {
			name: "Responders",
			description: "",
			permissions: ["telemetry:read"],
			expectedUpdatedAt: 1,
		})
		expect(response.status).toBe(200)
		expect(harness.audited).toEqual([
			{
				action: "role.updated",
				changes: { fields: ["name"], before: { name: "On-call" }, after: { name: "Responders" } },
				metadata: { roleId: "role_oncall000000", name: "Responders", memberCount: 0 },
			},
		])
	})

	it("refuses an update that leaves a field out", async () => {
		const harness = makeHarness("org:admin")
		const response = await harness.send("PATCH", "/role_oncall000000", { name: "Responders" })
		expect(response.status).toBe(400)
		expect(harness.audited).toEqual([])
	})
})
