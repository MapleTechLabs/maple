import { assert, describe, it } from "@effect/vitest"
import { createClerkClient } from "@clerk/backend"
import { OrgId } from "@maple/domain/http"
import {
	Array as Arr,
	ConfigProvider,
	Duration,
	Effect,
	Layer,
	Option,
	Schedule,
	Schema,
	String as Str,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Hex from "effect/encoding/Hex"
import { Env } from "@maple/backend/platform/Env"
import { CONFORMANCE_IDP_CERTIFICATE } from "./__fixtures__/conformance-idp"
import { ClerkSsoGateway } from "./ClerkSsoGateway"

// SCIM 2.0 conformance against a real Clerk instance, through Maple's own gateway. Opt-in only:
// infisical run --env dev -- env SCIM_CONFORMANCE=1 bunx vitest run scim-conformance.live

const SECRET = process.env.CLERK_SECRET_KEY ?? ""
const ENABLED = process.env.SCIM_CONFORMANCE === "1" && Str.startsWith("sk_test_")(SECRET)

const config = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		PORT: "3472",
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		TINYBIRD_SIGNING_KEY: "unused-signing-key",
		TINYBIRD_WORKSPACE_ID: "unused-workspace",
		MAPLE_AUTH_MODE: "clerk",
		CLERK_SECRET_KEY: SECRET,
		CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY ?? "pk_test_unused",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		MAPLE_INGEST_PUBLIC_URL: "https://ingest.test",
	}),
)

const gatewayLayer = ClerkSsoGateway.layer.pipe(Layer.provide(Env.layer), Layer.provide(config))

const ScimResource = Schema.fromJsonString(Schema.Struct({ id: Schema.String }))
const ClerkUserFlags = Schema.fromJsonString(
	Schema.Struct({ deprovisioned: Schema.optionalKey(Schema.Boolean) }),
)

interface ScimResponse {
	readonly status: number
	readonly body: string
}

/** Clerk applies SCIM changes in the background; poll until `check` holds or give up. */
const eventually = <A, E>(label: string, read: Effect.Effect<A, E>, check: (a: A) => boolean) =>
	read.pipe(
		Effect.filterOrFail(check, () => new Error(`timed out waiting for ${label}`)),
		Effect.retry({ schedule: Schedule.spaced(Duration.seconds(2)), times: 30 }),
		Effect.orDie,
	)

