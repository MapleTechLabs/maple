import * as Policy from "@maple/domain/policy"
import { afterEach, describe, expect, it } from "@effect/vitest"
import {
	ApiSchemaErrors,
	ApiUnexpectedErrors,
	CurrentTenant,
	EnterpriseSsoApiGroup,
	EnterpriseSsoDocument,
	EnterpriseSsoUnavailableError,
	OrgId,
	RoleName,
	ScimTokenIssued,
	UserId,
} from "@maple/domain/http"
import { Array as Arr, Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { ApiErrorBoundaryLive } from "@maple/backend/http/error-boundary"
import { AuditLogService, type AuditLogRecordInput } from "@maple/backend/services/audit/AuditLogService"
import {
	EnterpriseSsoService,
	type EnterpriseSsoServiceApi,
} from "@maple/backend/services/org/enterprise-sso/EnterpriseSsoService"
import { HttpEnterpriseSsoLive } from "./enterprise-sso.http"

class SsoOnlyApi extends HttpApi.make("MapleInternalApi")
	.add(EnterpriseSsoApiGroup)
	.middleware(ApiSchemaErrors)
	.middleware(ApiUnexpectedErrors) {}

const ORG_ID = Schema.decodeSync(OrgId)("org_sso_route")
const USER_ID = Schema.decodeSync(UserId)("user_sso_route")
const SCIM_TOKEN = "scim_secret_value_shown_once"
const CLIENT_SECRET = "oidc-client-secret-value"

const document = new EnterpriseSsoDocument({
	ssoEntitled: true,
	scimEntitled: true,
	domains: [],
	connection: null,
	directory: null,
	roleMappings: [],
	groups: [],
	bypassUsers: [],
})

const handlers: Array<() => void> = []
afterEach(() => {
	for (const dispose of handlers.splice(0)) dispose()
})

/** Every service method answers the empty document and records its name. */
const recordingService = (calls: Array<string>) => {
	const ok = (name: string) => () => Effect.sync(() => (calls.push(name), document))
	const issued = (name: string) => () =>
		Effect.sync(() => (calls.push(name), new ScimTokenIssued({ document, token: SCIM_TOKEN })))
	const api: EnterpriseSsoServiceApi = {
		get: ok("get"),
		getSummary: ok("getSummary"),
		addDomain: ok("addDomain"),
		verifyDomain: ok("verifyDomain"),
		removeDomain: ok("removeDomain"),
		createConnection: ok("createConnection"),
		updateConnection: ok("updateConnection"),
		setEnforcement: ok("setEnforcement"),
		deleteConnection: ok("deleteConnection"),
		removeForDeletedOrganization: () => Effect.void,
		createDirectory: issued("createDirectory"),
		rotateDirectoryToken: issued("rotateDirectoryToken"),
		setDirectoryState: ok("setDirectoryState"),
		deleteDirectory: ok("deleteDirectory"),
		setRoleMappings: ok("setRoleMappings"),
		addBypassUser: ok("addBypassUser"),
		removeBypassUser: ok("removeBypassUser"),
		removeFormerMemberBypass: () => Effect.succeed("not_listed" as const),
		applyDirectoryGroup: () => Effect.fail(new EnterpriseSsoUnavailableError({ message: "unused" })),
		confirmDeprovisioned: () => Effect.succeed(true),
	}
	return Layer.succeed(EnterpriseSsoService, api)
}

const makeHarness = (role: string) => {
	const calls: Array<string> = []
	const audited: Array<Pick<AuditLogRecordInput, "action" | "metadata">> = []
	const audit = Layer.succeed(AuditLogService, {
		record: (input) =>
			Effect.sync(() => void audited.push({ action: input.action, metadata: input.metadata })),
		list: () => Effect.die("unused"),
	})
	const authorization = Layer.succeed(
		CurrentTenant.SessionAuthorization,
		CurrentTenant.SessionAuthorization.of({
			bearer: (httpEffect) =>
				CurrentTenant.provide(
					new CurrentTenant.TenantSchema({
						orgId: ORG_ID,
						userId: USER_ID,
						roles: [Schema.decodeSync(RoleName)(role)],
						permissions: Policy.grantsOf([Schema.decodeSync(RoleName)(role)]),
						authMode: "clerk",
					}),
				)(httpEffect),
		}),
	)
	const routes = HttpApiBuilder.layer(SsoOnlyApi).pipe(
		Layer.provide(HttpEnterpriseSsoLive),
		Layer.provide(ApiErrorBoundaryLive),
		Layer.provideMerge(authorization),
		Layer.provide(Layer.mergeAll(recordingService(calls), audit)),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	handlers.push(() => void dispose())

	const send = async (method: string, path: string, body?: unknown) => {
		const response = await handler(
			new Request(`http://maple.test/internal/enterprise-sso${path}`, {
				method,
				headers: { authorization: "Bearer test-token", "content-type": "application/json" },
				body: body === undefined ? null : JSON.stringify(body),
			}),
			Context.empty() as never,
		)
		return { status: response.status, text: await response.text() }
	}
	return { send, calls, audited }
}

describe("/internal/enterprise-sso", () => {
	it("gives a reader without the manage permission the summary, and a manager the full settings", async () => {
		for (const role of ["org:member", "org:analyst", "org:engineer"]) {
			const harness = makeHarness(role)
			expect((await harness.send("GET", "/")).status, role).toBe(200)
			expect(harness.calls, role).toEqual(["getSummary"])
		}
		const admin = makeHarness("org:admin")
		expect((await admin.send("GET", "/")).status).toBe(200)
		expect(admin.calls).toEqual(["get"])
	})

	it("lets a member read, but refuses every write before it reaches the service or the audit log", async () => {
		const harness = makeHarness("org:member")
		expect((await harness.send("GET", "/")).status).toBe(200)
		const writes = [
			["POST", "/domains", { domain: "acme.com" }],
			["PUT", "/connection/enforcement", { enforced: false }],
			["POST", "/directory"],
			["DELETE", "/directory"],
			["PUT", "/directory/role-mappings", { mappings: [] }],
		] as const
		for (const [method, path, body] of writes) {
			const response = await harness.send(method, path, body)
			expect(response.status, `${method} ${path}`).toBe(403)
		}
		expect(harness.calls).toEqual(["getSummary"])
		expect(harness.audited).toEqual([])
	})

	it("audits each admin write by action, and never with a secret in it", async () => {
		const harness = makeHarness("org:admin")
		expect((await harness.send("POST", "/domains", { domain: "acme.com" })).status).toBe(200)
		const connection = await harness.send("POST", "/connection", {
			name: "Acme",
			provider: "oidc_custom",
			domains: ["acme.com"],
			oidc: {
				discoveryUrl: "https://id.acme.com/.well-known/openid-configuration",
				clientId: "maple",
				clientSecret: CLIENT_SECRET,
			},
		})
		expect(connection.status).toBe(200)
		expect((await harness.send("PUT", "/connection/enforcement", { enforced: true })).status).toBe(200)
		const created = await harness.send("POST", "/directory")
		expect(created.status).toBe(200)
		// The token goes back to the admin exactly once, in this response.
		expect(created.text).toContain(SCIM_TOKEN)
		expect((await harness.send("POST", "/directory/token")).status).toBe(200)

		expect(Arr.map(harness.audited, (entry) => entry.action)).toEqual([
			"enterprise_sso.domain_added",
			"enterprise_sso.connection_created",
			"enterprise_sso.connection_enforced",
			"enterprise_sso.directory_created",
			"enterprise_sso.directory_key_rotated",
		])
		const trail = JSON.stringify(harness.audited)
		expect(trail).not.toContain(SCIM_TOKEN)
		expect(trail).not.toContain(CLIENT_SECRET)
		expect(harness.audited[0]?.metadata).toEqual({ domain: "acme.com" })
	})
})