describe.skipIf(!ENABLED)("SCIM conformance (live Clerk dev instance)", () => {
	it.live(
		"creates, patches and deactivates users, and maps group membership to a role",
		() =>
			Effect.gen(function* () {
				const clerk = createClerkClient({ secretKey: SECRET })
				const gateway = yield* ClerkSsoGateway
				const http = yield* HttpClient.HttpClient
				const suffix = Hex.encode(SecureRandom.randomBytesUnsafe(4))
				const domain = `scim-${suffix}.maple.dev`
				const report: Array<string> = []
				const step = (line: string) => Effect.sync(() => void report.push(line))

				const org = yield* Effect.promise(() =>
					clerk.organizations.createOrganization({ name: `SCIM conformance ${suffix}` }),
				)
				const orgId = Schema.decodeSync(OrgId)(org.id)
				const cleanup: Array<Effect.Effect<void>> = [
					Effect.promise(() => clerk.organizations.deleteOrganization(org.id)).pipe(Effect.asVoid),
				]
				const undoLater = (undo: Effect.Effect<unknown, unknown>) =>
					Effect.sync(() => void cleanup.unshift(undo.pipe(Effect.ignore)))

				yield* Effect.gen(function* () {
					const domainId = yield* gateway.ensureOrgDomain(orgId, domain)
					yield* gateway.verifyOrgDomainOwnership(orgId, domainId)
					yield* step(`domain ${domain}: ownership verified (manual override)`)

					const connection = yield* gateway.createConnection(orgId, "saml_custom", {
						name: "Conformance IdP",
						domains: [domain],
						saml: {
							ssoUrl: "https://idp.example.com/sso",
							entityId: "https://idp.example.com",
							certificate: CONFORMANCE_IDP_CERTIFICATE,
						},
					})
					yield* undoLater(gateway.deleteConnection(connection.id))
					assert.isFalse(connection.active)
					assert.isNotNull(connection.saml?.acsUrl ?? null)
					yield* step(
						`connection ${connection.id}: created inactive, ACS ${connection.saml?.acsUrl}`,
					)

					// Names are unique per provider type across the Clerk instance: a second org choosing the
					// same one still connects, under a name made unique by its own domain.
					const otherOrg = yield* Effect.promise(() =>
						clerk.organizations.createOrganization({ name: `SCIM conformance other ${suffix}` }),
					)
					yield* undoLater(
						Effect.promise(() => clerk.organizations.deleteOrganization(otherOrg.id)),
					)
					const otherDomain = `other-${suffix}.maple.dev`
					const otherOrgId = Schema.decodeSync(OrgId)(otherOrg.id)
					const otherDomainId = yield* gateway.ensureOrgDomain(otherOrgId, otherDomain)
					yield* gateway.verifyOrgDomainOwnership(otherOrgId, otherDomainId)
					const twin = yield* gateway.createConnection(otherOrgId, "saml_custom", {
						name: "Conformance IdP",
						domains: [otherDomain],
						saml: {
							ssoUrl: "https://idp.example.com/sso",
							entityId: "https://idp.example.com/other",
							certificate: CONFORMANCE_IDP_CERTIFICATE,
						},
					})
					yield* gateway.deleteConnection(twin.id)
					assert.strictEqual(twin.name, `Conformance IdP (${otherDomain})`)
					yield* step(`second org, same SAML name: created as "${twin.name}"`)

					// OIDC: the redirect URI the IdP must allow, which @clerk/backend's class drops.
					const oidc = yield* gateway.createConnection(otherOrgId, "oidc_custom", {
						name: `Conformance OIDC ${suffix}`,
						domains: [otherDomain],
						oidc: {
							discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
							clientId: "conformance",
							clientSecret: "conformance-secret",
						},
					})
					yield* undoLater(gateway.deleteConnection(oidc.id))
					const oidcRead = yield* gateway.getConnection(oidc.id)
					assert.match(oidcRead.oidc?.redirectUri ?? "", /\/v1\/oauth_callback$/)
					yield* step(`OIDC connection: redirect URI ${oidcRead.oidc?.redirectUri}`)

					const directory = yield* gateway.createDirectory(connection.id, "custom")
					yield* undoLater(gateway.deleteDirectory(directory.id))
					const firstKey = directory.api_key ?? ""
					assert.isAbove(firstKey.length, 10)
					const rotated = yield* gateway.rotateDirectoryKey(directory.id)
					const token = rotated.api_key ?? ""
					assert.notStrictEqual(token, firstKey)
					yield* step(`directory ${directory.id}: endpoint ${directory.endpoint_url}, key rotated`)

					const base = Str.replace(/\/$/, "")(directory.endpoint_url)
					const scim = (method: "GET" | "POST" | "PATCH", path: string, payload?: unknown) =>
						Effect.gen(function* () {
							const request = HttpClientRequest.make(method)(`${base}${path}`).pipe(
								HttpClientRequest.bearerToken(token),
								HttpClientRequest.setHeader("content-type", "application/scim+json"),
								HttpClientRequest.acceptJson,
							)
							const response = yield* http.execute(
								payload === undefined
									? request
									: HttpClientRequest.bodyJsonUnsafe(request, payload),
							)
							const body = yield* response.text
							return { status: response.status, body } satisfies ScimResponse
						}).pipe(Effect.orDie)
					const resourceId = (response: ScimResponse) =>
						Schema.decodeSync(ScimResource)(response.body).id

					const email = `ada@${domain}`
					const created = yield* scim("POST", "/Users", {
						schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
						userName: email,
						name: { givenName: "Ada", familyName: "Lovelace" },
						emails: [{ value: email, primary: true, type: "work" }],
						active: true,
					})
					assert.strictEqual(created.status, 201, created.body)
					const scimUserId = resourceId(created)
					yield* step(`POST /Users -> ${created.status}`)

					const fetched = yield* scim("GET", `/Users/${scimUserId}`)
					assert.strictEqual(fetched.status, 200)
					yield* step(`GET /Users/{id} -> ${fetched.status}`)

					const clerkUsers = yield* eventually(
						"the Clerk user",
						Effect.promise(() => clerk.users.getUserList({ emailAddress: [email] })),
						(page) => page.data.length === 1,
					)
					const userId = Option.getOrElse(
						Option.map(Arr.head(clerkUsers.data), (u) => u.id),
						() => "",
					)
					yield* undoLater(Effect.promise(() => clerk.users.deleteUser(userId)))
					const memberships = Effect.promise(() =>
						clerk.organizations.getOrganizationMembershipList({ organizationId: org.id }),
					).pipe(
						Effect.map((page) =>
							Option.map(
								Arr.findFirst(page.data, (m) => m.publicUserData?.userId === userId),
								(m) => m.role,
							),
						),
					)
					const joined = yield* eventually("the membership", memberships, Option.isSome)
					yield* step(
						`Clerk user ${userId} provisioned, member as ${Option.getOrElse(joined, () => "?")}`,
					)

					const patched = yield* scim("PATCH", `/Users/${scimUserId}`, {
						schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
						Operations: [{ op: "replace", path: "name.givenName", value: "Augusta" }],
					})
					assert.strictEqual(patched.status, 200, patched.body)
					yield* eventually(
						"the renamed user",
						Effect.promise(() => clerk.users.getUser(userId)),
						(u) => u.firstName === "Augusta",
					)
					yield* step(`PATCH /Users/{id} name -> ${patched.status}, Clerk firstName updated`)

					const group = yield* scim("POST", "/Groups", {
						schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
						displayName: "Maple Analysts",
						members: [{ value: scimUserId }],
					})
					assert.strictEqual(group.status, 201, group.body)
					const groupId = resourceId(group)
					yield* step(`POST /Groups with member -> ${group.status}`)

					const roles = yield* gateway.listRoles
					const analyst = Arr.findFirst(roles, (r) => r.key === "org:analyst")
					assert.isTrue(Option.isSome(analyst), "org:analyst must exist in this Clerk instance")
					const analystId = Option.getOrElse(
						Option.map(analyst, (r) => r.id),
						() => "",
					)
					// The same calls EnterpriseSsoService.setRoleMappings makes.
					yield* gateway.replaceRoleMappings(directory.id, [{ groupId, roleId: analystId }])
					yield* gateway.updateDirectory(directory.id, { group_role_mapping_enabled: true })
					const mappings = yield* gateway.listRoleMappings(directory.id)
					assert.deepStrictEqual(
						Arr.map(mappings, (m) => [m.groupId, m.roleKey]),
						[[groupId, "org:analyst"]],
					)
					// A saved mapping reaches existing members on the IdP's next group push, as Okta's
					// "Push now" or Entra's sync cycle does; Clerk does not apply it on save.
					const repush = yield* scim("PATCH", `/Groups/${groupId}`, {
						schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
						Operations: [{ op: "add", path: "members", value: [{ value: scimUserId }] }],
					})
					assert.strictEqual(repush.status, 200, repush.body)
					yield* eventually("the analyst role", memberships, (role) =>
						Option.contains(role, "org:analyst"),
					)
					yield* step("group mapped to org:analyst, member role is org:analyst after the next push")

					const deactivated = yield* scim("PATCH", `/Users/${scimUserId}`, {
						schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
						Operations: [{ op: "replace", value: { active: false } }],
					})
					assert.strictEqual(deactivated.status, 200, deactivated.body)
					yield* eventually("the removed membership", memberships, Option.isNone)
					// Maple's webhook keys its user sweep on this flag (user.updated, deprovisioned: true).
					const flags = yield* eventually(
						"the deprovisioned flag",
						http
							.execute(
								HttpClientRequest.get(`https://api.clerk.com/v1/users/${userId}`).pipe(
									HttpClientRequest.bearerToken(SECRET),
									HttpClientRequest.setHeader("Clerk-API-Version", "2026-05-12"),
								),
							)
							.pipe(
								Effect.flatMap((response) => response.text),
								Effect.map(Schema.decodeSync(ClerkUserFlags)),
							),
						(u) => u.deprovisioned === true,
					)
					assert.isTrue(flags.deprovisioned)
					yield* step(
						`PATCH active=false -> ${deactivated.status}, membership removed, user deprovisioned=true`,
					)

					yield* Effect.logInfo(
						`SCIM conformance report\n${Arr.join(
							Arr.map(report, (l) => `  - ${l}`),
							"\n",
						)}`,
					)
				}).pipe(Effect.ensuring(Effect.suspend(() => Effect.all(cleanup, { discard: true }))))
			}).pipe(Effect.provide([gatewayLayer, FetchHttpClient.layer])),
		180_000,
	)
})
